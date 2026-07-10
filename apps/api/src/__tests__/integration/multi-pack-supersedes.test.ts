// W6-2 — Multi-pack supersedes chain (order.cancel → payment.refund.issue).
//
// Per audit/08-test-coverage-gaps.md item #5: "no test exercises a cancel
// that triggers a refund through the chain." This test composes two packs
// (pack-orders + pack-payments) in sequence:
//
//   1. Customer cancels a paid order → `order.cancel` envelope adjudicates
//      (pack-orders, EXECUTE).
//   2. On EXECUTE, the system publishes a follow-on `payment.refund.issue`
//      envelope (SYSTEM/TRUSTED actor, with supersedes pointing at the
//      cancel record's intentHash).
//   3. The refund envelope's kernel decision depends on magnitude:
//        - < R$500          → EXECUTE
//        - R$500 - R$1000   → REQUEST_CONFIRMATION
//        - > R$1000         → ESCALATE
//   4. Both audit records carry the chain: the refund's record.supersedes
//      points back to the cancel's intentHash (AuditRecord v3+).
//
// The test verifies the audit chain via buildAuditRecord (two records,
// linked via supersedes). supersedes lives on the AuditRecord, NOT the
// envelope — see @adjudicate/core/audit.ts §"Supersession".

import { describe, expect, it } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import {
  adjudicateAndAudit,
  buildAuditRecord,
  buildEnvelope,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  ordersPolicyBundle,
  type OrderIntentKind,
  type OrderPayload,
  type OrderState,
} from "@ibatexas/pack-orders";
import {
  paymentsPolicyBundle,
  type PaymentIntentKind,
  type PaymentPayload,
  type PaymentState,
} from "@ibatexas/pack-payments";

// ── Fixtures ──────────────────────────────────────────────────────────────

const DET_TIME = "2026-05-22T12:00:00.000Z";
const DET_AT = "2026-05-22T12:00:00.500Z";
const DET_REFUND_AT = "2026-05-22T12:00:00.750Z";

function orderEnv(
  kind: OrderIntentKind,
  payload: Record<string, unknown>,
  nonce: string,
): IntentEnvelope<OrderIntentKind, OrderPayload> {
  return buildEnvelope({
    kind,
    payload: payload as unknown as OrderPayload,
    actor: { principal: "user", sessionId: "cust_chain_01" },
    taint: "UNTRUSTED",
    nonce,
    createdAt: DET_TIME,
  });
}

function refundEnv(
  payload: Record<string, unknown>,
  nonce: string,
): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  return buildEnvelope({
    kind: "payment.refund.issue",
    payload: payload as unknown as PaymentPayload,
    actor: { principal: "system", sessionId: "system:refund-chain" },
    taint: "TRUSTED",
    nonce,
    createdAt: DET_TIME,
  });
}

function paidOrderState(amount: number): OrderState {
  return {
    ctx: {
      channel: "whatsapp",
      customerId: "cust_chain_01",
      cartId: null,
      orderId: "ord_chain_01",
      items: [
        { variantId: "v-1", quantity: 1, priceInCentavos: amount },
      ],
      fulfillment: "delivery",
      paymentMethod: "pix",
      paymentStatus: "paid",
      totalInCentavos: amount,
      lastAction: null,
    },
  };
}

// BKL-036 finding 2: a paid `order.cancel` NEVER silently EXECUTEs — it parks
// (REQUEST_CONFIRMATION). The realistic chain that reaches a refund is
// park → customer-confirm → cancel EXECUTE → refund. This helper asserts the
// park, then resumes the IDENTICAL envelope with a matching confirmationReceipt
// (the kernel's 2a override flips REQUEST_CONFIRMATION → EXECUTE while still
// re-running every guard), returning the EXECUTE decision that triggers the
// downstream refund.
async function confirmedPaidCancelDecision(
  cancelEnvelope: IntentEnvelope<OrderIntentKind, OrderPayload>,
  state: OrderState,
): Promise<Decision> {
  const parked = adjudicate(cancelEnvelope, state, ordersPolicyBundle);
  expect(parked.kind).toBe("REQUEST_CONFIRMATION");
  const { decision } = await adjudicateAndAudit(
    cancelEnvelope,
    state,
    ordersPolicyBundle,
    {
      sink: { emit: async () => {} },
      confirmationReceipt: { intentHash: cancelEnvelope.intentHash, at: DET_AT },
    },
  );
  return decision;
}

