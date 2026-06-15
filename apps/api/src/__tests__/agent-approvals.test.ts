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
