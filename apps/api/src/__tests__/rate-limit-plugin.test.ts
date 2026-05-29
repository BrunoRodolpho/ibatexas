// Unit tests for the rate-limit plugin registration (P2-SCALE-RATELIMIT).
// The limiter must be backed by the shared Redis connection so the limit is
// enforced cluster-wide (not per-replica in-memory), with a safe in-memory
// fallback when Redis is unavailable at boot.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerRateLimit } from "../plugins/rate-limit.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRateLimitPlugin = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
}));

vi.mock("@fastify/rate-limit", () => ({
  default: mockRateLimitPlugin,
}));

function buildFakeServer() {
  const warn = vi.fn();
  // register() captures the plugin options so we can inspect what was passed.
  const register = vi.fn().mockResolvedValue(undefined);
  return {
    server: {
      register,
      log: { warn },
    } as unknown as import("fastify").FastifyInstance,
    register,
    warn,
  };
}

describe("registerRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a redis store backed by the shared client when Redis is available", async () => {
    const mockRedis = { eval: vi.fn().mockResolvedValue([1, 60_000]) };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const { server, register, warn } = buildFakeServer();
    await registerRateLimit(server);

    expect(register).toHaveBeenCalledWith(
      mockRateLimitPlugin,
      expect.objectContaining({
        redis: expect.objectContaining({ rateLimit: expect.any(Function) }),
        skipOnError: true,
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("the redis shim drives the shared client's eval and returns {current, ttl}", async () => {
    const mockRedis = { eval: vi.fn().mockResolvedValue([3, 42_000]) };
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const { server, register } = buildFakeServer();
    await registerRateLimit(server);

    const opts = register.mock.calls[0][1] as {
      redis: {
        rateLimit: (
          key: string,
          tw: number,
          max: number,
          cont: boolean,
          exp: boolean,
          cb: (err: Error | null, r?: { current: number; ttl: number }) => void,
        ) => void;
      };
    };

    const result = await new Promise((resolve, reject) => {
      opts.redis.rateLimit("1.2.3.4", 60_000, 30, false, false, (err, r) =>
        err ? reject(err) : resolve(r),
      );
    });

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("INCR"),
      expect.objectContaining({
        keys: ["1.2.3.4"],
        arguments: ["60000", "30", "false"],
      }),
    );
    expect(result).toEqual({ current: 3, ttl: 42_000 });
  });

  it("falls back to in-memory store (redis undefined) and warns when Redis is unavailable", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("REDIS_URL env var required"));

    const { server, register, warn } = buildFakeServer();
    await registerRateLimit(server);

    expect(register).toHaveBeenCalledWith(
      mockRateLimitPlugin,
      expect.objectContaining({ redis: undefined }),
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("uses RATE_LIMIT_MAX env override for max", async () => {
    const mockRedis = { eval: vi.fn() };
    mockGetRedisClient.mockResolvedValue(mockRedis);
    const prev = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = "7";

    const { server, register } = buildFakeServer();
    await registerRateLimit(server);

    expect(register).toHaveBeenCalledWith(
      mockRateLimitPlugin,
      expect.objectContaining({ max: 7 }),
    );

    if (prev === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = prev;
  });
});
