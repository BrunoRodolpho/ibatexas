// T3-7 — agent approvals glue (Stage-1 confirm-gated).
//
// Acceptance (plan-v2 §5 T3-7): parked agent envelope → approval → resolve →
// EXECUTE with intact chain. Runs the REAL kernel: the resume re-adjudicates the
// IDENTICAL envelope through adjudicateAndAudit carrying a confirmationReceipt,
// so a state that WOULD REQUEST_CONFIRMATION (confirmOnAutoResolve fires for
// payment.pix.regenerate) is substituted to EXECUTE — exactly the receipt
// semantics the customer checkout/confirm path uses. Provenance (DR-6):
// resolvedBy on the projection; lineage via verifyAgentConfirmLineage.

import { describe, expect, it, vi } from "vitest";
import {
  buildAuditRecord,
  buildEnvelope,
  type AuditRecord,
  type Decision,
} from "@adjudicate/core";
import type { PolicyBundle } from "@adjudicate/core/kernel";
import { paymentsPack } from "@ibatexas/pack-payments";
import { PIX_REMEDIATION_AGENT, agentSessionId } from "@ibatexas/agents";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import {
  ApprovalNotAgentEnvelopeError,
  createAgentApprovalEngine,
  deriveAgentApprovalOutcome,
  verifyAgentConfirmLineage,
  type ApprovalAuditSink,
} from "../claustrum/agent-approvals.js";

const NOW = "2026-06-12T12:00:00.000Z";
const ORDER = "ord_456";
const AGENT_SESSION = agentSessionId(PIX_REMEDIATION_AGENT, ORDER);

const paymentsBundle = buildIbatexasPolicyPacks([
  paymentsPack as unknown as ErasedPack,
])[0]!.policy as PolicyBundle<string, unknown, unknown>;

function agentRegenerateEnvelope() {
  return buildEnvelope({
    kind: "payment.pix.regenerate",
    payload: { orderId: ORDER },
    actor: { principal: "llm", sessionId: AGENT_SESSION },
    taint: "UNTRUSTED",
    nonce: "nonce-agent-approve",
  });
}

// State that the payments pack passes end-to-end, with the autoResolve flag set
// so confirmOnAutoResolveGuard returns REQUEST_CONFIRMATION WITHOUT a receipt —
// the receipt then substitutes EXECUTE (the exact thing under test).
function regenerateState() {
  return {
    ctx: {
      tenantId: "ibatexas",
      channel: "web",
      customerId: "cust_001",
      isAuthenticated: true,
      orderId: ORDER,
      exists: true,
      currentStatus: "payment_failed",
      currentMethod: "pix",
      isTerminal: false,
      refundedAmountCentavos: 0,
      amountInCentavos: 5_000,
      regenerationCount: 0,
      sessionTokensConsumed: 0,
      autoResolvedMoneyRef: true,
    },
  };
}

function capturingSink(): ApprovalAuditSink & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return { records, async emit(r) { records.push(r); } };
}

