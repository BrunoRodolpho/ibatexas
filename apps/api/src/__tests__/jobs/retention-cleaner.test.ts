// Tests for the retention cleaner job (P3-SCALE-RETENTION).
//
// cleanupExpiredRecords deletes ConversationMessage (by sentAt) + OrderEventLog (by
// createdAt) rows older than RETENTION_DAYS, in bounded batches. It is OPT-IN: with
// RETENTION_DAYS unset or <= 0 it is a no-op (no destructive default). RETENTION_DRY_RUN
// counts what would be deleted without deleting. A failure purging one table must not
// block the other.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted prisma mock ──────────────────────────────────────────────────────
const mockCmFindMany = vi.hoisted(() => vi.fn());
const mockCmDeleteMany = vi.hoisted(() => vi.fn());
const mockCmCount = vi.hoisted(() => vi.fn());
const mockOelFindMany = vi.hoisted(() => vi.fn());
const mockOelDeleteMany = vi.hoisted(() => vi.fn());
const mockOelCount = vi.hoisted(() => vi.fn());
const mockExecuteRaw = vi.hoisted(() => vi.fn());
const mockQueryRaw = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    conversationMessage: { findMany: mockCmFindMany, deleteMany: mockCmDeleteMany, count: mockCmCount },
    orderEventLog: { findMany: mockOelFindMany, deleteMany: mockOelDeleteMany, count: mockOelCount },
    $executeRaw: mockExecuteRaw,
    $queryRaw: mockQueryRaw,
  },
}));

import { cleanupExpiredRecords } from "../../jobs/retention-cleaner.js";

