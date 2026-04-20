// Tests for review-prompt scheduler
// Mocks Redis to verify scheduling logic without network

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scheduleReviewPrompt } from "../jobs/review-prompt.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());

// ── Mocks (before imports) ──────────────────────────────────────────────────

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const REVIEW_DELAY_MS = 30 * 60 * 1000; // 30 minutes (matches source)

function createMockPipeline() {
  return {
    set: vi.fn().mockReturnThis(),
    zAdd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
}

function createMockRedis(pipeline: ReturnType<typeof createMockPipeline>) {
  return {
    multi: vi.fn(() => pipeline),
  };
}

describe("scheduleReviewPrompt", () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic scheduling ────────────────────────────────────────────────────

  it("creates a pipeline with SET and ZADD commands", async () => {
    await scheduleReviewPrompt("cust_01", "order_01");

    expect(mockRedis.multi).toHaveBeenCalledOnce();
    expect(mockPipeline.set).toHaveBeenCalledOnce();
    expect(mockPipeline.zAdd).toHaveBeenCalledOnce();
    expect(mockPipeline.exec).toHaveBeenCalledOnce();
  });

  // ── SET command details ───────────────────────────────────────────────────

  it("writes idempotency marker with correct key and 24h TTL", async () => {
    await scheduleReviewPrompt("cust_01", "order_01");

    expect(mockRk).toHaveBeenCalledWith("review:prompt:cust_01:order_01");
    expect(mockPipeline.set).toHaveBeenCalledWith(
      "test:review:prompt:cust_01:order_01",
      "order_01",
      { EX: 86400 },
    );
  });

  // ── ZADD command details ──────────────────────────────────────────────────

  it("adds to sorted set with fire time = now + 30 minutes", async () => {
    const now = Date.now();
    const expectedFireAt = now + REVIEW_DELAY_MS;

    await scheduleReviewPrompt("cust_02", "order_02");

    expect(mockRk).toHaveBeenCalledWith("review:prompt:scheduled");
    expect(mockPipeline.zAdd).toHaveBeenCalledWith(
      "test:review:prompt:scheduled",
      { score: expectedFireAt, value: "cust_02:order_02" },
    );
  });

  // ── Member format ─────────────────────────────────────────────────────────

  it("uses customerId:orderId as the sorted set member", async () => {
    await scheduleReviewPrompt("cust_abc", "order_xyz");

    expect(mockPipeline.zAdd).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ value: "cust_abc:order_xyz" }),
    );
  });

  // ── Different customers produce distinct keys ─────────────────────────────

  it("produces distinct keys for different customers and orders", async () => {
    await scheduleReviewPrompt("cust_01", "order_01");
    await scheduleReviewPrompt("cust_02", "order_02");

    const rkCalls = mockRk.mock.calls.map((c: string[]) => c[0]);
    expect(rkCalls).toContain("review:prompt:cust_01:order_01");
    expect(rkCalls).toContain("review:prompt:cust_02:order_02");
  });

  // ── Fire-at timestamp advances with real time ─────────────────────────────

  it("computes fireAt relative to current time", async () => {
    // First schedule at T=14:00
    await scheduleReviewPrompt("cust_01", "order_01");
    const firstFireAt = mockPipeline.zAdd.mock.calls[0][1].score;

    // Advance 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000);

    // Second schedule at T=14:10
    await scheduleReviewPrompt("cust_02", "order_02");
    const secondFireAt = mockPipeline.zAdd.mock.calls[1][1].score;

    expect(secondFireAt - firstFireAt).toBe(10 * 60 * 1000);
  });

  // ── Pipeline exec is always called ────────────────────────────────────────

  it("always executes the pipeline", async () => {
    await scheduleReviewPrompt("cust_01", "order_01");

    expect(mockPipeline.exec).toHaveBeenCalledOnce();
  });

  // ── Pipeline exec error propagates ────────────────────────────────────────

  it("propagates pipeline execution errors", async () => {
    mockPipeline.exec.mockRejectedValue(new Error("Redis pipeline failed"));

    await expect(scheduleReviewPrompt("cust_01", "order_01")).rejects.toThrow(
      "Redis pipeline failed",
    );
  });

  // ── getRedisClient error propagates ───────────────────────────────────────

  it("propagates Redis connection errors", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("Connection refused"));

    await expect(scheduleReviewPrompt("cust_01", "order_01")).rejects.toThrow(
      "Connection refused",
    );
  });
});
