// Tests for follow-up poller job
// Mock-based; no Redis or NATS required.
//
// Scenarios:
// - Due entries (score <= now) are published and removed
// - Future entries (score > now) are NOT published
// - Multiple due entries processed in one run
// - Sentry called on publish error

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((key: string) => `development:${key}`));
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockSentryCaptureException = vi.hoisted(() => vi.fn());
const mockSentryWithScope = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@sentry/node", () => ({
  withScope: mockSentryWithScope.mockImplementation((cb: (scope: unknown) => void) => {
    cb({ setTag: vi.fn(), setContext: vi.fn() });
  }),
  captureException: mockSentryCaptureException,
}));

vi.mock("../../jobs/queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { processFollowUps } from "../../jobs/follow-up-poller.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(customerId: string, reason: string): string {
  return JSON.stringify({ customerId, reason, scheduledAt: new Date().toISOString() });
}

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    zRangeByScore: vi.fn().mockResolvedValue([]),
    zRem: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("processFollowUps", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  it("publishes follow-up.due and removes due entries", async () => {
    const entry = makeEntry("cust_01", "thinking");
    mockRedis.zRangeByScore.mockResolvedValue([entry]);

    await processFollowUps(null);

    expect(mockPublishNatsEvent).toHaveBeenCalledOnce();
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", {
      customerId: "cust_01",
      reason: "thinking",
    });
    expect(mockRedis.zRem).toHaveBeenCalledWith("development:follow-up:scheduled", entry);
  });

  it("does not publish entries that are not due (empty range result)", async () => {
    // Future entries would not be returned by zRangeByScore with score <= now
    mockRedis.zRangeByScore.mockResolvedValue([]);

    await processFollowUps(null);

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    expect(mockRedis.zRem).not.toHaveBeenCalled();
  });

  it("processes multiple due entries in one run", async () => {
    const entry1 = makeEntry("cust_01", "thinking");
    const entry2 = makeEntry("cust_02", "cart_save");
    const entry3 = makeEntry("cust_03", "price_concern");
    mockRedis.zRangeByScore.mockResolvedValue([entry1, entry2, entry3]);

    await processFollowUps(null);

    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(3);
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", { customerId: "cust_01", reason: "thinking" });
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", { customerId: "cust_02", reason: "cart_save" });
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", { customerId: "cust_03", reason: "price_concern" });
    expect(mockRedis.zRem).toHaveBeenCalledTimes(3);
  });

  it("calls Sentry on publish error and leaves entry in sorted set", async () => {
    const entry = makeEntry("cust_01", "thinking");
    mockRedis.zRangeByScore.mockResolvedValue([entry]);
    const publishError = new Error("NATS unavailable");
    mockPublishNatsEvent.mockRejectedValue(publishError);

    await processFollowUps(null);

    expect(mockSentryWithScope).toHaveBeenCalled();
    // Entry should NOT be removed when publish fails
    expect(mockRedis.zRem).not.toHaveBeenCalled();
  });

  it("removes malformed entries silently without publishing", async () => {
    mockRedis.zRangeByScore.mockResolvedValue(["not-valid-json"]);

    await processFollowUps(null);

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    expect(mockRedis.zRem).toHaveBeenCalledWith("development:follow-up:scheduled", "not-valid-json");
  });
});
