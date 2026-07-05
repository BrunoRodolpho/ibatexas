// AUT-017 — the escalation-approval engine resolve() outcomes + the lineage
// invariant. Uses the REAL @ibatexas/pack-payments bundle + REAL audited kernel
// (adjudicateAndAudit) with injected fakes for the park store / executors /
// projection, so the marker→CONFIRM→receipt→EXECUTE bridge is exercised for real.

import { describe, it, expect, vi } from "vitest";
import {
  buildEnvelope,
  type AuditRecord,
  type AuditSink,
  type IntentEnvelope,
} from "@adjudicate/core";
import { adjudicateAndAudit } from "@adjudicate/core/kernel";
import { paymentsPolicyBundle } from "@ibatexas/pack-payments";
import {
  createEscalationApprovalEngine,
  verifyEscalationApprovalLineage,
  type EscalationApprovalEngineDeps,
} from "../escalation-approval.js";
import type { ParkedEscalationIntent } from "../escalation-park-store.js";
import type { PendingEscalationIntent } from "../escalation-store.js";

const AT = "2026-07-04T12:00:00.000Z";
const PROPOSER = "owner_proposer";
const APPROVER = "owner_approver";

function makeCapturingSink(): AuditSink & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return { emit: async (r: AuditRecord) => void records.push(r), records };
}

const REFUND_PAYLOAD = {
  paymentId: "pay_1",
  refundAmountCentavos: 150_000,
  refundableBalanceCentavos: 500_000,
  amountInCentavos: 500_000,
  currentRefundedCentavos: 0,
  actor: "admin",
  actorId: PROPOSER,
};

// The intentHash the engine's rebuild MUST reproduce (FIX 3 integrity gate). Built
// from the EXACT inputs the engine rebuilds with (kind/payload/actor/role/taint/nonce).
const REBUILT_INTENT_HASH = buildEnvelope({
  kind: "payment.refund.issue",
  payload: REFUND_PAYLOAD,
  actor: { principal: "user", sessionId: "admin:owner_proposer", role: "OWNER" },
  taint: "UNTRUSTED",
  nonce: "n-escalate-approve",
}).intentHash;

/** The parked escalated (>R$1000) refund proposed by PROPOSER. */
function parkedRefund(
  overrides: Partial<ParkedEscalationIntent> = {},
): ParkedEscalationIntent {
  return {
    token: "tok-1",
    sessionId: "admin:owner_proposer",
    intentKind: "payment.refund.issue",
    intentHash: REBUILT_INTENT_HASH,
    summaryPtBr: "reembolso de R$ 1.500,00",
    proposerId: PROPOSER,
    envelopeKind: "payment.refund.issue",
    payload: REFUND_PAYLOAD,
    nonce: "n-escalate-approve",
    actorSessionId: "admin:owner_proposer",
    actorPrincipal: "user",
    actorRole: "OWNER",
    taint: "UNTRUSTED",
    requestedAt: AT,
    ...overrides,
  };
}

/** A fresh live refund state (R$5000 balance, none refunded) — the marker is added by the engine. */
function freshRefundState(): unknown {
  return {
    ctx: {
      actor: { principal: "admin" },
      exists: true,
      isTerminal: false,
      currentStatus: "paid",
      refundedAmountCentavos: 0,
      amountInCentavos: 500_000,
    },
  };
}

function makeEngine(
  parked: ParkedEscalationIntent,
  overrides: Partial<EscalationApprovalEngineDeps> = {},
) {
  let consumed = false;
  const marks: Array<{ status: string; resolvedBy: string; intentHash: string }> = [];
  const refundExec = vi.fn(async (_payload: unknown, _approverStaffId: string) => {});
  const sink = makeCapturingSink();
  const deps: EscalationApprovalEngineDeps = {
    get: async (t) => (t === parked.token ? parked : null),
    consume: async (t) => {
      if (t === parked.token && !consumed) {
        consumed = true;
        return parked;
      }
      return null;
    },
    rebuildState: async () => freshRefundState(),
    policyFor: () => paymentsPolicyBundle as never,
    sink,
    executors: { "payment.refund.issue": refundExec },
    markIntentResolved: async (_s, intentHash, status, resolvedBy) => {
      marks.push({ status, resolvedBy, intentHash });
      return null;
    },
    now: () => AT,
    ...overrides,
  };
  return { engine: createEscalationApprovalEngine(deps), refundExec, sink, marks };
}

