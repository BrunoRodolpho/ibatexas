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

  // F-21 (class rollout) — this case is the INVERSE of what it used to assert.
  //
  // It read: "falls back to an unconditional DEL when no lock state is
  // tracked", and it passed, because that is exactly what the code did. The
  // rollout's finding is that the fallback was the defect, not the feature: no
  // tracked state means no lockValue, and a lockValue is this module's only
  // ownership proof. The states that reach it — a process restart (the Map is
  // per-process, the Redis key is not) or a second release for a session whose
  // first already cleared the entry — are precisely the states where the key is
  // most likely to belong to a DIFFERENT, live cycle. Deleting it lets a
  // concurrent agent run for that session.
  //
  // Per the F-22 ruling's failure direction, with no ownership proof the safe
  // action is leave-to-TTL plus a loud log. The KEYSPACE consequence (the key
  // really survives, and a foreign owner keeps it) is proven against a real
  // server in `execution-queue-release-fallback.test.ts`; what this unit case
  // pins is the command-level claim the old assertion had backwards.
  it("issues NO delete at all when no lock state is tracked (leaves it to the TTL)", async () => {
    mockRedis.del.mockResolvedValue(1);
    mockRedis.eval.mockResolvedValue(1);

    await releaseWebAgentLock("sess-untracked");

    // Neither spelling of "remove the key" — not the unconditional DEL that
    // used to be asserted here, and not a compare-and-delete either, because
    // there is no token to compare against.
    expect(mockRedis.del).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it("still deletes on the TRACKED path — the control for the case above", async () => {
    // Without this, the case above would also pass if `releaseWebAgentLock`
    // had simply stopped touching Redis entirely.
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);

    await acquireWebAgentLock("sess-tracked");
    mockRedis.eval.mockClear();
    await releaseWebAgentLock("sess-tracked");

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("DEL"),
      expect.objectContaining({
        keys: [expect.stringContaining("web:agent:sess-tracked")],
      }),
    );
    expect(mockRedis.del).not.toHaveBeenCalled();
  });
});
