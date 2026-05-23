// Unit tests for the LGPD anonymize grace-resolver subscriber (task 14).
//
// Coverage:
//   - signal_mismatch → skipped
//   - no_pending_receipt → skipped (deletion was cancelled)
//   - pending receipt + grace expired → anonymize runs + receipt cleared
//   - anonymize throws → receipt left for retry, returns error outcome
//
// The grace resolver bridges `intent.defer.timeout` (published by the
// defer-timeout-sweeper task 03) to `anonymizeCustomer` for customer-
// initiated deletions whose 24h cancel window expired without a
// `customer.anonymize.cancel` arriving.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockAnonymizeCustomer = vi.hoisted(() => vi.fn());
const redisStorage = vi.hoisted(() => new Map<string, string>());
const mockRedisGet = vi.hoisted(() =>
  vi.fn(async (key: string) => redisStorage.get(key) ?? null),
);
const mockRedisDel = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    const had = redisStorage.has(key);
    redisStorage.delete(key);
    return had ? 1 : 0;
  }),
);

vi.mock("@ibatexas/domain", () => ({
  anonymizeCustomer: mockAnonymizeCustomer,
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({
    set: vi.fn(async () => "OK"),
    get: mockRedisGet,
    del: mockRedisDel,
  })),
  rk: (k: string) => `ibatexas:${k}`,
}));

vi.mock("twilio", () => ({
  default: () => ({}),
}));

// ── SUT ────────────────────────────────────────────────────────────────────

import { handleAnonymizeGraceTimeout } from "../anonymize-grace-resolver.js";
import { CUSTOMER_ANONYMIZE_GRACE_SIGNAL } from "@ibatexas/pack-customer-onboarding";

function makeEvent(overrides?: Partial<{ signal: string; sessionId: string; intentHash: string }>) {
  return {
    eventType: "intent.defer.timeout" as const,
    sessionId: overrides?.sessionId ?? "cust_01",
    intentHash: overrides?.intentHash ?? "abc123",
    signal: overrides?.signal ?? CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
    parkedAt: "2026-05-22T00:00:00Z",
    timestamp: "2026-05-23T00:00:00Z",
  };
}

function seedReceipt(customerId: string) {
  redisStorage.set(
    `ibatexas:anonymize:pending:${customerId}`,
    JSON.stringify({
      parkedAt: Date.now() - 24 * 60 * 60 * 1000,
      intentHash: "abc123",
      otpTokenHint: "12****",
    }),
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("handleAnonymizeGraceTimeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
  });

  it("skipped on signal_mismatch — other DEFER kinds share the timeout channel", async () => {
    const event = makeEvent({ signal: "payment.confirmed" });
    const out = await handleAnonymizeGraceTimeout(event);

    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") {
      expect(out.reason).toBe("signal_mismatch");
    }
    expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
  });

  it("skipped on no_pending_receipt — customer cancelled within the grace window", async () => {
    // No receipt in Redis — cancel-deletion already cleared it.
    const event = makeEvent();
    const out = await handleAnonymizeGraceTimeout(event);

    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") {
      expect(out.reason).toBe("no_pending_receipt");
    }
    expect(mockAnonymizeCustomer).not.toHaveBeenCalled();
  });

  it("anonymized on signal match + pending receipt — runs the destructive call + clears receipt", async () => {
    seedReceipt("cust_01");
    mockAnonymizeCustomer.mockResolvedValueOnce({ success: true });

    const event = makeEvent();
    const out = await handleAnonymizeGraceTimeout(event);

    expect(out.kind).toBe("anonymized");
    if (out.kind === "anonymized") {
      expect(out.customerId).toBe("cust_01");
      expect(out.intentHash).toBe("abc123");
    }
    expect(mockAnonymizeCustomer).toHaveBeenCalledWith("cust_01");
    // Receipt was cleared after anonymize.
    expect(redisStorage.get("ibatexas:anonymize:pending:cust_01")).toBeUndefined();
  });

  it("error outcome on anonymize throw — receipt is NOT cleared so next sweep retries", async () => {
    seedReceipt("cust_01");
    mockAnonymizeCustomer.mockRejectedValueOnce(new Error("prisma down"));

    const event = makeEvent();
    const out = await handleAnonymizeGraceTimeout(event);

    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.err.message).toBe("prisma down");
    }
    expect(mockAnonymizeCustomer).toHaveBeenCalledTimes(1);
    // Receipt is left in place for the next sweep.
    expect(redisStorage.get("ibatexas:anonymize:pending:cust_01")).toBeTruthy();
  });
});
