// Unit tests for the Wave-B Medusa anonymize resolver subscriber
// (audit-2026-05-24 H3 Wave B step 2).
//
// Coverage:
//   - Happy path: pending event → Medusa POST OK → confirmed audit emit
//     + Redis pending entry cleared.
//   - Failure path: Medusa throws → failed audit emit + Redis pending
//     entry left for the retry job.
//   - Missing-medusaId path: skipped without calling Medusa.
//   - Idempotency: same input twice doesn't change observable outcome.
//   - PII discipline: emitted audit records carry no name/email/phone.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockMedusaAdjudicated = vi.hoisted(() => vi.fn());
const mockRecordPending = vi.hoisted(() => vi.fn());
const mockClearPending = vi.hoisted(() => vi.fn());
const mockAuditSinkEmit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@ibatexas/nats-client", () => ({
  // Subscriber wires `subscribeNatsEvent`; we exercise the handler
  // directly, so subscribeNatsEvent is unused in tests.
  subscribeNatsEvent: vi.fn(),
  publishNatsEvent: vi.fn(),
}));

vi.mock("@ibatexas/tools", () => ({
  medusaAdjudicated: mockMedusaAdjudicated,
  recordMedusaAnonymizePending: mockRecordPending,
  clearMedusaAnonymizePending: mockClearPending,
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: mockAuditSinkEmit }),
}));

// ── SUT ───────────────────────────────────────────────────────────────────

import { handleMedusaAnonymizePending } from "../customer-anonymize-medusa-resolver.js";
import type { MedusaAnonymizePayload } from "../__shared__/medusa-anonymize-kinds.js";

