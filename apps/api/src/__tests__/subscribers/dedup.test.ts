// Regression tests for the two-phase NATS idempotency guard (P1-CONC-DEDUP).
//
// Verifies:
//   • withDedup claims with a SHORT in-flight TTL, then promotes to the full TTL
//     ONLY after the handler succeeds (no mark-before-run / at-most-once hazard).
//   • A handler throw RELEASES the claim (del) so redelivery reprocesses, and the
//     error is rethrown (routed to the DLQ by the NATS loop).
//   • A Redis error during the claim FAILS CLOSED — the handler does NOT run and a
//     DedupUnavailableError is thrown (event left for redelivery, not processed
//     unguarded).
//   • A duplicate (claim returns null) skips the handler and returns false.
//   • isNewEvent keeps its single-phase SET NX semantics (backward compatible).
//
// Pure unit test — Redis is mocked, no network.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `test:${k}`));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

import { withDedup, isNewEvent, markProcessed, DedupUnavailableError } from "../../subscribers/dedup.js";

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

const FULL_TTL = 604_800;
const INFLIGHT_TTL = 300;

describe("withDedup — two-phase idempotency guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((k: string) => `test:${k}`);
  });

  it("claims with a SHORT in-flight TTL, then promotes to full TTL after success", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await withDedup("evt:1", handler);

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledOnce();

    // First set = claim with NX + short in-flight TTL
    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      "test:nats:processed:evt:1",
      "1",
      { EX: INFLIGHT_TTL, NX: true },
    );
    // Second set = confirm/promote to full TTL (no NX)
    expect(redis.set).toHaveBeenNthCalledWith(
      2,
      "test:nats:processed:evt:1",
      "1",
      { EX: FULL_TTL },
    );
    // Claim was NOT released on success
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("does NOT promote to full TTL until the handler runs (no mark-before-run)", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);

    let setCallsAtHandlerStart = -1;
    const handler = vi.fn().mockImplementation(async () => {
      setCallsAtHandlerStart = redis.set.mock.calls.length;
    });

    await withDedup("evt:order", handler);

    // At the moment the handler started, exactly ONE set (the claim) had run —
    // the full-TTL promote happens only AFTER the handler returns.
    expect(setCallsAtHandlerStart).toBe(1);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it("RELEASES the claim and rethrows when the handler throws (redelivery reprocesses)", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);
    const boom = new Error("handler blew up");
    const handler = vi.fn().mockRejectedValue(boom);

    await expect(withDedup("evt:fail", handler)).rejects.toThrow("handler blew up");

    // Claim was made (short TTL) ...
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      "test:nats:processed:evt:fail",
      "1",
      { EX: INFLIGHT_TTL, NX: true },
    );
    // ... and then RELEASED so the event is not left marked-as-done.
    expect(redis.del).toHaveBeenCalledWith("test:nats:processed:evt:fail");
  });

  it("FAILS CLOSED when the claim itself errors (Redis down) — handler not run", async () => {
    const redis = createMockRedis({
      set: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    mockGetRedisClient.mockResolvedValue(redis);
    const handler = vi.fn();

    await expect(withDedup("evt:redisdown", handler)).rejects.toBeInstanceOf(DedupUnavailableError);

    // Handler must NOT have run — we fail closed rather than proceed unguarded.
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips the handler and returns false on a duplicate (claim returns null)", async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(redis);
    const handler = vi.fn();

    const result = await withDedup("evt:dup", handler);

    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    // No promote, no release for a duplicate.
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("treats a failed promote as non-fatal (handler already succeeded)", async () => {
    const redis = createMockRedis({
      set: vi
        .fn()
        .mockResolvedValueOnce("OK") // claim succeeds
        .mockRejectedValueOnce(new Error("promote failed")), // confirm fails
    });
    mockGetRedisClient.mockResolvedValue(redis);
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await withDedup("evt:promotefail", handler);

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("isNewEvent — single-phase claim (backward compatible)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((k: string) => `test:${k}`);
  });

  it("returns true and marks with full TTL when SET NX succeeds", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);

    const result = await isNewEvent("alert:new-order:order_1");

    expect(result).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      "test:nats:processed:alert:new-order:order_1",
      "1",
      { EX: FULL_TTL, NX: true },
    );
  });

  it("returns false when SET NX returns null (already processed)", async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(redis);

    expect(await isNewEvent("alert:dup")).toBe(false);
  });

  it("propagates a Redis error so the caller decides fail-open vs fail-closed", async () => {
    const redis = createMockRedis({ set: vi.fn().mockRejectedValue(new Error("down")) });
    mockGetRedisClient.mockResolvedValue(redis);

    await expect(isNewEvent("alert:err")).rejects.toThrow("down");
  });
});

describe("markProcessed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((k: string) => `test:${k}`);
  });

  it("sets the processed key with the full TTL (no NX, so it overwrites a claim)", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);

    await markProcessed("evt:confirm");

    expect(redis.set).toHaveBeenCalledWith(
      "test:nats:processed:evt:confirm",
      "1",
      { EX: FULL_TTL },
    );
  });
});
