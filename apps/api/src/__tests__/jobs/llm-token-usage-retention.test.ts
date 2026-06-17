// Tests for the llm_token_usage retention cleaner (item C / #94-16).
//
// cleanupExpiredLlmTokenUsage deletes llm_token_usage rows (by createdAt) older
// than LLM_TOKEN_USAGE_RETENTION_DAYS, in bounded batches. Unlike RETENTION_DAYS
// it DEFAULTS to 30 days (so the table can't grow unbounded by default); an
// explicit <= 0 opts out. RETENTION_DRY_RUN counts without deleting.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFindMany = vi.hoisted(() => vi.fn());
const mockDeleteMany = vi.hoisted(() => vi.fn());
const mockCount = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    llmTokenUsage: {
      findMany: mockFindMany,
      deleteMany: mockDeleteMany,
      count: mockCount,
    },
  },
}));

import { cleanupExpiredLlmTokenUsage } from "../../jobs/llm-token-usage-retention.js";

const NOW = new Date("2026-06-17T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_ROWS = (...ids: string[]) => ids.map((id) => ({ id }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockFindMany.mockResolvedValue([]);
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockCount.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("llm_token_usage retention", () => {
  it("sweeps by DEFAULT (30d) when the env var is unset — NOT opt-in", async () => {
    // One sub-batch (< batchSize) so the loop breaks after a single iteration.
    mockFindMany.mockResolvedValueOnce(ID_ROWS("a", "b"));
    mockDeleteMany.mockResolvedValueOnce({ count: 2 });

    const res = await cleanupExpiredLlmTokenUsage();

    expect(res.skipped).toBe(false);
    expect(res.llmTokenUsage).toBe(2);
    // Cutoff is exactly NOW - 30 days, and the sweep filters createdAt < cutoff.
    const where = mockFindMany.mock.calls[0]![0].where;
    expect(where.createdAt.lt.getTime()).toBe(NOW.getTime() - 30 * DAY_MS);
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] } } });
  });

  it("opts out (no delete) when LLM_TOKEN_USAGE_RETENTION_DAYS <= 0", async () => {
    vi.stubEnv("LLM_TOKEN_USAGE_RETENTION_DAYS", "0");
    const res = await cleanupExpiredLlmTokenUsage();
    expect(res.skipped).toBe(true);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("honors a custom window and only deletes rows older than the cutoff", async () => {
    vi.stubEnv("LLM_TOKEN_USAGE_RETENTION_DAYS", "7");
    mockFindMany.mockResolvedValueOnce(ID_ROWS("old-1"));
    mockDeleteMany.mockResolvedValueOnce({ count: 1 });

    const res = await cleanupExpiredLlmTokenUsage();

    expect(res.llmTokenUsage).toBe(1);
    const where = mockFindMany.mock.calls[0]![0].where;
    expect(where.createdAt.lt.getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
  });

  it("dry-run counts without deleting", async () => {
    vi.stubEnv("RETENTION_DRY_RUN", "true");
    mockCount.mockResolvedValueOnce(5);

    const res = await cleanupExpiredLlmTokenUsage();

    expect(res.dryRun).toBe(true);
    expect(res.llmTokenUsage).toBe(5);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});
