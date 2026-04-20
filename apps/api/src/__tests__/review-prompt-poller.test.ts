// Tests for review-prompt-poller job
// Mocks Redis and NATS to test the polling/dispatch logic without network.
// Tests call the exported pollReviewPrompts() processor directly (BullMQ is mocked).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pollReviewPrompts,
  startReviewPromptPoller,
  stopReviewPromptPoller,
} from "../jobs/review-prompt-poller.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());

// ── Mocks (before imports) ──────────────────────────────────────────────────

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("../jobs/queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const BATCH_CAP = 100;

function createMockPipeline() {
  return {
    zRem: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
}

function createMockRedis(pipeline: ReturnType<typeof createMockPipeline>) {
  return {
    zRangeByScore: vi.fn(),
    get: vi.fn(),
    zRem: vi.fn(),
    multi: vi.fn(() => pipeline),
  };
}

describe("review-prompt-poller", () => {
  let mockPipeline: ReturnType<typeof createMockPipeline>;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T14:00:00Z"));

    mockPipeline = createMockPipeline();
    mockRedis = createMockRedis(mockPipeline);
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockRk.mockImplementation((key: string) => `test:${key}`);
  });

  afterEach(async () => {
    await stopReviewPromptPoller();
    vi.useRealTimers();
  });

  // ── start / stop lifecycle ──────────────────────────────────────────────

  it("starts and stops without errors", async () => {
    expect(() => startReviewPromptPoller()).not.toThrow();
    await expect(stopReviewPromptPoller()).resolves.toBeUndefined();
  });

  it("does not start a second worker if already running", () => {
    startReviewPromptPoller();
    // Second call should be a no-op
    expect(() => startReviewPromptPoller()).not.toThrow();
  });

  it("stopReviewPromptPoller is safe to call when not started", async () => {
    await expect(stopReviewPromptPoller()).resolves.toBeUndefined();
  });

  // ── Empty queue ───────────────────────────────────────────────────────────

  it("handles empty scheduled set (no due prompts)", async () => {
    mockRedis.zRangeByScore.mockResolvedValue([]);

    await pollReviewPrompts();

    expect(mockRedis.zRangeByScore).toHaveBeenCalledTimes(1);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Fetches due entries with correct parameters ───────────────────────────

  it("queries sorted set with score range 0 to now and batch limit", async () => {
    const now = Date.now();
    mockRedis.zRangeByScore.mockResolvedValue([]);

    await pollReviewPrompts();

    expect(mockRedis.zRangeByScore).toHaveBeenCalledWith(
      "test:review:prompt:scheduled",
      0,
      now,
      { LIMIT: { offset: 0, count: BATCH_CAP } },
    );
  });

  // ── Processes a due review prompt ─────────────────────────────────────────

  it("publishes NATS event and cleans up for a due prompt", async () => {
    mockRedis.zRangeByScore.mockResolvedValue(["cust_01:order_01"]);
    mockRedis.get.mockResolvedValue("order_01"); // marker exists
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await pollReviewPrompts();

    // Should publish the review.prompt event
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "review.prompt",
      {
        eventType: "review.prompt",
        customerId: "cust_01",
        orderId: "order_01",
      },
    );

    // Should clean up: pipeline zRem + del
    expect(mockPipeline.zRem).toHaveBeenCalledWith(
      "test:review:prompt:scheduled",
      "cust_01:order_01",
    );
    expect(mockPipeline.del).toHaveBeenCalledWith("test:review:prompt:cust_01:order_01");
    expect(mockPipeline.exec).toHaveBeenCalledOnce();
  });

  // ── Skips already-processed entries (marker expired) ──────────────────────

  it("removes entry from sorted set when marker key has expired", async () => {
    mockRedis.zRangeByScore.mockResolvedValue(["cust_02:order_02"]);
    mockRedis.get.mockResolvedValue(null); // marker expired / already processed

    await pollReviewPrompts();

    // Should NOT publish event
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();

    // Should clean up the stale sorted set entry
    expect(mockRedis.zRem).toHaveBeenCalledWith(
      "test:review:prompt:scheduled",
      "cust_02:order_02",
    );

    // Should NOT run the cleanup pipeline (only direct zRem)
    expect(mockPipeline.exec).not.toHaveBeenCalled();
  });

  // ── Skips malformed members (no colon separator) ──────────────────────────

  it("skips members that do not contain a colon separator", async () => {
    mockRedis.zRangeByScore.mockResolvedValue(["malformed-no-colon"]);

    await pollReviewPrompts();

    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Multiple due prompts in one batch ─────────────────────────────────────

  it("processes multiple due prompts in a single batch", async () => {
    mockRedis.zRangeByScore.mockResolvedValue([
      "cust_01:order_01",
      "cust_02:order_02",
      "cust_03:order_03",
    ]);
    mockRedis.get.mockResolvedValue("some-marker"); // all markers exist
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await pollReviewPrompts();

    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(3);
    expect(mockPipeline.exec).toHaveBeenCalledTimes(3);
  });

  // ── NATS publish error: leave in sorted set for retry ─────────────────────

  it("leaves entry in sorted set when NATS publish fails (for retry)", async () => {
    mockRedis.zRangeByScore.mockResolvedValue(["cust_fail:order_fail"]);
    mockRedis.get.mockResolvedValue("order_fail"); // marker exists
    mockPublishNatsEvent.mockRejectedValue(new Error("NATS connection lost"));

    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      silent: vi.fn(),
      level: "info",
    };

    await pollReviewPrompts(mockLogger as unknown as import("fastify").FastifyBaseLogger);

    // Error should be logged
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cust_fail",
        orderId: "order_fail",
      }),
      "Failed to publish review.prompt event",
    );

    // Pipeline should NOT have been called (entry stays for retry)
    expect(mockPipeline.exec).not.toHaveBeenCalled();
  });

  // ── Batch cap warning ─────────────────────────────────────────────────────

  it("logs a warning when batch cap is reached", async () => {
    // Create exactly BATCH_CAP members
    const members = Array.from({ length: BATCH_CAP }, (_, i) => `cust_${i}:order_${i}`);
    mockRedis.zRangeByScore.mockResolvedValue(members);
    mockRedis.get.mockResolvedValue("marker");
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      silent: vi.fn(),
      level: "info",
    };

    await pollReviewPrompts(mockLogger as unknown as import("fastify").FastifyBaseLogger);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: "review_prompt_batch_cap_reached", cap: BATCH_CAP }),
      "Poller hit batch cap — consider increasing frequency",
    );
  });

  // ── No warning when under batch cap ───────────────────────────────────────

  it("does not log a warning when under batch cap", async () => {
    mockRedis.zRangeByScore.mockResolvedValue(["cust_01:order_01"]);
    mockRedis.get.mockResolvedValue("marker");
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      silent: vi.fn(),
      level: "info",
    };

    await pollReviewPrompts(mockLogger as unknown as import("fastify").FastifyBaseLogger);

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  // ── Logger info on every tick ─────────────────────────────────────────────

  it("logs batch_size and tick timestamp on each poll", async () => {
    mockRedis.zRangeByScore.mockResolvedValue(["cust_01:order_01"]);
    mockRedis.get.mockResolvedValue("marker");
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      silent: vi.fn(),
      level: "info",
    };

    await pollReviewPrompts(mockLogger as unknown as import("fastify").FastifyBaseLogger);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ batch_size: 1 }),
      "review-prompt poller tick",
    );
  });

  // ── Mix of valid, expired, and malformed in one batch ─────────────────────

  it("handles mixed batch: valid + expired marker + malformed", async () => {
    mockRedis.zRangeByScore.mockResolvedValue([
      "cust_ok:order_ok",
      "cust_expired:order_expired",
      "no-colon-malformed",
    ]);

    mockRedis.get
      .mockResolvedValueOnce("order_ok")       // valid marker
      .mockResolvedValueOnce(null);             // expired marker

    mockPublishNatsEvent.mockResolvedValue(undefined);

    await pollReviewPrompts();

    // Only the valid one should be published
    expect(mockPublishNatsEvent).toHaveBeenCalledOnce();
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "review.prompt",
      expect.objectContaining({ customerId: "cust_ok", orderId: "order_ok" }),
    );

    // Expired one should be zRem'd directly
    expect(mockRedis.zRem).toHaveBeenCalledWith(
      "test:review:prompt:scheduled",
      "cust_expired:order_expired",
    );

    // Pipeline cleanup for the valid one
    expect(mockPipeline.exec).toHaveBeenCalledOnce();
  });

  // ── Top-level error caught ────────────────────────────────────────────────

  it("throws unexpected top-level errors for BullMQ to handle", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("Redis unreachable"));

    await expect(pollReviewPrompts()).rejects.toThrow("Redis unreachable");
  });

  // ── Idempotency marker key checked correctly ──────────────────────────────

  it("checks the correct idempotency marker key", async () => {
    mockRedis.zRangeByScore.mockResolvedValue(["cust_abc:order_xyz"]);
    mockRedis.get.mockResolvedValue("order_xyz");
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await pollReviewPrompts();

    expect(mockRk).toHaveBeenCalledWith("review:prompt:cust_abc:order_xyz");
    expect(mockRedis.get).toHaveBeenCalledWith("test:review:prompt:cust_abc:order_xyz");
  });

  // ── Cleanup pipeline deletes the correct marker key ───────────────────────

  it("deletes the correct marker key after successful publish", async () => {
    mockRedis.zRangeByScore.mockResolvedValue(["cust_del:order_del"]);
    mockRedis.get.mockResolvedValue("order_del");
    mockPublishNatsEvent.mockResolvedValue(undefined);

    await pollReviewPrompts();

    expect(mockRk).toHaveBeenCalledWith("review:prompt:cust_del:order_del");
    expect(mockPipeline.del).toHaveBeenCalledWith("test:review:prompt:cust_del:order_del");
  });
});