function refundPaymentState(
  amountInCentavos: number,
  refundedAmountCentavos: number,
): PaymentState {
  return {
    ctx: {
      actor: { principal: "system" },
      exists: true,
      isTerminal: false,
      currentStatus: "paid",
      refundedAmountCentavos,
      amountInCentavos,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Multi-pack supersedes chain (W6-2): order.cancel → payment.refund.issue", () => {
  it("small refund (< R$500): confirmed paid cancel EXECUTE → refund EXECUTE — audit chain linked", async () => {
    const orderAmount = 30_000; // R$300

    // ── Step 1: customer cancels paid order ──
    const cancelEnv = orderEnv(
      "order.cancel",
      { orderId: "ord_chain_01" },
      "n-cancel-small",
    );
    // BKL-036: the paid cancel parks, then EXECUTEs on confirm (helper).
    const orderDecision = await confirmedPaidCancelDecision(
      cancelEnv,
      paidOrderState(orderAmount),
    );
    expect(orderDecision.kind).toBe("EXECUTE");

    const originalIntentHash = cancelEnv.intentHash;
    expect(originalIntentHash).toMatch(/^[0-9a-f]+$/);

    // ── Step 2: system follows up with payment.refund.issue ──
    const followUpEnv = refundEnv(
      {
        paymentId: "pay_chain_01",
        refundAmountCentavos: orderAmount,
        refundableBalanceCentavos: orderAmount,
        amountInCentavos: orderAmount,
        currentRefundedCentavos: 0,
        actor: "system",
      },
      "n-refund-small",
    );
    const refundDecision = adjudicate(
      followUpEnv,
      refundPaymentState(orderAmount, 0),
      paymentsPolicyBundle,
    );
    expect(refundDecision.kind).toBe("EXECUTE");

    // ── Audit chain: 2 records, refund.supersedes → cancel.intentHash ──
    const cancelRecord = buildAuditRecord({
      envelope: cancelEnv,
      decision: orderDecision,
      durationMs: 1,
      at: DET_AT,
    });
    const refundRecord = buildAuditRecord({
      envelope: followUpEnv,
      decision: refundDecision,
      durationMs: 1,
      at: DET_REFUND_AT,
      supersedes: {
        predecessorIntentHash: cancelEnv.intentHash,
        predecessorAt: DET_AT,
        reason: "rewrite_executed",
      },
    });

    expect(cancelRecord.envelope.kind).toBe("order.cancel");
    expect(refundRecord.envelope.kind).toBe("payment.refund.issue");

    // The chain: refund.supersedes must point back to cancel.intentHash.
    expect(refundRecord.supersedes).toBeTruthy();
    expect(refundRecord.supersedes!.predecessorIntentHash).toBe(originalIntentHash);
    expect(refundRecord.supersedes!.predecessorAt).toBe(DET_AT);
    expect(refundRecord.supersedes!.reason).toBe("rewrite_executed");
  });

  it("mid refund (R$500-R$1000): refund REQUEST_CONFIRMATION", async () => {
    const orderAmount = 70_000; // R$700 — above R$500 confirm threshold.

    const cancelEnv = orderEnv(
      "order.cancel",
      { orderId: "ord_mid_01" },
      "n-cancel-mid",
    );
    // BKL-036: the paid cancel parks, then EXECUTEs on confirm (helper).
    const orderDecision = await confirmedPaidCancelDecision(
      cancelEnv,
      paidOrderState(orderAmount),
    );
    expect(orderDecision.kind).toBe("EXECUTE");

    const followUpEnv = refundEnv(
      {
        paymentId: "pay_mid_01",
        refundAmountCentavos: orderAmount,
        refundableBalanceCentavos: orderAmount,
        amountInCentavos: orderAmount,
        currentRefundedCentavos: 0,
        actor: "system",
      },
      "n-refund-mid",
    );
    const refundDecision = adjudicate(
      followUpEnv,
      refundPaymentState(orderAmount, 0),
      paymentsPolicyBundle,
    );
    expect(refundDecision.kind).toBe("REQUEST_CONFIRMATION");

    const refundRecord = buildAuditRecord({
      envelope: followUpEnv,
      decision: refundDecision,
      durationMs: 1,
      at: DET_REFUND_AT,
      supersedes: {
        predecessorIntentHash: cancelEnv.intentHash,
        predecessorAt: DET_AT,
        reason: "rewrite_executed",
      },
    });
    expect(refundRecord.supersedes!.predecessorIntentHash).toBe(cancelEnv.intentHash);
  });

  it("large refund (> R$1000): refund ESCALATE", async () => {
    // pack-orders ESCALATEs cancels >= R$1000 (CONFIRM_LARGE_TICKET_THRESHOLD).
    // We stage the cancel at a small amount (R$500) to keep that EXECUTE,
    // while the *refund magnitude* is large (R$1500) — modelling a
    // partial-refund scenario where the operator issues an extra refund
    // beyond the order total (e.g., goodwill compensation). The refund
    // pack's ESCALATE threshold is what we're pinning.
    const orderAmount = 50_000; // R$500, EXECUTE on cancel.
    const refundAmount = 150_000; // R$1500 — above the refund-pack escalate threshold.

    const cancelEnv = orderEnv(
      "order.cancel",
      { orderId: "ord_big_01" },
      "n-cancel-big",
    );
    // BKL-036: the paid cancel parks, then EXECUTEs on confirm (helper).
    const orderDecision = await confirmedPaidCancelDecision(
      cancelEnv,
      paidOrderState(orderAmount),
    );
    expect(orderDecision.kind).toBe("EXECUTE");

    const followUpEnv = refundEnv(
      {
        paymentId: "pay_big_01",
        refundAmountCentavos: refundAmount,
        refundableBalanceCentavos: refundAmount,
        amountInCentavos: refundAmount,
        currentRefundedCentavos: 0,
        actor: "system",
      },
      "n-refund-big",
    );
    const refundDecision = adjudicate(
      followUpEnv,
      refundPaymentState(refundAmount, 0),
      paymentsPolicyBundle,
    );
    expect(refundDecision.kind).toBe("ESCALATE");
    if (refundDecision.kind !== "ESCALATE") return;
    expect(refundDecision.to).toBe("human");

    const refundRecord = buildAuditRecord({
      envelope: followUpEnv,
      decision: refundDecision,
      durationMs: 1,
      at: DET_REFUND_AT,
      supersedes: {
        predecessorIntentHash: cancelEnv.intentHash,
        predecessorAt: DET_AT,
        reason: "rewrite_executed",
      },
    });
    expect(refundRecord.supersedes!.predecessorIntentHash).toBe(cancelEnv.intentHash);
  });

  it("audit chain genealogy: two records share a linked intentHash", async () => {
    // Pins the structural invariant the audit-postgres redundancy consumer
    // relies on: a refund row's `supersedes.predecessor_intent_hash`
    // points back to the parent cancel's intentHash, so a query like
    //   SELECT * FROM intent_audit
    //   WHERE supersedes_predecessor_intent_hash = '<hash>'
    // returns the entire genealogy in one shot.

    const cancelEnv = orderEnv(
      "order.cancel",
      { orderId: "ord_gen_01" },
      "n-cancel-gen",
    );
    // BKL-036: the paid cancel parks, then EXECUTEs on confirm (helper).
    const orderDecision = await confirmedPaidCancelDecision(
      cancelEnv,
      paidOrderState(15_000),
    );
    expect(orderDecision.kind).toBe("EXECUTE");

    const followUpEnv = refundEnv(
      {
        paymentId: "pay_gen_01",
        refundAmountCentavos: 15_000,
        refundableBalanceCentavos: 15_000,
        amountInCentavos: 15_000,
        currentRefundedCentavos: 0,
        actor: "system",
      },
      "n-refund-gen",
    );
    const refundDecision = adjudicate(
      followUpEnv,
      refundPaymentState(15_000, 0),
      paymentsPolicyBundle,
    );
    expect(refundDecision.kind).toBe("EXECUTE");

    const cancelRecord = buildAuditRecord({
      envelope: cancelEnv,
      decision: orderDecision,
      durationMs: 1,
      at: DET_AT,
    });
    const refundRecord = buildAuditRecord({
      envelope: followUpEnv,
      decision: refundDecision,
      durationMs: 1,
      at: DET_REFUND_AT,
      supersedes: {
        predecessorIntentHash: cancelEnv.intentHash,
        predecessorAt: DET_AT,
        reason: "rewrite_executed",
      },
    });

    // The parent has no supersedes (it's the root of the chain).
    expect(cancelRecord.supersedes).toBeUndefined();

    // The child carries the link.
    expect(refundRecord.supersedes).toBeTruthy();
    expect(refundRecord.supersedes!.predecessorIntentHash).toBe(cancelRecord.intentHash);

    // Both records have stable distinct hashes — deterministic replay
    // safety across the chain.
    expect(cancelRecord.intentHash).not.toBe(refundRecord.intentHash);
    expect(typeof cancelRecord.auditHash).toBe("string");
    expect(typeof refundRecord.auditHash).toBe("string");
  });
});
