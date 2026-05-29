// Regression tests for outbox-retry memory/scale hardening (P1-SCALE-OUTBOXMEM).
//
// Verifies the retry job reads a BOUNDED page (LRANGE key 0 N-1) instead of the
// whole list (LRANGE 0 -1), and that an unparseable "poison" entry is routed to
// the DLQ and removed from the outbox instead of blocking the head forever.
//
// Calls processOutbox() directly — no BullMQ, no network, no Redis.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `test:${k}`));
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockPushToDlq = vi.hoisted(() => vi.fn());
const mockWithScope = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());

// ── Module mocks (before imports) ────────────────────────────────────────────
vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
  outboxKey: (prefix: string, event: string) => `${prefix}:outbox:${event}`,
  // CRITICAL_EVENTS derives from this; keep a single critical event so the
  // per-event assertions are unambiguous.
  OUTBOX_EVENTS: new Set(["order.placed"]),
}));

vi.mock("../../subscribers/dlq.js", () => ({
  pushToDlq: mockPushToDlq,
}));

vi.mock("@sentry/node", () => ({
  withScope: mockWithScope,
  captureException: mockCaptureException,
}));

import { processOutbox } from "../outbox-retry.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    set: vi.fn().mockResolvedValue("OK"), // lock acquired
    lRange: vi.fn().mockResolvedValue([]),
    lRem: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1), // lock released
    ...overrides,
  };
}

describe("outbox-retry bounded paging (P1-SCALE-OUTBOXMEM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((k: string) => `test:${k}`);
  });

  it("reads a bounded page (LRANGE key 0 N-1), never the whole list (0 -1)", async () => {
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);

    await processOutbox(null);

    expect(redis.lRange).toHaveBeenCalledTimes(1);
    const [, start, stop] = redis.lRange.mock.calls[0];
    expect(start).toBe(0);
    // Default page size is 500 → stop index 499. Crucially NOT -1 (unbounded).
    expect(stop).toBe(499);
    expect(stop).not.toBe(-1);
  });

  it("routes a poison (unparseable) entry to the DLQ and removes it from the outbox", async () => {
    const redis = createMockRedis({
      lRange: vi.fn().mockResolvedValue(["{not valid json"]),
    });
    mockGetRedisClient.mockResolvedValue(redis);

    await processOutbox(null);

    // Poison entry never re-published...
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    // ...routed to DLQ...
    expect(mockPushToDlq).toHaveBeenCalledWith(
      "order.placed",
      { _rawEntry: "{not valid json" },
      expect.any(Error),
      undefined,
    );
    // ...and removed from the outbox so it stops blocking the page head.
    expect(redis.lRem).toHaveBeenCalledWith(
      expect.stringContaining(":outbox:order.placed"),
      1,
      "{not valid json",
    );
  });

  it("re-publishes a valid entry and leaves removal to publishNatsEvent", async () => {
    const redis = createMockRedis({
      lRange: vi.fn().mockResolvedValue(['{"orderId":"ord_1"}']),
    });
    mockGetRedisClient.mockResolvedValue(redis);

    await processOutbox(null);

    expect(mockPublishNatsEvent).toHaveBeenCalledWith("order.placed", { orderId: "ord_1" });
    // Valid entry is NOT removed here (publishNatsEvent LREMs on success) and is
    // NOT sent to the DLQ.
    expect(mockPushToDlq).not.toHaveBeenCalled();
    expect(redis.lRem).not.toHaveBeenCalled();
  });
});
