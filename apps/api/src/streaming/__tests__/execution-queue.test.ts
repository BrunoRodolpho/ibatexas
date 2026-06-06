// Unit tests for the per-session web-chat execution lock.
//
// P3-MEM-HEARTBEAT: re-acquiring the lock for the same session without an
// intervening release must clear the prior heartbeat interval instead of
// overwriting the Map entry and leaking it. The NX-lock semantics (UUID lock
// value + ownership-checked Lua release/extend) are unchanged.
//
// Mocks: @ibatexas/tools (getRedisClient, rk). Uses fake timers to drive the
// 10s heartbeat and assert it fires exactly once per tick.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRedis = {
  set: vi.fn(),
  eval: vi.fn(),
  del: vi.fn(),
};

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => mockRedis),
  rk: vi.fn((key: string) => `ibatexas:${key}`),
}));

import { acquireWebAgentLock, releaseWebAgentLock } from "../execution-queue.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("acquireWebAgentLock", () => {
  it("acquires the lock (SET NX) and returns true", async () => {
    mockRedis.set.mockResolvedValue("OK");

    const ok = await acquireWebAgentLock("sess-1");

    expect(ok).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("web:agent:sess-1"),
      expect.any(String),
      { NX: true, EX: 30 },
    );
  });

  it("returns false when the lock is already held (SET NX fails)", async () => {
    mockRedis.set.mockResolvedValue(null);

    expect(await acquireWebAgentLock("sess-1")).toBe(false);

    // Clean up so the held lock doesn't leak a heartbeat into later tests.
    await releaseWebAgentLock("sess-1");
  });

  it("starts a heartbeat that extends the TTL via the Lua eval script", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    await acquireWebAgentLock("sess-hb");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockRedis.eval).toHaveBeenCalled();
    await releaseWebAgentLock("sess-hb");
  });

  // P3-MEM-HEARTBEAT regression: re-acquire without release must not leak the
  // prior interval. A leaked interval would fire the heartbeat TWICE per tick.
  it("clears a prior heartbeat when re-acquiring the same session (no leak)", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    await acquireWebAgentLock("sess-leak"); // heartbeat #1
    await acquireWebAgentLock("sess-leak"); // re-acquire WITHOUT release — heartbeat #2

    mockRedis.eval.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    await releaseWebAgentLock("sess-leak");
  });
});

describe("releaseWebAgentLock", () => {
  it("clears the heartbeat and releases the lock via the Lua eval script", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    await acquireWebAgentLock("sess-rel");
    await releaseWebAgentLock("sess-rel");

    expect(mockRedis.eval).toHaveBeenCalled();

    // After release the heartbeat is gone — no further eval on the next tick.
    mockRedis.eval.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it("falls back to an unconditional DEL when no lock state is tracked", async () => {
    mockRedis.del.mockResolvedValue(1);

    await releaseWebAgentLock("sess-untracked");

    expect(mockRedis.del).toHaveBeenCalledWith(
      expect.stringContaining("web:agent:sess-untracked"),
    );
  });
});
