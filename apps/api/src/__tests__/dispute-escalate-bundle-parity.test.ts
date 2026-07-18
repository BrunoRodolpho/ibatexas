// BKL-178 / FE-D07 — cross-bundle dispute-escalate parity.
//
// `payment.dispute.open` is adjudicated on the webhook path against the DOMAIN
// projection bundle (`@ibatexas/domain`'s `paymentProjectionPolicyBundle`), whose
// `escalateAlwaysOnDispute` guard is a behavior-parity MIRROR of the pack twin in
// `@ibatexas/pack-payments`' `paymentsPolicyBundle`. The two guards are
// byte-parallel, so a future edit to one could silently fork the dispute
// decision by bundle — exactly the FE-D07 hazard the refund-band-channel-parity
// test pins for the refund ladder.
//
// This pins the pair DIRECTLY: it drives the SAME `payment.dispute.open` envelope
// through BOTH real bundles and asserts an identical ESCALATE decision — kind,
// audience ("human"), and reason ("dispute_opened_requires_review"). A future
// edit that forks one bundle's dispute routing fails here. (When the eventual
// promote-wave single-sources the guard — the #289 `classifyRefundMagnitudeBand`
// shape — this test becomes the migration's safety net.)

import { describe, expect, it } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import {
  paymentsPolicyBundle,
  type PaymentIntentKind,
  type PaymentPayload,
  type PaymentState,
} from "@ibatexas/pack-payments";
import {
  paymentProjectionPolicyBundle,
  type PaymentProjectionIntentKind,
  type PaymentProjectionPayload,
  type PaymentProjectionState,
} from "@ibatexas/domain";

/** The dispute.open payload shared verbatim by both bundles (structurally
 *  identical: paymentId + stripeEventId + disputeAmountCentavos). */
function disputePayload(): Record<string, unknown> {
  return {
    paymentId: "p-dispute-parity-1",
    stripeEventId: "evt_dispute_parity",
    disputeAmountCentavos: 8900,
  };
}

/** The exact system-actor webhook envelope: SYSTEM taint satisfies BOTH the
 *  pack's TRUSTED minimum and the domain's systemOnly restriction; nonce =
 *  event.id per the finalized spec. */
function packEnv(): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  return buildEnvelope({
    kind: "payment.dispute.open",
    payload: disputePayload() as unknown as PaymentPayload,
    actor: { principal: "system", sessionId: "stripe-webhook:evt_dispute_parity" },
    taint: "SYSTEM",
    nonce: "evt_dispute_parity",
    createdAt: "2026-07-18T12:00:00.000Z",
  });
}

function domainEnv(): IntentEnvelope<
  PaymentProjectionIntentKind,
  PaymentProjectionPayload
> {
  return buildEnvelope({
    kind: "payment.dispute.open",
    payload: disputePayload() as unknown as PaymentProjectionPayload,
    actor: { principal: "system", sessionId: "stripe-webhook:evt_dispute_parity" },
    taint: "SYSTEM",
    nonce: "evt_dispute_parity",
    createdAt: "2026-07-18T12:00:00.000Z",
  });
}

// Both guards require the Payment row to exist (the webhook resolves it before
// minting the envelope) — a DISPUTED, non-terminal-for-this-kind snapshot.
const packState: PaymentState = {
  ctx: {
    actor: { principal: "system" },
    exists: true,
    isTerminal: false,
    currentStatus: "disputed",
    refundedAmountCentavos: 0,
    amountInCentavos: 8900,
  },
};

const domainState: PaymentProjectionState = {
  ctx: {
    exists: true,
    isTerminal: false,
    currentStatus: "disputed",
    refundedAmountCentavos: 0,
    amountInCentavos: 8900,
  },
};

describe("BKL-178/FE-D07 dispute-escalate bundle parity (domain mirror vs pack twin)", () => {
  it("payment.dispute.open ESCALATEs identically through BOTH bundles", () => {
    const packDecision = adjudicate(packEnv(), packState, paymentsPolicyBundle);
    const domainDecision = adjudicate(
      domainEnv(),
      domainState,
      paymentProjectionPolicyBundle,
    );

    // Each bundle escalates to a human with the shared reason.
    expect(packDecision.kind).toBe("ESCALATE");
    expect(domainDecision.kind).toBe("ESCALATE");
    if (
      packDecision.kind === "ESCALATE" &&
      domainDecision.kind === "ESCALATE"
    ) {
      expect(packDecision.to).toBe("human");
      expect(domainDecision.to).toBe("human");
      expect(packDecision.reason).toBe("dispute_opened_requires_review");
      expect(domainDecision.reason).toBe("dispute_opened_requires_review");
    }

    // Explicit cross-bundle parity — the byte-parallel pair must never diverge.
    expect(domainDecision.kind).toBe(packDecision.kind);
    if (
      packDecision.kind === "ESCALATE" &&
      domainDecision.kind === "ESCALATE"
    ) {
      expect(domainDecision.to).toBe(packDecision.to);
      expect(domainDecision.reason).toBe(packDecision.reason);
    }
  });
});
