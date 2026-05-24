// Unit tests for the Wave-B Medusa anonymize retry job
// (audit-2026-05-24 H3 Wave B step 4).
//
// Coverage:
//   - empty pending index → no-op (no publish).
//   - stale entry → bumps attempt + re-publishes pending NATS event.
//   - fresh entry (younger than MIN_AGE_BEFORE_RETRY_MS) → skipped.
//   - attempt >= MEDUSA_ANONYMIZE_MAX_ATTEMPTS → emits exhausted audit,
//     does NOT re-publish, leaves entry for operator.
//   - missing per-entry hash → drops from index, returns missing.
//   - second concurrent instance → SETNX lock prevents double-publish.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockPublishNatsEvent = vi.hoisted(() => vi.fn(async () => undefined));
const mockListPending = vi.hoisted(() => vi.fn());
const mockReadPending = vi.hoisted(() => vi.fn());
const mockClearPending = vi.hoisted(() => vi.fn(async () => undefined));
const mockBumpAttempt = vi.hoisted(() => vi.fn());
const mockAuditSinkEmit = vi.hoisted(() => vi.fn(async () => undefined));

// In-memory Redis stub — handles the SETNX lock + Lua release used by the
// sweep wrapper. The pending-entry hash + index are handled by the
// `@ibatexas/tools` mock above (mockList/Read/Clear).
const store = new Map<string, string>();
const mockRedisSet = vi.hoisted(() =>
  vi.fn(
    async (
      key: string,
      value: string,
      opts?: { EX?: number; NX?: boolean },
    ) => {
      if (opts?.NX === true) {
        if (store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }
      store.set(key, value);
      return "OK";
    },
  ),
);
const mockRedisEval = vi.hoisted(() =>
  vi.fn(
    async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
      const key = opts.keys[0]!;
      const expectedValue = opts.arguments[0]!;
      const stored = store.get(key);
      if (stored === expectedValue) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  ),
);

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    set: mockRedisSet,
    eval: mockRedisEval,
    // The retry-job module imports getRedisClient for its lock but the
    // listMedusa* / readMedusa* / clearMedusa* / bumpMedusa* helpers
    // also flow through this mock barrel.
  })),
  rk: (k: string) => `test:${k}`,
  listMedusaAnonymizePendingCustomerIds: mockListPending,
  readMedusaAnonymizePending: mockReadPending,
  clearMedusaAnonymizePending: mockClearPending,
  bumpMedusaAnonymizePendingAttempt: mockBumpAttempt,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: mockAuditSinkEmit }),
}));

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (s: { setTag: () => void; setLevel: () => void; setContext: () => void }) => void) =>
    cb({ setTag: vi.fn(), setLevel: vi.fn(), setContext: vi.fn() }),
  ),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("../queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// ── SUT ───────────────────────────────────────────────────────────────────

import { sweepMedusaAnonymizeRetry } from "../anonymize-medusa-retry.js";
import { MEDUSA_ANONYMIZE_MAX_ATTEMPTS } from "../../subscribers/__shared__/medusa-anonymize-kinds.js";

interface PendingEntry {
  customerId: string;
  medusaId: string;
  parkedIntentHash: string;
  parkedAt: string;
  firstEmittedAt: number;
  attempt: number;
  lastAttemptAt: number;
}

function makeEntry(overrides?: Partial<PendingEntry>): PendingEntry {
  const now = Date.now();
  return {
    customerId: "cust_retry",
    medusaId: "cus_med_retry",
    parkedIntentHash: "abcdef".padEnd(64, "0"),
    parkedAt: "2026-05-20T00:00:00.000Z",
    firstEmittedAt: now - 10 * 60_000,
    attempt: 1,
    lastAttemptAt: now - 10 * 60_000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("sweepMedusaAnonymizeRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it("empty pending index → no-op (no publish, no audit)", async () => {
    mockListPending.mockResolvedValueOnce([]);

    const outcomes = await sweepMedusaAnonymizeRetry();

    expect(outcomes).toEqual([]);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    expect(mockAuditSinkEmit).not.toHaveBeenCalled();
  });

  it("stale entry → bumps attempt + re-publishes pending NATS event", async () => {
    const entry = makeEntry({ attempt: 1 });
    mockListPending.mockResolvedValueOnce(["cust_retry"]);
    mockReadPending.mockResolvedValueOnce(entry);
    mockBumpAttempt.mockResolvedValueOnce({ ...entry, attempt: 2 });

    const outcomes = await sweepMedusaAnonymizeRetry();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("republished");
    expect(outcomes[0]!.attempt).toBe(2);

    expect(mockBumpAttempt).toHaveBeenCalledWith("cust_retry");
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
    const publishedSubject = mockPublishNatsEvent.mock.calls[0]![0];
    const publishedPayload = mockPublishNatsEvent.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(publishedSubject).toBe("customer.anonymize.medusa.pending");
    expect(publishedPayload.customerId).toBe("cust_retry");
    expect(publishedPayload.medusaId).toBe("cus_med_retry");
    expect(publishedPayload.attempt).toBe(2);
    expect(publishedPayload.parkedIntentHash).toBe(entry.parkedIntentHash);
    expect(publishedPayload.parkedAt).toBe(entry.parkedAt);
  });

  it("fresh entry (lastAttemptAt within MIN_AGE_BEFORE_RETRY_MS) → skipped", async () => {
    const now = Date.now();
    const entry = makeEntry({ lastAttemptAt: now - 30_000 }); // 30 s ago
    mockListPending.mockResolvedValueOnce(["cust_retry"]);
    mockReadPending.mockResolvedValueOnce(entry);

    const outcomes = await sweepMedusaAnonymizeRetry();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("skipped_not_stale");
    expect(mockBumpAttempt).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("attempt >= MEDUSA_ANONYMIZE_MAX_ATTEMPTS → emits exhausted audit; no publish", async () => {
    const entry = makeEntry({ attempt: MEDUSA_ANONYMIZE_MAX_ATTEMPTS });
    mockListPending.mockResolvedValueOnce(["cust_retry"]);
    mockReadPending.mockResolvedValueOnce(entry);

    const outcomes = await sweepMedusaAnonymizeRetry();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("exhausted");
    expect(outcomes[0]!.attempt).toBe(MEDUSA_ANONYMIZE_MAX_ATTEMPTS);

    // No retry publish.
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();

    // Exhausted audit record emitted with supersession.
    expect(mockAuditSinkEmit).toHaveBeenCalledTimes(1);
    const record = (mockAuditSinkEmit.mock.calls as unknown as Array<[unknown]>)[0]![0] as {
      envelope: { kind: string; payload: Record<string, unknown> };
      decision: { basis: Array<{ code: string; detail?: { rule?: string } }> };
      supersedes?: { predecessorIntentHash: string };
    };
    expect(record.envelope.kind).toBe(
      "customer.anonymize.medusa.exhausted",
    );
    expect(record.decision.basis[0]!.detail?.rule).toBe(
      "medusa_scrub_retry_exhausted",
    );
    expect(record.supersedes!.predecessorIntentHash).toBe(
      entry.parkedIntentHash,
    );
    // Payload carries no PII — UUID identifiers + attempts only.
    expect(record.envelope.payload).toEqual({
      customerId: "cust_retry",
      medusaId: "cus_med_retry",
      attempts: MEDUSA_ANONYMIZE_MAX_ATTEMPTS,
    });
  });

  it("missing per-entry hash → drops from index, returns 'missing'", async () => {
    mockListPending.mockResolvedValueOnce(["cust_gone"]);
    mockReadPending.mockResolvedValueOnce(null);

    const outcomes = await sweepMedusaAnonymizeRetry();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("missing");
    expect(mockClearPending).toHaveBeenCalledWith("cust_gone");
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("concurrent sweep loses the SETNX race → returns [] without iterating", async () => {
    // Pre-populate the lock as if another replica grabbed it.
    store.set("test:lock:anonymize-medusa-retry", "other-uuid");
    mockListPending.mockResolvedValue(["cust_retry"]);

    const outcomes = await sweepMedusaAnonymizeRetry();

    expect(outcomes).toEqual([]);
    expect(mockListPending).not.toHaveBeenCalled();
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  it("per-entry error does NOT break the sweep — continues to next customer", async () => {
    const okEntry = makeEntry({ customerId: "cust_ok" });
    mockListPending.mockResolvedValueOnce(["cust_throw", "cust_ok"]);
    mockReadPending
      .mockRejectedValueOnce(new Error("redis blip"))
      .mockResolvedValueOnce(okEntry);
    mockBumpAttempt.mockResolvedValueOnce({ ...okEntry, attempt: 2 });

    const outcomes = await sweepMedusaAnonymizeRetry();

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.kind).toBe("error");
    expect(outcomes[0]!.customerId).toBe("cust_throw");
    expect(outcomes[1]!.kind).toBe("republished");
    expect(outcomes[1]!.customerId).toBe("cust_ok");
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
  });
});