describe("createAgentApprovalEngine — request", () => {
  it("parks an agent envelope, notifies staff, returns a pending projection", async () => {
    const notify = vi.fn(async () => {});
    const engine = createAgentApprovalEngine({ notify, now: () => NOW, tokenFactory: () => "tok-1" });

    const req = await engine.request({
      envelope: agentRegenerateEnvelope(),
      prompt: "Regenerar cobrança PIX da falha de pagamento?",
    });

    expect(req).toMatchObject({
      token: "tok-1",
      agentNamespace: "agent:pix-payment-failure-remediation@0.1.0",
      intentKind: "payment.pix.regenerate",
      status: "pending",
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(engine.list({ status: "pending" })).toHaveLength(1);
  });

  it("rejects a non-agent envelope (the surface is agents-only)", async () => {
    const engine = createAgentApprovalEngine({ notify: async () => {}, now: () => NOW });
    const customerEnv = buildEnvelope({
      kind: "payment.pix.regenerate",
      payload: { orderId: ORDER },
      actor: { principal: "llm", sessionId: "cust_001" },
      taint: "UNTRUSTED",
      nonce: "n",
    });
    await expect(engine.request({ envelope: customerEnv, prompt: "x" })).rejects.toBeInstanceOf(
      ApprovalNotAgentEnvelopeError,
    );
  });
});

describe("T3-7 acceptance — parked agent envelope → approval → resolve → EXECUTE with intact chain", () => {
  it("resolve(accepted) re-adjudicates with a receipt → EXECUTE, records resolvedBy, lineage holds", async () => {
    const engine = createAgentApprovalEngine({
      notify: async () => {},
      now: () => NOW,
      tokenFactory: () => "tok-approve",
    });
    const envelope = agentRegenerateEnvelope();
    const req = await engine.request({ envelope, prompt: "Confirmar regeneração PIX?" });

    // The parked agent turn emitted a REQUEST_CONFIRMATION audit row (the
    // awaiting record). The resume's EXECUTE row supersedes it.
    const sink = capturingSink();
    const awaitingRecord = buildAuditRecord({
      envelope,
      decision: { kind: "REQUEST_CONFIRMATION", prompt: req.prompt, basis: [] },
      durationMs: 1,
      at: NOW,
    });

    const { request: resolved, decision } = await engine.resolve({
      token: "tok-approve",
      accepted: true,
      resolvedBy: { id: "staff_42", displayName: "Atendente" },
      rebuildState: () => regenerateState(),
      policyFor: () => paymentsBundle,
      sink,
    });

    // The receipt substituted EXECUTE for the would-be REQUEST_CONFIRMATION.
    expect(decision?.kind).toBe("EXECUTE");
    expect(resolved.status).toBe("approved");
    expect(resolved.resolvedBy).toEqual({ id: "staff_42", displayName: "Atendente" });

    // The audited resume emitted an EXECUTE row for the same intentHash.
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.envelope.intentHash).toBe(envelope.intentHash);
    expect(sink.records[0]!.decision.kind).toBe("EXECUTE");

    // INV-AGENT-CONFIRM-LINEAGE: awaiting RC + resumed EXECUTE + approver.
    const lineage = verifyAgentConfirmLineage(
      [awaitingRecord, ...sink.records],
      envelope.intentHash,
      engine.get("tok-approve"),
    );
    expect(lineage.ok, lineage.reasons.join("; ")).toBe(true);

    // Single-use: a second resolve of the same token fails.
    await expect(
      engine.resolve({
        token: "tok-approve",
        accepted: true,
        resolvedBy: { id: "staff_42" },
        rebuildState: () => regenerateState(),
        policyFor: () => paymentsBundle,
        sink,
      }),
    ).rejects.toThrow(/unknown, expired, or already resolved/);
  });

  it("resolve(rejected) marks rejected and never executes", async () => {
    const sink = capturingSink();
    const engine = createAgentApprovalEngine({
      notify: async () => {},
      now: () => NOW,
      tokenFactory: () => "tok-reject",
    });
    await engine.request({ envelope: agentRegenerateEnvelope(), prompt: "?" });

    const { request: resolved, decision } = await engine.resolve({
      token: "tok-reject",
      accepted: false,
      resolvedBy: { id: "staff_7" },
      rebuildState: () => regenerateState(),
      policyFor: () => paymentsBundle,
      sink,
    });

    expect(decision).toBeUndefined();
    expect(resolved.status).toBe("rejected");
    expect(resolved.resolvedBy).toEqual({ id: "staff_7" });
    expect(sink.records).toHaveLength(0); // never adjudicated/executed
  });
});

// ── BKL-104 — structured resolved-outcome contract ───────────────────────────
//
// deriveAgentApprovalOutcome is the shared honesty map (route response + the
// remediation-proposal mark read it). The anti-confabulation guarantee: ONLY an
// EXECUTE/REWRITE decision earns `executed`; every non-EXECUTE re-adjudication is
// reported with its kernel reason and NEVER as executed. `execute_failed` is
// deliberately NOT modeled — this engine carries no post-EXECUTE executor (that
// is the escalation-approval engine's concern), so it cannot produce that state.

describe("deriveAgentApprovalOutcome — honest map (BKL-104)", () => {
  const refuseDecision = (): Decision =>
    ({
      kind: "REFUSE",
      refusal: {
        kind: "STATE",
        code: "payment.already_terminal",
        userFacing: "Este pagamento já foi finalizado.",
      },
      basis: [],
    }) as Decision;

  it("accept:false → rejected (no decision, no reason)", () => {
    expect(deriveAgentApprovalOutcome(false, undefined)).toEqual({ status: "rejected" });
  });

  it("EXECUTE and REWRITE are the ONLY statuses that earn 'executed'", () => {
    expect(deriveAgentApprovalOutcome(true, { kind: "EXECUTE", basis: [] } as Decision)).toEqual({
      status: "executed",
      decisionKind: "EXECUTE",
    });
    const rewrite = {
      kind: "REWRITE",
      rewritten: agentRegenerateEnvelope(),
      reason: "normalized",
      basis: [],
    } as Decision;
    expect(deriveAgentApprovalOutcome(true, rewrite)).toEqual({
      status: "executed",
      decisionKind: "REWRITE",
    });
  });

  it("REFUSE → refused, sourcing reasonCode + pt-BR from the KERNEL refusal (not model output)", () => {
    expect(deriveAgentApprovalOutcome(true, refuseDecision())).toEqual({
      status: "refused",
      decisionKind: "REFUSE",
      reasonCode: "payment.already_terminal",
      refusalPtBr: "Este pagamento já foi finalizado.",
    });
  });

  it("REQUEST_CONFIRMATION → reparked (needs a fresh confirmation); reasonCode from the decision basis", () => {
    const dec = {
      kind: "REQUEST_CONFIRMATION",
      prompt: "Confirmar?",
      basis: [{ category: "business", code: "confirm_required" }],
    } as unknown as Decision;
    const out = deriveAgentApprovalOutcome(true, dec);
    expect(out.status).toBe("reparked");
    expect(out.decisionKind).toBe("REQUEST_CONFIRMATION");
    expect(out.reasonCode).toBe("confirm_required");
    expect(out.refusalPtBr).toMatch(/nova confirmação/i);
  });

  it("ESCALATE → escalated", () => {
    const dec = { kind: "ESCALATE", to: "human", reason: "acima do limite", basis: [] } as Decision;
    const out = deriveAgentApprovalOutcome(true, dec);
    expect(out.status).toBe("escalated");
    expect(out.decisionKind).toBe("ESCALATE");
    expect(out.refusalPtBr).toMatch(/escalação/i);
  });

  it("DEFER / a missing decision fail CLOSED to denied_by_kernel (never executed)", () => {
    const defer = { kind: "DEFER", signal: "payment.webhook", timeoutMs: 1000, basis: [] } as Decision;
    expect(deriveAgentApprovalOutcome(true, defer).status).toBe("denied_by_kernel");
    // accept:true always yields a decision in the engine; a missing one is an
    // invariant break and must NOT read as executed.
    expect(deriveAgentApprovalOutcome(true, undefined).status).toBe("denied_by_kernel");
  });

  it("ANTI-CONFABULATION: no non-EXECUTE/REWRITE decision ever earns 'executed'", () => {
    const nonExec: Decision[] = [
      refuseDecision(),
      { kind: "REQUEST_CONFIRMATION", prompt: "p", basis: [] } as Decision,
      { kind: "ESCALATE", to: "human", reason: "r", basis: [] } as Decision,
      { kind: "DEFER", signal: "s", timeoutMs: 1, basis: [] } as Decision,
    ];
    for (const d of nonExec) {
      expect(deriveAgentApprovalOutcome(true, d).status).not.toBe("executed");
    }
  });

  it("LIVE KERNEL: an accepted resolve on a since-moved state re-adjudicates NON-EXECUTE → derive reports honestly (not executed)", async () => {
    const sink = capturingSink();
    const engine = createAgentApprovalEngine({
      notify: async () => {},
      now: () => NOW,
      tokenFactory: () => "tok-stale",
    });
    await engine.request({ envelope: agentRegenerateEnvelope(), prompt: "?" });

    // The payment moved to a terminal/non-existent state since the agent parked
    // it — the kernel re-adjudication must NOT authorize EXECUTE.
    const movedState = () => ({ ctx: { ...regenerateState().ctx, exists: false } });
    const { decision } = await engine.resolve({
      token: "tok-stale",
      accepted: true,
      resolvedBy: { id: "staff_9" },
      rebuildState: movedState,
      policyFor: () => paymentsBundle,
      sink,
    });

    expect(decision?.kind).not.toBe("EXECUTE");
    const outcome = deriveAgentApprovalOutcome(true, decision);
    expect(outcome.status).not.toBe("executed");
    expect(["refused", "reparked", "escalated", "denied_by_kernel"]).toContain(outcome.status);
  });
});
