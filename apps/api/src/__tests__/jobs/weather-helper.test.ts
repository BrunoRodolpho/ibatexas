// Tests for fetchWeatherCondition — weather API fetch + Redis caching.
// Mocks fetch and Sentry. Redis is the canonical in-memory adapter, INJECTED
// through the module's own seam.
//
// ── R5 rollout, family 2 — what the migration killed here ───────────────────
//
// The retired double was two constant `vi.fn()`s (`get → null`, `set → "OK"`)
// plus a FAKED `rk` returning `test:${k}`. Three fictions rode on that:
//
//   1. The wrong prefix. The real `rk()` under apps/api's vitest resolves to
//      `development:` (no APP_ENV is pinned in `apps/api/vitest.config.ts` or
//      `src/__tests__/setup.ts`), so the TTL case asserted a write to
//      `test:weather:current` — a key production has never written.
//   2. The synthetic cache hit. "uses cached result on second call" fed the
//      cache-hit value in through `get.mockResolvedValueOnce(...)`, so it never
//      established that the module's own WRITE is what a later READ finds. The
//      writer and the reader were never connected; a module that wrote the wrong
//      key, or nothing at all, passed.
//   3. Expiry was unobservable. "calls API again when cache is expired" pinned
//      `get` to `null` forever, so nothing about a TTL was exercised — the case
//      would pass with the cache TTL removed entirely. It now advances an
//      injected clock across the real 1h boundary.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";
import { rk } from "@ibatexas/tools";
import { fetchWeatherCondition } from "../../jobs/weather-helper.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockSentryCapture = vi.hoisted(() => vi.fn());

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Only the CLIENT resolver is replaced, and it is a TRIPWIRE: every case here
// injects, so a resolution means the seam stopped working. `rk` runs REAL
// (Hard Rule #7) — it is pure, and letting it run is the point.
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return { ...actual, getRedisClient: mockGetRedisClient };
});

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) => {
    cb({ setTag: vi.fn() });
  }),
  captureException: mockSentryCapture,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const CACHE_KEY = (): string => rk("weather:current");
const CACHE_TTL_MS = 3_600_000; // the module's WEATHER_CACHE_TTL, in ms

function mockFetchResponse(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: vi.fn().mockResolvedValue(body),
  });
}

function inSaoPaulo(): void {
  vi.stubEnv("RESTAURANT_LAT", "-23.550520");
  vi.stubEnv("RESTAURANT_LNG", "-46.633308");
}