describe("AUT-017 escalation-approval engine — resolve()", () => {
  it("OWNER approve (approver ≠ proposer) → EXECUTE, runs the refund executor once with the approver as author", async () => {
    const { engine, refundExec, sink, marks } = makeEngine(parkedRefund());
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(result.status).toBe("approved");
    expect(result.decision?.kind).toBe("EXECUTE");
    // The executor ran ONCE, with the PARKED payload + the APPROVER as author.
    expect(refundExec).toHaveBeenCalledTimes(1);
    expect(refundExec.mock.calls[0]![1]).toBe(APPROVER);
    // The audited EXECUTE carries the confirmation_resolved supersession + approver binding.
    const exec = sink.records.at(-1)!;
    expect(exec.decision.kind).toBe("EXECUTE");
    expect(exec.supersedes?.reason).toBe("confirmation_resolved");
    expect(exec.supersedes?.binding).toMatchObject({ approver: `staff:${APPROVER}` });
    // The projection was marked approved.
    expect(marks.at(-1)?.status).toBe("approved");
  });

  it("reject (accept=false) → nothing executes, projection rejected", async () => {
    const { engine, refundExec, marks } = makeEngine(parkedRefund());
    const result = await engine.resolve({
      token: "tok-1",
      accept: false,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(result.status).toBe("rejected");
    expect(refundExec).not.toHaveBeenCalled();
    expect(marks.at(-1)?.status).toBe("rejected");
  });

  it("self-approval (approver === proposer) → self_approve WITHOUT consuming the token", async () => {
    const parked = parkedRefund();
    let consumeCalls = 0;
    const { engine, refundExec } = makeEngine(parked, {
      consume: async () => {
        consumeCalls += 1;
        return parked;
      },
    });
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: PROPOSER, role: "OWNER" }, // same as proposer
    });
    expect(result.status).toBe("self_approve");
    expect(consumeCalls).toBe(0); // token NOT burned — a different owner can still approve
    expect(refundExec).not.toHaveBeenCalled();
  });

  it("replayed token → missing (single-use consume), nothing executes", async () => {
    const { engine, refundExec } = makeEngine(parkedRefund());
    const first = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(first.status).toBe("approved");
    // A second resolve of the same token finds nothing (already consumed).
    const second = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(second.status).toBe("missing");
    expect(refundExec).toHaveBeenCalledTimes(1); // still exactly once
  });

  it("unknown token → missing", async () => {
    const { engine } = makeEngine(parkedRefund());
    const result = await engine.resolve({
      token: "nope",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(result.status).toBe("missing");
  });

  it("since-parked partial refund (state divergence) → denied_by_kernel, nothing executes", async () => {
    // The live state now shows R$250 already refunded while the parked payload
    // said 0 → the magnitude guard's divergence check REFUSEs on resume.
    const { engine, refundExec, marks } = makeEngine(parkedRefund(), {
      rebuildState: async () => ({
        ctx: {
          actor: { principal: "admin" },
          exists: true,
          isTerminal: false,
          currentStatus: "paid",
          refundedAmountCentavos: 25_000, // diverged from payload's 0
          amountInCentavos: 500_000,
        },
      }),
    });
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(result.status).toBe("denied_by_kernel");
    expect(result.decision?.kind).toBe("REFUSE");
    expect(refundExec).not.toHaveBeenCalled();
    expect(marks.at(-1)?.status).toBe("denied_by_kernel");
    expect(result.refusalPtBr).toBeTruthy();
  });

  it("payment vanished since parking (state null → exists:false) → denied_by_kernel (fail-closed)", async () => {
    const { engine, refundExec } = makeEngine(parkedRefund(), {
      rebuildState: async () => ({ ctx: { exists: false } }),
    });
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(result.status).toBe("denied_by_kernel");
    expect(refundExec).not.toHaveBeenCalled();
  });

  it("executor throw AFTER the audited EXECUTE → execute_failed; projection marked execute_failed, NOT approved (FIX 4)", async () => {
    const { engine, sink, marks } = makeEngine(parkedRefund(), {
      executors: {
        "payment.refund.issue": vi.fn(async () => {
          throw new Error("payment service unavailable");
        }),
      },
    });
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(result.status).toBe("execute_failed");
    expect(result.refusalPtBr).toBeTruthy();
    // The EXECUTE was still audited (the governance decision happened), but NO
    // money moved → the projection is marked execute_failed (honest), never approved.
    expect(sink.records.at(-1)?.decision.kind).toBe("EXECUTE");
    expect(marks.at(-1)?.status).toBe("execute_failed");
  });

  it("no executor registered for the kind → execute_failed, projection execute_failed (FIX 4)", async () => {
    const { engine, marks } = makeEngine(parkedRefund(), { executors: {} });
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(result.status).toBe("execute_failed");
    expect(marks.at(-1)?.status).toBe("execute_failed");
  });

  it("projection-write failure AFTER a committed refund → still approved (success-with-warning), never a bare error (FIX 4b)", async () => {
    const refundExec = vi.fn(async (_p: unknown, _s: string) => {});
    let calls = 0;
    const engine = makeEngine(parkedRefund(), {
      executors: { "payment.refund.issue": refundExec },
      // The post-commit "approved" projection write throws (Redis blip); the
      // committed refund must NOT become a bare failure with a re-runnable button.
      markIntentResolved: async () => {
        calls += 1;
        throw new Error("redis unavailable");
      },
    }).engine;
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(result.status).toBe("approved"); // money moved → success
    expect(refundExec).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1); // the projection write was attempted (and swallowed)
  });

  it("FIX 3 — a parked record whose stored intentHash diverges from the rebuild → denied_by_kernel, token consumed, NO execute", async () => {
    let consumeCalls = 0;
    const parked = parkedRefund({ intentHash: "sha256:tampered-does-not-match" });
    const { engine, refundExec } = makeEngine(parked, {
      consume: async () => {
        consumeCalls += 1;
        return parked;
      },
    });
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(result.status).toBe("denied_by_kernel");
    expect(result.decision).toBeUndefined(); // never reached adjudication
    expect(refundExec).not.toHaveBeenCalled();
    expect(consumeCalls).toBe(1); // token WAS consumed (single-use burned on the integrity failure)
  });

  it("FIX 5 — the execution ledger is threaded: a ledger HIT (duplicate intentHash) → REPLAY_SUPPRESSED, no refund", async () => {
    const hitLedger = {
      checkLedger: async () => ({
        resourceVersion: "",
        at: AT,
        sessionId: "admin:owner_proposer",
        kind: "payment.refund.issue",
      }),
      recordExecution: async () => "acquired" as const,
    };
    const { engine, refundExec } = makeEngine(parkedRefund(), {
      ledger: hitLedger,
    });
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
    });
    // The kernel short-circuited to REPLAY_SUPPRESSED (a REFUSE) → non-EXECUTE.
    expect(result.status).toBe("denied_by_kernel");
    expect(result.decision?.kind).not.toBe("EXECUTE");
    expect(refundExec).not.toHaveBeenCalled();
  });

  it("FIX 6 — a token used against the WRONG session path → missing, token NOT consumed (IDOR hardening)", async () => {
    let consumeCalls = 0;
    const parked = parkedRefund(); // sessionId "admin:owner_proposer"
    const { engine, refundExec } = makeEngine(parked, {
      consume: async () => {
        consumeCalls += 1;
        return parked;
      },
    });
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
      expectedSessionId: "admin:someone_else", // mismatched session
    });
    expect(result.status).toBe("missing");
    expect(consumeCalls).toBe(0); // NOT burned
    expect(refundExec).not.toHaveBeenCalled();
  });

  it("FIX 6 — a matching session path passes the binding check (approves)", async () => {
    const { engine } = makeEngine(parkedRefund());
    const result = await engine.resolve({
      token: "tok-1",
      accept: true,
      approver: { id: APPROVER, role: "OWNER" },
      expectedSessionId: "admin:owner_proposer", // matches parked.sessionId
    });
    expect(result.status).toBe("approved");
  });
});