function makePayload(
  overrides?: Partial<MedusaAnonymizePayload>,
): MedusaAnonymizePayload {
  return {
    customerId: "cust_wave_b",
    medusaId: "cus_med_01",
    parkedIntentHash: "0123abcdef".padEnd(64, "0"),
    parkedAt: "2026-05-22T00:00:00Z",
    attempt: 1,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("handleMedusaAnonymizePending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordPending.mockResolvedValue(undefined);
    mockClearPending.mockResolvedValue(undefined);
  });

  it("skipped on missing medusaId — does NOT touch Medusa or audit", async () => {
    const payload = makePayload({ medusaId: "" });
    const out = await handleMedusaAnonymizePending(payload);

    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") {
      expect(out.reason).toBe("missing_medusa_id");
    }
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled();
    expect(mockRecordPending).not.toHaveBeenCalled();
    expect(mockAuditSinkEmit).not.toHaveBeenCalled();
  });

  it("happy path: records pending → calls Medusa → clears pending → emits confirmed", async () => {
    mockMedusaAdjudicated.mockResolvedValueOnce({ customer: { id: "cus_med_01" } });

    const payload = makePayload();
    const out = await handleMedusaAnonymizePending(payload);

    expect(out.kind).toBe("confirmed");
    if (out.kind === "confirmed") {
      expect(out.customerId).toBe("cust_wave_b");
      expect(out.medusaId).toBe("cus_med_01");
    }

    // Pending entry recorded BEFORE Medusa call.
    expect(mockRecordPending).toHaveBeenCalledTimes(1);
    expect(mockRecordPending.mock.calls[0]![0]).toMatchObject({
      customerId: "cust_wave_b",
      medusaId: "cus_med_01",
      attempt: 1,
    });

    // Medusa POST to /admin/customers/:id with explicit nulls + metadata.
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = mockMedusaAdjudicated.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(args.scope).toBe("admin");
    expect(args.method).toBe("POST");
    expect(args.path).toBe("/admin/customers/cus_med_01");
    expect(args.idempotencyKey).toBe(
      `customer.anonymize.medusa.cus_med_01.${payload.parkedIntentHash}`,
    );
    const body = args.payload as Record<string, unknown>;
    expect(body.first_name).toBeNull();
    expect(body.last_name).toBeNull();
    expect(body.email).toBeNull();
    expect(body.phone).toBeNull();
    expect(body.company_name).toBeNull();
    expect(body.metadata).toEqual({ anonymized: true });

    // Pending entry cleared on success.
    expect(mockClearPending).toHaveBeenCalledTimes(1);
    expect(mockClearPending.mock.calls[0]![0]).toBe("cust_wave_b");

    // Confirmed audit record emitted with supersession back to the parked
    // anonymize envelope.
    expect(mockAuditSinkEmit).toHaveBeenCalledTimes(1);
    const record = (mockAuditSinkEmit.mock.calls as unknown as Array<[unknown]>)[0]![0] as {
      envelope: {
        kind: string;
        actor: { principal: string };
        taint: string;
        payload: Record<string, unknown>;
      };
      decision: { kind: string; basis: Array<{ detail?: { rule?: string } }> };
      supersedes?: {
        predecessorIntentHash: string;
        predecessorAt: string;
        reason: string;
      };
    };
    expect(record.envelope.kind).toBe("customer.anonymize.medusa.confirmed");
    expect(record.envelope.actor.principal).toBe("system");
    expect(record.envelope.taint).toBe("SYSTEM");
    expect(record.decision.kind).toBe("EXECUTE");
    expect(record.decision.basis[0]!.detail?.rule).toBe(
      "medusa_scrub_succeeded",
    );
    expect(record.supersedes).toBeTruthy();
    expect(record.supersedes!.predecessorIntentHash).toBe(
      payload.parkedIntentHash,
    );
    expect(record.supersedes!.predecessorAt).toBe(payload.parkedAt);
    expect(record.supersedes!.reason).toBe("defer_resumed");

    // PII discipline: audit payload carries non-PII identifiers only.
    expect(record.envelope.payload).toEqual({
      customerId: "cust_wave_b",
      medusaId: "cus_med_01",
      attempt: 1,
    });
    expect(record.envelope.payload).not.toHaveProperty("name");
    expect(record.envelope.payload).not.toHaveProperty("email");
    expect(record.envelope.payload).not.toHaveProperty("phone");
    expect(record.envelope.payload).not.toHaveProperty("cpf");
  });

  it("failure path: Medusa throws → emits failed audit; does NOT clear pending", async () => {
    mockMedusaAdjudicated.mockRejectedValueOnce(new Error("medusa 500"));

    const payload = makePayload();
    const out = await handleMedusaAnonymizePending(payload);

    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.err.message).toBe("medusa 500");
    }

    // Pending entry was recorded so the retry job can find it.
    expect(mockRecordPending).toHaveBeenCalledTimes(1);
    // Pending entry was NOT cleared — retry job must see it.
    expect(mockClearPending).not.toHaveBeenCalled();

    // failed audit record emitted with RULE_VIOLATED basis.
    expect(mockAuditSinkEmit).toHaveBeenCalledTimes(1);
    const record = (mockAuditSinkEmit.mock.calls as unknown as Array<[unknown]>)[0]![0] as {
      envelope: { kind: string };
      decision: { basis: Array<{ code: string; detail?: { rule?: string; errorMessage?: string } }> };
    };
    expect(record.envelope.kind).toBe("customer.anonymize.medusa.failed");
    expect(record.decision.basis[0]!.detail?.rule).toBe("medusa_scrub_failed");
    expect(record.decision.basis[0]!.detail?.errorMessage).toBe("medusa 500");
  });

  it("audit emit failure does NOT throw — destructive intent is already realized", async () => {
    mockMedusaAdjudicated.mockResolvedValueOnce({});
    mockAuditSinkEmit.mockRejectedValueOnce(new Error("audit sink down"));

    const payload = makePayload();
    const out = await handleMedusaAnonymizePending(payload);

    expect(out.kind).toBe("confirmed");
    expect(mockClearPending).toHaveBeenCalled();
  });

  it("idempotency: same payload twice produces stable Medusa idempotency-key", async () => {
    mockMedusaAdjudicated.mockResolvedValue({});

    const payload = makePayload();
    await handleMedusaAnonymizePending(payload);
    await handleMedusaAnonymizePending(payload);

    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(2);
    const args1 = mockMedusaAdjudicated.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    const args2 = mockMedusaAdjudicated.mock.calls[1]![0] as Record<
      string,
      unknown
    >;
    expect(args1.idempotencyKey).toBe(args2.idempotencyKey);
  });

  it("retry attempt is threaded into the audit payload", async () => {
    mockMedusaAdjudicated.mockResolvedValueOnce({});

    const payload = makePayload({ attempt: 4 });
    await handleMedusaAnonymizePending(payload);

    const record = (mockAuditSinkEmit.mock.calls as unknown as Array<[unknown]>)[0]![0] as {
      envelope: { payload: Record<string, unknown> };
      decision: { basis: Array<{ detail?: { attempt?: number } }> };
    };
    expect(record.envelope.payload.attempt).toBe(4);
    expect(record.decision.basis[0]!.detail?.attempt).toBe(4);
  });
});
