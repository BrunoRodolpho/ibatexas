// Tests for the shared Redis client construction + reconnect resilience.
//
// Two concerns are pinned here:
//   1. (P2-NET-REDISTIMEOUT) The client is created with a bounded connect timeout
//      and a bounded, capped, exponential reconnect strategy so a Redis stall
//      fails fast instead of hanging callers.
//   2. (FE-D20) A failed connect attempt must NOT wedge the singleton: after the
//      connect rejects (Redis unreachable) the next getRedisClient() must start a
//      FRESH attempt and, once Redis is back, restore service — without a process
//      restart. While disconnected, callers keep failing closed (the call rejects).
//
// Pure unit test — `redis` is mocked, no network. Modules are reset per test so the
// module-level connection singleton in client.ts does not leak between cases.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreateClient = vi.hoisted(() => vi.fn());

vi.mock("redis", () => ({
  createClient: mockCreateClient,
}));

type Handlers = Record<string, (arg?: unknown) => void>;

interface FakeClient {
  on: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  isOpen: boolean;
  __handlers: Handlers;
  __emit: (event: string, arg?: unknown) => void;
}

function makeFakeClient(
  connectImpl: () => Promise<void> = () => Promise.resolve(),
): FakeClient {
  const handlers: Handlers = {};
  const client: FakeClient = {
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb;
      return client;
    }),
    connect: vi.fn(connectImpl),
    quit: vi.fn().mockResolvedValue(undefined),
    isOpen: true,
    __handlers: handlers,
    __emit: (event: string, arg?: unknown) => handlers[event]?.(arg),
  };
  return client;
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

  it("reconnectStrategy grows exponentially before the cap", async () => {
    const cfg = await construct();
    const strategy = cfg.socket.reconnectStrategy;
    // base=100 default: attempt 0 -> ~100, attempt 3 -> ~800; strictly increasing
    // in the pre-cap region (jitter < base so ordering holds across a full base gap).
    const a0 = strategy(0) as number;
    const a3 = strategy(3) as number;
    expect(a3).toBeGreaterThan(a0);
    expect(a3).toBeLessThanOrEqual(3_000);
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

  it("logs a structured, ops-visible signal on each reconnect attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = await construct();
    cfg.socket.reconnectStrategy(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[Redis] connection lost"),
    );
    warn.mockRestore();
  });
});

describe("getRedisClient — drop/reconnect resilience (FE-D20)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv, REDIS_URL: "redis://localhost:6379" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("reuses the same client while it is open (single connection)", async () => {
    const client = makeFakeClient();
    mockCreateClient.mockImplementation(() => client);
    const { getRedisClient } = await import("../client.js");

    const a = await getRedisClient();
    const b = await getRedisClient();
    expect(a).toBe(b);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("does NOT wedge after a failed connect — the next call retries and recovers", async () => {
    // First client: connect rejects (Redis unreachable). Second client: connects.
    const failing = makeFakeClient(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    const healthy = makeFakeClient();
    mockCreateClient
      .mockImplementationOnce(() => failing)
      .mockImplementationOnce(() => healthy);

    const { getRedisClient } = await import("../client.js");

    // Disconnected: the call rejects and the caller fails closed exactly as today.
    await expect(getRedisClient()).rejects.toThrow("ECONNREFUSED");

    // Regression: the singleton must NOT be stuck on the rejected in-flight promise.
    // A subsequent call starts a fresh attempt and restores service (no restart).
    const recovered = await getRedisClient();
    expect(recovered).toBe(healthy);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("a repeated outage keeps failing closed, then heals when Redis returns", async () => {
    const fail1 = makeFakeClient(() => Promise.reject(new Error("down-1")));
    const fail2 = makeFakeClient(() => Promise.reject(new Error("down-2")));
    const healthy = makeFakeClient();
    mockCreateClient
      .mockImplementationOnce(() => fail1)
      .mockImplementationOnce(() => fail2)
      .mockImplementationOnce(() => healthy);

    const { getRedisClient } = await import("../client.js");

    await expect(getRedisClient()).rejects.toThrow("down-1");
    await expect(getRedisClient()).rejects.toThrow("down-2");
    await expect(getRedisClient()).resolves.toBe(healthy);
    expect(mockCreateClient).toHaveBeenCalledTimes(3);
  });

  it("concurrent calls during connect share one in-flight attempt (no dogpile)", async () => {
    let resolveConnect: () => void = () => {};
    const client = makeFakeClient(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    mockCreateClient.mockImplementation(() => client);

    const { getRedisClient } = await import("../client.js");

    const p1 = getRedisClient();
    const p2 = getRedisClient();
    resolveConnect();
    const [c1, c2] = await Promise.all([p1, p2]);

    expect(c1).toBe(client);
    expect(c2).toBe(client);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("drops the singleton on 'end' so the next call rebuilds a fresh connection", async () => {
    const first = makeFakeClient();
    const second = makeFakeClient();
    mockCreateClient
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    const { getRedisClient } = await import("../client.js");

    const a = await getRedisClient();
    expect(a).toBe(first);

    // Permanent disconnect: node-redis emits 'end'. The singleton must be released.
    first.isOpen = false;
    first.__emit("end");

    const b = await getRedisClient();
    expect(b).toBe(second);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("a late 'end' from a superseded client does not clobber the fresh singleton", async () => {
    const first = makeFakeClient();
    const second = makeFakeClient();
    mockCreateClient
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    const { getRedisClient } = await import("../client.js");

    await getRedisClient();
    first.isOpen = false;
    first.__emit("end"); // releases singleton
    const b = await getRedisClient(); // rebuilds -> second (isOpen true)
    expect(b).toBe(second);

    // The OLD client fires 'end' late — must not null out the current singleton.
    first.__emit("end");
    const c = await getRedisClient();
    expect(c).toBe(second);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("rejects (fails closed) when REDIS_URL is missing, and recovers once set", async () => {
    delete process.env.REDIS_URL;
    const healthy = makeFakeClient();
    mockCreateClient.mockImplementation(() => healthy);

    const { getRedisClient } = await import("../client.js");
    await expect(getRedisClient()).rejects.toThrow("REDIS_URL");

    // Not wedged: once the env is present a later call connects.
    process.env.REDIS_URL = "redis://localhost:6379";
    await expect(getRedisClient()).resolves.toBe(healthy);
  });
});