describe("fetchWeatherCondition", () => {
  let redis: InMemoryRedis;
  let clock: number;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    clock = 1_700_000_000_000;
    redis = createInMemoryRedis({ now: () => clock });
    // The tripwire: nothing in this file may resolve the singleton.
    mockGetRedisClient.mockRejectedValue(
      new Error("getRedisClient() resolved — the weather-helper seam is unwired"),
    );
  });

  /** Every call goes through the seam. */
  const run = () => fetchWeatherCondition({ redis: redis.client });

  // ── Missing env vars ─────────────────────────────────────────────────────

  it("returns 'normal' when RESTAURANT_LAT is not set", async () => {
    vi.stubEnv("RESTAURANT_LAT", "");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");

    expect(await run()).toBe("normal");
    // The env guard short-circuits BEFORE any client is touched.
    expect(redis.calls).toHaveLength(0);
  });

  it("returns 'normal' when RESTAURANT_LNG is not set", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "");

    expect(await run()).toBe("normal");
    expect(redis.calls).toHaveLength(0);
  });

  // ── API response parsing ─────────────────────────────────────────────────

  it("returns 'rain' when API reports rain > 0", async () => {
    inSaoPaulo();
    vi.stubGlobal("fetch", mockFetchResponse({ current: { rain: 2.5, temperature_2m: 22 } }));

    expect(await run()).toBe("rain");
  });

  it("returns 'hot' when API reports temperature > 32", async () => {
    inSaoPaulo();
    vi.stubGlobal("fetch", mockFetchResponse({ current: { rain: 0, temperature_2m: 33 } }));

    expect(await run()).toBe("hot");
  });

  it("returns 'normal' when rain=0 and temperature <= 32", async () => {
    inSaoPaulo();
    vi.stubGlobal("fetch", mockFetchResponse({ current: { rain: 0, temperature_2m: 25 } }));

    expect(await run()).toBe("normal");
  });

  it("rain takes priority over hot temperature", async () => {
    inSaoPaulo();
    vi.stubGlobal("fetch", mockFetchResponse({ current: { rain: 1, temperature_2m: 35 } }));

    expect(await run()).toBe("rain");
  });

  // ── Graceful degradation ─────────────────────────────────────────────────

  it("returns 'normal' on fetch timeout/error", async () => {
    inSaoPaulo();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError")),
    );

    expect(await run()).toBe("normal");
    // The degrade writes NOTHING — a later call must retry the API rather than
    // serve a cached "normal" it never actually observed.
    expect(redis.keys()).toEqual([]);
  });

  it("reports error to Sentry on fetch failure", async () => {
    inSaoPaulo();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    await run();

    expect(mockSentryCapture).toHaveBeenCalled();
  });

  it("returns 'normal' when API responds with non-ok status", async () => {
    inSaoPaulo();
    vi.stubGlobal("fetch", mockFetchResponse({}, false));

    expect(await run()).toBe("normal");
    expect(redis.keys()).toEqual([]);
  });

  // ── Redis caching ─────────────────────────────────────────────────────────

  it("uses cached result on second call — no second API call", async () => {
    inSaoPaulo();
    const fetchSpy = mockFetchResponse({ current: { rain: 2, temperature_2m: 20 } });
    vi.stubGlobal("fetch", fetchSpy);

    // First call MISSES an empty keyspace and writes what it fetched.
    expect(await run()).toBe("rain");
    // Second call reads THAT write — not a value this test planted.
    expect(await run()).toBe("rain");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("caches result under the REAL rk() key, with a 1-hour TTL", async () => {
    inSaoPaulo();
    vi.stubGlobal("fetch", mockFetchResponse({ current: { rain: 0, temperature_2m: 20 } }));

    await run();

    // `development:weather:current` — the key production writes. The retired
    // double asserted `test:weather:current`, which nothing ever writes.
    expect(redis.keys()).toEqual([CACHE_KEY()]);
    expect(JSON.parse(redis.peek(CACHE_KEY())!)).toMatchObject({ condition: "normal" });
    // An exact remaining lifetime against the injected clock, not an echo of
    // the EX argument the module passed in.
    expect(redis.ttlMs(CACHE_KEY())).toBe(CACHE_TTL_MS);
  });

  it("calls the API again once the cached entry's TTL has really lapsed", async () => {
    inSaoPaulo();
    const fetchSpy = mockFetchResponse({ current: { rain: 2, temperature_2m: 20 } });
    vi.stubGlobal("fetch", fetchSpy);

    await run();
    // One millisecond short of the hour: still cached.
    clock += CACHE_TTL_MS - 1;
    await run();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Across the boundary: the entry is gone and the API is consulted again.
    clock += 1;
    await run();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when the cached JSON is corrupt, and overwrites it", async () => {
    inSaoPaulo();
    await redis.client.set(CACHE_KEY(), "{not json");
    vi.stubGlobal("fetch", mockFetchResponse({ current: { rain: 0, temperature_2m: 35 } }));

    // The module's documented "cache corrupted — fall through to API call"
    // branch: previously unobservable, because the double's `get` could not be
    // made to answer a value AND have the module's repair land anywhere.
    expect(await run()).toBe("hot");
    expect(JSON.parse(redis.peek(CACHE_KEY())!)).toMatchObject({ condition: "hot" });
  });
});