describe("AUT-017 — verifyEscalationApprovalLineage", () => {
  /** Produce a REAL ESCALATE row + a REAL resumed EXECUTE row for one intentHash. */
  async function escalateThenResume(): Promise<{
    records: AuditRecord[];
    intentHash: string;
  }> {
    const sink = makeCapturingSink();
    const env = buildEnvelope({
      kind: "payment.refund.issue",
      payload: {
        paymentId: "pay_1",
        refundAmountCentavos: 150_000,
        refundableBalanceCentavos: 500_000,
        amountInCentavos: 500_000,
        currentRefundedCentavos: 0,
        actor: "admin",
        actorId: PROPOSER,
      },
      actor: { principal: "user", sessionId: `admin:${PROPOSER}`, role: "OWNER" },
      taint: "UNTRUSTED",
      nonce: "n-lineage",
      createdAt: AT,
    }) as IntentEnvelope;
    // 1) ESCALATE — the original above-threshold verdict (no marker).
    await adjudicateAndAudit(env, freshRefundState() as never, paymentsPolicyBundle as never, {
      sink,
    });
    // 2) Resumed EXECUTE — marker + matching receipt.
    const marked = {
      ctx: {
        ...(freshRefundState() as { ctx: Record<string, unknown> }).ctx,
        escalationApproval: {
          intentHash: env.intentHash,
          approverId: APPROVER,
          approverRole: "OWNER",
          at: AT,
        },
      },
    };
    await adjudicateAndAudit(env, marked as never, paymentsPolicyBundle as never, {
      sink,
      confirmationReceipt: {
        intentHash: env.intentHash,
        at: AT,
        token: "tok-1",
        binding: { approver: { confirmed: `staff:${APPROVER}` } },
      },
    });
    return { records: sink.records, intentHash: env.intentHash };
  }

  const approvedProjection: PendingEscalationIntent = {
    token: "tok-1",
    intentKind: "payment.refund.issue",
    intentHash: "sha256:x",
    summaryPtBr: "reembolso de R$ 1.500,00",
    requestedAt: AT,
    status: "approved",
    resolvedBy: `staff:${APPROVER}`,
  };

  it("ok when ESCALATE + resumed EXECUTE + an approved projection with resolvedBy all present", async () => {
    const { records, intentHash } = await escalateThenResume();
    // Sanity: both verdicts were actually produced for this intentHash.
    const kinds = records
      .filter((r) => r.envelope.intentHash === intentHash)
      .map((r) => r.decision.kind);
    expect(kinds).toContain("ESCALATE");
    expect(kinds).toContain("EXECUTE");
    const res = verifyEscalationApprovalLineage(records, intentHash, {
      ...approvedProjection,
      intentHash,
    });
    expect(res.ok).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it("fails when the projection is missing resolvedBy (the approver provenance)", async () => {
    const { records, intentHash } = await escalateThenResume();
    const res = verifyEscalationApprovalLineage(records, intentHash, {
      ...approvedProjection,
      intentHash,
      resolvedBy: undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toContain("resolvedBy");
  });

  it("FIX 4 — fails when the projection is execute_failed (money never moved), even with a resumed EXECUTE row", async () => {
    // The kernel EXECUTEd (the audit row exists) but the executor failed → the
    // projection is execute_failed. Lineage must NOT bless it as an approved refund.
    const { records, intentHash } = await escalateThenResume();
    const res = verifyEscalationApprovalLineage(records, intentHash, {
      ...approvedProjection,
      intentHash,
      status: "execute_failed",
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toContain("not approved");
  });

  it("fails when there is no resumed EXECUTE record (approve never executed)", async () => {
    const { records, intentHash } = await escalateThenResume();
    const escalateOnly = records.filter((r) => r.decision.kind === "ESCALATE");
    const res = verifyEscalationApprovalLineage(escalateOnly, intentHash, {
      ...approvedProjection,
      intentHash,
    });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toContain("EXECUTE");
  });

  it("fails when the projection is null", async () => {
    const { records, intentHash } = await escalateThenResume();
    const res = verifyEscalationApprovalLineage(records, intentHash, null);
    expect(res.ok).toBe(false);
  });
});
