// Weather condition helper for proactive outreach.
// Uses Open-Meteo API (free, no API key required).
// Caches result in Redis for 1 hour to avoid excessive API calls.
// Gracefully degrades to "normal" on any error.

import { getRedisClient, rk } from "@ibatexas/tools";
import * as Sentry from "@sentry/node";

type WeatherCondition = "rain" | "hot" | "normal";

interface WeatherCache {
  condition: WeatherCondition;
  fetchedAt: string;
}

interface OpenMeteoResponse {
  current: {
    rain: number;
    temperature_2m: number;
  };
}

const WEATHER_CACHE_TTL = 3600; // 1 hour

// ── The Redis client seam (R5 rollout, jobs/subscribers family) ──────────────
//
// Deps-bag shape, following the in-repo class-(d) precedent
// (`jobs/escalation-park-expiry-sweeper.ts`'s NAMED `SweeperRedis`, the stronger
// of the two forms — a named type is greppable and documents its own surface,
// where an inline `readonly redis?: {...}` cannot be referred to by a caller).
//
// FAIL-CLOSED PICK ANALYSIS (R5-S12's rule):
//   • commands ISSUED here: `get`, `set`.
//   • commands consumed DOWNSTREAM: none — this module hands the client to
//     nothing. Its only other awaits are `fetch` and Sentry.
//   • feature detection: none (`typeof client.X === "function"` appears nowhere
//     in this module's graph — measured, not assumed).
// So {issued} ∪ {downstream} = {get, set}, and the Pick below is complete.
//
// The swallow to know about: the whole API-fetch block, INCLUDING the cache
// `set`, sits inside one `try/catch` that returns "normal". A client that cannot
// serve `set` therefore degrades to an un-cached "normal" forecast rather than
// throwing — so this seam's tests must assert the WRITE, not just the verdict.
// The cache `get`, by contrast, is outside that catch and throws to the caller.

/** The node-redis v4 surface this cache reads and writes. */
export type WeatherCacheRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "get" | "set"
>;

export interface FetchWeatherConditionDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: WeatherCacheRedis;
}

export async function fetchWeatherCondition(
  deps: FetchWeatherConditionDeps = {},
): Promise<WeatherCondition> {
  const lat = process.env.RESTAURANT_LAT;
  const lng = process.env.RESTAURANT_LNG;

  if (!lat || !lng) {
    return "normal";
  }

  const redis: WeatherCacheRedis = deps.redis ?? (await getRedisClient());
  const cacheKey = rk("weather:current");

  // Check cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as WeatherCache;
      return parsed.condition;
    } catch {
      // Cache corrupted — fall through to API call
    }
  }

  // Fetch from Open-Meteo
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,rain`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!response.ok) {
      return "normal";
    }

    const data = (await response.json()) as OpenMeteoResponse;
    const rain = data.current?.rain ?? 0;
    const temp = data.current?.temperature_2m ?? 0;

    let condition: WeatherCondition;
    if (rain > 0) {
      condition = "rain";
    } else if (temp > 32) {
      condition = "hot";
    } else {
      condition = "normal";
    }

    // Store in cache
    const cacheValue: WeatherCache = { condition, fetchedAt: new Date().toISOString() };
    await redis.set(cacheKey, JSON.stringify(cacheValue), { EX: WEATHER_CACHE_TTL });

    return condition;
  } catch (err) {
    Sentry.withScope((scope) => {
      scope.setTag("job", "proactive-engagement");
      scope.setTag("source", "weather-helper");
      Sentry.captureException(err);
    });
    return "normal";
  }
}
