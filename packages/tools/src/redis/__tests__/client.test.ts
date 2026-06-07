// Tests for the shared Redis client construction (P2-NET-REDISTIMEOUT).
//
// Verifies the client is created with a bounded connect timeout and reconnect
// strategy so a Redis stall fails fast instead of hanging callers:
//   • socket.connectTimeout is a finite number (default 5000, env override).
//   • socket.reconnectStrategy is bounded: caps the delay and returns an Error
//     once max attempts is exceeded.
//
// Pure unit test — `redis` is mocked, no network. Modules are reset per test so the
// module-level connection singleton in client.ts does not leak between cases.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreateClient = vi.hoisted(() => vi.fn());

vi.mock("redis", () => ({
  createClient: mockCreateClient,
}));

function makeFakeClient() {
  return {
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    isOpen: true,
  };
}

type CreateClientConfig = {
  url: string;
  socket: {
    connectTimeout: number;
    reconnectStrategy: (retries: number) => number | Error;
  };
};

describe("getRedisClient — connect timeout + bounded reconnect", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv, REDIS_URL: "redis://localhost:6379" };
    mockCreateClient.mockImplementation(() => makeFakeClient());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function construct(): Promise<CreateClientConfig> {
    const { getRedisClient } = await import("../client.js");
    await getRedisClient();
    return mockCreateClient.mock.calls[0][0] as CreateClientConfig;
  }

  it("passes a finite connectTimeout (default 5000)", async () => {
    const cfg = await construct();
    expect(cfg.socket.connectTimeout).toBe(5_000);
    expect(Number.isFinite(cfg.socket.connectTimeout)).toBe(true);
  });

  it("honors REDIS_CONNECT_TIMEOUT_MS override", async () => {
    process.env.REDIS_CONNECT_TIMEOUT_MS = "1500";
    const cfg = await construct();
    expect(cfg.socket.connectTimeout).toBe(1500);
  });

  it("reconnectStrategy caps the delay and is non-negative", async () => {
    const cfg = await construct();
    const strategy = cfg.socket.reconnectStrategy;

    // Early attempts grow but stay capped at the default 3000ms.
    const early = strategy(0);
    expect(typeof early).toBe("number");
    expect(early as number).toBeGreaterThanOrEqual(0);

    const late = strategy(8);
    expect(late as number).toBeLessThanOrEqual(3_000);
  });

  it("reconnectStrategy gives up (returns Error) after max attempts", async () => {
    const cfg = await construct();
    const strategy = cfg.socket.reconnectStrategy;

    // Default cap is 10 attempts.
    expect(strategy(10)).toBeInstanceOf(Error);
    expect(strategy(50)).toBeInstanceOf(Error);
  });

  it("honors REDIS_MAX_RECONNECT_ATTEMPTS override", async () => {
    process.env.REDIS_MAX_RECONNECT_ATTEMPTS = "2";
    const cfg = await construct();
    const strategy = cfg.socket.reconnectStrategy;

    expect(typeof strategy(1)).toBe("number");
    expect(strategy(2)).toBeInstanceOf(Error);
  });
});