const NOW = new Date("2026-05-30T12:00:00.000Z");
const ID_ROWS = (...ids: string[]) => ids.map((id) => ({ id }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // default: empty tables (no rows older than cutoff)
  mockCmFindMany.mockResolvedValue([]);
  mockOelFindMany.mockResolvedValue([]);
  mockCmCount.mockResolvedValue(0);
  mockOelCount.mockResolvedValue(0);
  mockExecuteRaw.mockResolvedValue(0);
  mockQueryRaw.mockResolvedValue([{ count: 0 }]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("retention cleaner — opt-in gating", () => {
  it("is a no-op when RETENTION_DAYS is unset (disabled by default)", async () => {
    const res = await cleanupExpiredRecords();

    expect(res.skipped).toBe(true);
    expect(res.conversationMessages).toBe(0);
    expect(res.orderEvents).toBe(0);
    // Nothing touched the database
    expect(mockCmFindMany).not.toHaveBeenCalled();
    expect(mockCmDeleteMany).not.toHaveBeenCalled();
    expect(mockOelFindMany).not.toHaveBeenCalled();
    expect(mockOelDeleteMany).not.toHaveBeenCalled();
  });

  it("is a no-op when RETENTION_DAYS <= 0", async () => {
    vi.stubEnv("RETENTION_DAYS", "0");
    const res = await cleanupExpiredRecords();
    expect(res.skipped).toBe(true);
    expect(mockCmDeleteMany).not.toHaveBeenCalled();
    expect(mockOelDeleteMany).not.toHaveBeenCalled();
  });

  it("is a no-op when RETENTION_DAYS is not a positive number", async () => {
    vi.stubEnv("RETENTION_DAYS", "not-a-number");
    const res = await cleanupExpiredRecords();
    expect(res.skipped).toBe(true);
    expect(mockCmDeleteMany).not.toHaveBeenCalled();
  });
});

describe("retention cleaner — deletion", () => {
  it("deletes ConversationMessage (by sentAt) + OrderEventLog (by createdAt) older than the cutoff", async () => {
    vi.stubEnv("RETENTION_DAYS", "30");
    mockCmFindMany.mockResolvedValueOnce(ID_ROWS("m1", "m2")).mockResolvedValue([]);
    mockCmDeleteMany.mockResolvedValue({ count: 2 });
    mockOelFindMany.mockResolvedValueOnce(ID_ROWS("e1")).mockResolvedValue([]);
    mockOelDeleteMany.mockResolvedValue({ count: 1 });

    const res = await cleanupExpiredRecords();

    // cutoff = NOW - 30d
    const cutoff = new Date("2026-04-30T12:00:00.000Z");
    expect(mockCmFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sentAt: { lt: cutoff } }, select: { id: true }, take: 1000 }),
    );
    expect(mockOelFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: 1000 }),
    );
    // deleted strictly by the selected ids (never a blind table-wide deleteMany)
    expect(mockCmDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["m1", "m2"] } } });
    expect(mockOelDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["e1"] } } });

    expect(res).toEqual({ skipped: false, dryRun: false, conversationMessages: 2, orderEvents: 1, turnTraces: 0 });
  });

  it("processes large backlogs in bounded batches (loops until a short batch)", async () => {
    vi.stubEnv("RETENTION_DAYS", "30");
    vi.stubEnv("RETENTION_BATCH_SIZE", "2");
    // First batch: full (2 ids) → keep going; second batch: short (1 id) → stop.
    mockCmFindMany
      .mockResolvedValueOnce(ID_ROWS("m1", "m2"))
      .mockResolvedValueOnce(ID_ROWS("m3"))
      .mockResolvedValue([]);
    mockCmDeleteMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });

    const res = await cleanupExpiredRecords();

    expect(mockCmFindMany).toHaveBeenCalledTimes(2); // stopped after the short batch
    expect(mockCmDeleteMany).toHaveBeenCalledTimes(2);
    expect(mockCmFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    expect(res.conversationMessages).toBe(3);
  });

  it("dry-run counts what would be deleted but deletes nothing", async () => {
    vi.stubEnv("RETENTION_DAYS", "30");
    vi.stubEnv("RETENTION_DRY_RUN", "true");
    mockCmCount.mockResolvedValue(7);
    mockOelCount.mockResolvedValue(4);

    const res = await cleanupExpiredRecords();

    expect(mockCmCount).toHaveBeenCalledWith({ where: { sentAt: { lt: new Date("2026-04-30T12:00:00.000Z") } } });
    expect(mockOelCount).toHaveBeenCalledWith({ where: { createdAt: { lt: new Date("2026-04-30T12:00:00.000Z") } } });
    expect(mockCmDeleteMany).not.toHaveBeenCalled();
    expect(mockOelDeleteMany).not.toHaveBeenCalled();
    expect(res).toEqual({ skipped: false, dryRun: true, conversationMessages: 7, orderEvents: 4, turnTraces: 0 });
  });

  it("a failure purging one table does not block the other (fail-soft per table)", async () => {
    vi.stubEnv("RETENTION_DAYS", "30");
    mockCmFindMany.mockRejectedValue(new Error("DB hiccup on conversation_messages"));
    mockOelFindMany.mockResolvedValueOnce(ID_ROWS("e1", "e2")).mockResolvedValue([]);
    mockOelDeleteMany.mockResolvedValue({ count: 2 });

    const res = await cleanupExpiredRecords();

    // conversation purge failed → 0, but order events still purged
    expect(res.conversationMessages).toBe(0);
    expect(res.orderEvents).toBe(2);
    expect(res.skipped).toBe(false);
    expect(mockOelDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["e1", "e2"] } } });
  });
});

describe("retention cleaner — turn_trace (independent TURN_TRACE_RETENTION_DAYS knob)", () => {
  it("sweeps turn_trace on its own knob even when RETENTION_DAYS is unset", async () => {
    vi.stubEnv("TURN_TRACE_RETENTION_DAYS", "7");
    mockExecuteRaw.mockResolvedValue(5);

    const res = await cleanupExpiredRecords();

    expect(res.skipped).toBe(false);
    expect(res.turnTraces).toBe(5);
    // Prisma-table sweep stayed disabled (RETENTION_DAYS unset).
    expect(res.conversationMessages).toBe(0);
    expect(res.orderEvents).toBe(0);
    expect(mockCmDeleteMany).not.toHaveBeenCalled();
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("dry-run counts turn_trace rows without deleting", async () => {
    vi.stubEnv("TURN_TRACE_RETENTION_DAYS", "7");
    vi.stubEnv("RETENTION_DRY_RUN", "true");
    mockQueryRaw.mockResolvedValue([{ count: 9 }]);

    const res = await cleanupExpiredRecords();

    expect(res.dryRun).toBe(true);
    expect(res.turnTraces).toBe(9);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it("a turn_trace purge failure is fail-soft (does not throw)", async () => {
    vi.stubEnv("TURN_TRACE_RETENTION_DAYS", "7");
    mockExecuteRaw.mockRejectedValue(new Error("relation \"turn_trace\" does not exist"));

    const res = await cleanupExpiredRecords();
    expect(res.skipped).toBe(false);
    expect(res.turnTraces).toBe(0);
  });
});
