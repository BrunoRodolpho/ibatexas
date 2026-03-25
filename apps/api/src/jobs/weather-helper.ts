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

export async function fetchWeatherCondition(): Promise<WeatherCondition> {
  const lat = process.env.RESTAURANT_LAT;
  const lng = process.env.RESTAURANT_LNG;

  if (!lat || !lng) {
    return "normal";
  }

  const redis = await getRedisClient();
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
