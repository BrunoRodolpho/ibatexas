// Tests for fetchWeatherCondition — weather API fetch + Redis caching.
// Mocks fetch, Redis, and Sentry.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchWeatherCondition } from "../../jobs/weather-helper.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `test:${k}`));
const mockSentryCapture = vi.hoisted(() => vi.fn());

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) => {
    cb({ setTag: vi.fn() });
  }),
  captureException: mockSentryCapture,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    ...overrides,
  };
}

function mockFetchResponse(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: vi.fn().mockResolvedValue(body),
  });
}

describe("fetchWeatherCondition", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
  });

  // ── Missing env vars ─────────────────────────────────────────────────────

  it("returns 'normal' when RESTAURANT_LAT is not set", async () => {
    vi.stubEnv("RESTAURANT_LAT", "");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");

    const result = await fetchWeatherCondition();

    expect(result).toBe("normal");
  });

  it("returns 'normal' when RESTAURANT_LNG is not set", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "");

    const result = await fetchWeatherCondition();

    expect(result).toBe("normal");
  });

  // ── API response parsing ─────────────────────────────────────────────────

  it("returns 'rain' when API reports rain > 0", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    vi.stubGlobal("fetch", mockFetchResponse({
      current: { rain: 2.5, temperature_2m: 22 },
    }));

    const result = await fetchWeatherCondition();

    expect(result).toBe("rain");
  });

  it("returns 'hot' when API reports temperature > 32", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    vi.stubGlobal("fetch", mockFetchResponse({
      current: { rain: 0, temperature_2m: 33 },
    }));

    const result = await fetchWeatherCondition();

    expect(result).toBe("hot");
  });

  it("returns 'normal' when rain=0 and temperature <= 32", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    vi.stubGlobal("fetch", mockFetchResponse({
      current: { rain: 0, temperature_2m: 25 },
    }));

    const result = await fetchWeatherCondition();

    expect(result).toBe("normal");
  });

  it("rain takes priority over hot temperature", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    vi.stubGlobal("fetch", mockFetchResponse({
      current: { rain: 1, temperature_2m: 35 },
    }));

    const result = await fetchWeatherCondition();

    expect(result).toBe("rain");
  });

  // ── Graceful degradation ─────────────────────────────────────────────────

  it("returns 'normal' on fetch timeout/error", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError")));

    const result = await fetchWeatherCondition();

    expect(result).toBe("normal");
  });

  it("reports error to Sentry on fetch failure", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    await fetchWeatherCondition();

    expect(mockSentryCapture).toHaveBeenCalled();
  });

  it("returns 'normal' when API responds with non-ok status", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    vi.stubGlobal("fetch", mockFetchResponse({}, false));

    const result = await fetchWeatherCondition();

    expect(result).toBe("normal");
  });

  // ── Redis caching ─────────────────────────────────────────────────────────

  it("uses cached result on second call — no second API call", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    const mockFetch = mockFetchResponse({ current: { rain: 0, temperature_2m: 20 } });
    vi.stubGlobal("fetch", mockFetch);

    // First call — cache miss, calls API
    mockRedis.get.mockResolvedValueOnce(null);
    await fetchWeatherCondition();

    // Second call — cache hit
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ condition: "normal", fetchedAt: new Date().toISOString() }),
    );
    const result = await fetchWeatherCondition();

    expect(result).toBe("normal");
    // fetch only called once (for cache miss)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("caches result with 1-hour TTL after successful API call", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    vi.stubGlobal("fetch", mockFetchResponse({ current: { rain: 0, temperature_2m: 20 } }));

    await fetchWeatherCondition();

    expect(mockRedis.set).toHaveBeenCalledWith(
      "test:weather:current",
      expect.stringContaining('"condition":"normal"'),
      { EX: 3600 },
    );
  });

  it("calls API again when cache is expired (cache miss)", async () => {
    vi.stubEnv("RESTAURANT_LAT", "-23.550520");
    vi.stubEnv("RESTAURANT_LNG", "-46.633308");
    const mockFetch = mockFetchResponse({ current: { rain: 2, temperature_2m: 20 } });
    vi.stubGlobal("fetch", mockFetch);

    // Simulate cache miss (expired)
    mockRedis.get.mockResolvedValue(null);

    await fetchWeatherCondition();
    await fetchWeatherCondition();

    // fetch called twice since cache always misses
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
