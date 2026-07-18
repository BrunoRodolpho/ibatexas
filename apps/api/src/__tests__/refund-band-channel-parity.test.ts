// FE-D07 — cross-bundle refund-band channel parity.
//
// The refund-magnitude decision ladder is adjudicated on TWO channels:
//   - ops / WhatsApp        → `@ibatexas/pack-payments`' `paymentsPolicyBundle`
//   - admin-HTTP panel      → `@ibatexas/domain`'s `paymentProjectionPolicyBundle`
//
// FE-T03/D2 flipped BOTH escalate comparators to `>=` in lockstep, but the
// comparator + band-boundary logic stayed byte-parallel in each guard, so the
// money bands could still fork by channel if one site were edited and the
// other not. FE-D07 single-sourced the EXECUTE / CONFIRM / ESCALATE mapping in
// `@ibatexas/types.classifyRefundMagnitudeBand`, imported by both bundles.
//
// This test pins the parity DIRECTLY — it drives the SAME refund amount through
// BOTH real bundles and asserts identical decision kinds, with the exact R$1000
// (100_000 centavos) boundary as the load-bearing case (both must ESCALATE) and
// R$999,99 (99_999) as the falsifier (both must REQUEST_CONFIRMATION). A future
// edit that forks one channel's boundary fails here.

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

/** Refund payload shared verbatim by both bundles (structurally identical). */
function refundPayload(refundAmountCentavos: number): Record<string, unknown> {
  return {
    paymentId: "p-parity-1",
    refundAmountCentavos,
    refundableBalanceCentavos: 1_000_000,
    amountInCentavos: 1_000_000,
    currentRefundedCentavos: 0,
    actor: "admin",
  };
}

/** TRUSTED staff-authored refund — passes both taint policies, and (TRUSTED)
 *  deliberately avoids the pack-payments BKL-085 UNTRUSTED overlay so the
 *  comparison isolates the shared band classifier. */
function opsEnv(
  refundAmountCentavos: number,
): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  return buildEnvelope({
    kind: "payment.refund.issue",
    payload: refundPayload(refundAmountCentavos) as unknown as PaymentPayload,
    actor: { principal: "user", sessionId: "staff:1" },
    taint: "TRUSTED",
    nonce: "n-ops",
    createdAt: "2026-07-17T12:00:00.000Z",
  });
}

function adminEnv(
  refundAmountCentavos: number,
): IntentEnvelope<PaymentProjectionIntentKind, PaymentProjectionPayload> {
  return buildEnvelope({
    kind: "payment.refund.issue",
    payload: refundPayload(
      refundAmountCentavos,
    ) as unknown as PaymentProjectionPayload,
    actor: { principal: "user", sessionId: "staff:1" },
    taint: "TRUSTED",
    nonce: "n-admin",
    createdAt: "2026-07-17T12:00:00.000Z",
  });
}

const opsState: PaymentState = {
  ctx: {
    actor: { principal: "admin" },
    exists: true,
    isTerminal: false,
    currentStatus: "paid",
    refundedAmountCentavos: 0,
    amountInCentavos: 1_000_000,
  },
};

const adminState: PaymentProjectionState = {
  ctx: {
    exists: true,
    isTerminal: false,
    currentStatus: "paid",
    refundedAmountCentavos: 0,
    amountInCentavos: 1_000_000,
  },
};

function opsDecisionKind(amount: number): string {
  return adjudicate(opsEnv(amount), opsState, paymentsPolicyBundle).kind;
}

function adminDecisionKind(amount: number): string {
  return adjudicate(adminEnv(amount), adminState, paymentProjectionPolicyBundle)
    .kind;
}

describe("FE-D07 refund-band channel parity (ops vs admin-HTTP)", () => {
  it("exact R$1000 (100_000) ESCALATEs on BOTH channels — the FE-T03/D2 boundary", () => {
    expect(opsDecisionKind(100_000)).toBe("ESCALATE");
    expect(adminDecisionKind(100_000)).toBe("ESCALATE");
    // Explicit parity assertion — the two channels must never diverge here.
    expect(opsDecisionKind(100_000)).toBe(adminDecisionKind(100_000));
  });

  it("R$999,99 (99_999) REQUEST_CONFIRMATION on BOTH channels — the falsifier", () => {
    expect(opsDecisionKind(99_999)).toBe("REQUEST_CONFIRMATION");
    expect(adminDecisionKind(99_999)).toBe("REQUEST_CONFIRMATION");
    expect(opsDecisionKind(99_999)).toBe(adminDecisionKind(99_999));
  });

  it("full-ladder parity across every band boundary", () => {
    // amount → the band both channels must agree on.
    const cases: ReadonlyArray<readonly [number, string]> = [
      [100, "EXECUTE"], // R$1
      [50_000, "EXECUTE"], // R$500 — confirm-band inclusive lower edge
      [50_001, "REQUEST_CONFIRMATION"], // just above confirm threshold
      [99_999, "REQUEST_CONFIRMATION"], // just below escalate
      [100_000, "ESCALATE"], // exact R$1000 (FE-T03/D2)
      [100_001, "ESCALATE"], // just above escalate
      [500_000, "ESCALATE"], // R$5000
    ];
    for (const [amount, expected] of cases) {
      expect(opsDecisionKind(amount), `ops @ ${amount}`).toBe(expected);
      expect(adminDecisionKind(amount), `admin @ ${amount}`).toBe(expected);
    }
  });
});
