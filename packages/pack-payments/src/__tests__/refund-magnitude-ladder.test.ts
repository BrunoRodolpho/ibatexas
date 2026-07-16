/**
 * @ibatexas/pack-payments — refund magnitude ladder dedicated tests.
 *
 * Boundary-condition coverage for the decision ladder:
 *   amount ≤ 0                            → REFUSE
 *   amount > refundable                   → REFUSE
 *   currentRefundedCentavos diverges      → REFUSE
 *   0 < amount ≤ R$500                    → EXECUTE
 *   R$500 < amount < R$1000               → REQUEST_CONFIRMATION
 *   amount ≥ R$1000                       → ESCALATE
 *
 * Mirrors the W3 P0-1 spec; this guard is now owned by pack-payments
 * (was domain-internal under `paymentProjectionPolicyBundle`).
 *
 * FE-T03/D2 (2026-07): the R$1000 boundary comparator flipped from strict
 * `>` to `>=`, so an EXACT R$1000 (100_000 centavos) refund now ESCALATEs
 * instead of parking at REQUEST_CONFIRMATION — see "ESCALATE: amount =
 * R$ 1.000" below.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  paymentsPolicyBundle,
  type PaymentIntentKind,
  type PaymentPayload,
  type PaymentState,
} from "../index.js"

function refundEnv(
  payload: Record<string, unknown>,
): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  return buildEnvelope({
    kind: "payment.refund.issue",
    payload: payload as unknown as PaymentPayload,
    actor: { principal: "user", sessionId: "staff:1" },
    taint: "TRUSTED",
    nonce: "n-refund",
    createdAt: "2026-05-22T12:00:00.000Z",
  })
}

function refundState(
  refundedAmountCentavos: number,
  amountInCentavos: number,
): PaymentState {
  return {
    ctx: {
      actor: { principal: "admin" },
      exists: true,
      isTerminal: false,
      currentStatus: "paid",
      refundedAmountCentavos,
      amountInCentavos,
    },
  }
}

describe("refund magnitude ladder", () => {
  it("REFUSE: amount ≤ 0 (zero)", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 0,
        refundableBalanceCentavos: 50_000,
        amountInCentavos: 50_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 50_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("REFUSE: amount > refundable", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 60_000,
        refundableBalanceCentavos: 50_000,
        amountInCentavos: 50_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 50_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("REFUSE: state-divergent refunded amount (concurrent refund)", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 10_000,
        refundableBalanceCentavos: 50_000,
        amountInCentavos: 50_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(25_000, 50_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("refund.state_divergent")
  })

  it("EXECUTE: amount = R$ 1,00 (1 centavo above zero)", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 100,
        refundableBalanceCentavos: 50_000,
        amountInCentavos: 50_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 50_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE: amount = R$ 500 (boundary inclusive)", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 50_000,
        refundableBalanceCentavos: 100_000,
        amountInCentavos: 100_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 100_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REQUEST_CONFIRMATION: amount = R$ 500,01 (just above confirm threshold)", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 50_001,
        refundableBalanceCentavos: 100_000,
        amountInCentavos: 100_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 100_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
  })

  it("REQUEST_CONFIRMATION: amount = R$ 999,99 (just below escalate threshold)", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 99_999,
        refundableBalanceCentavos: 200_000,
        amountInCentavos: 200_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 200_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
  })

  // FE-T03/D2: the R$1000 boundary comparator flipped from strict `>` to
  // `>=` (single-sourced via `isAtOrAboveMoneyBand`), so this exact-boundary
  // case moved from REQUEST_CONFIRMATION to ESCALATE. Regression pin for the
  // flip — before the flip this decision.kind was "REQUEST_CONFIRMATION".
  it("ESCALATE: amount = R$ 1.000 (boundary inclusive) — FE-T03/D2 flip", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 100_000,
        refundableBalanceCentavos: 200_000,
        amountInCentavos: 200_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 200_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("ESCALATE")
    if (decision.kind !== "ESCALATE") return
    expect(decision.to).toBe("human")
    // Audit record: the boundary case's decision carries the escalate
    // basis (reason + amount + threshold), not the confirm-band basis.
    expect(decision.basis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "business",
          detail: expect.objectContaining({
            reason: "refund_above_escalate_threshold",
            amount: 100_000,
            escalateThreshold: 100_000,
          }),
        }),
      ]),
    )
  })

  it("ESCALATE: amount = R$ 1.000,01 (just above escalate threshold)", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 100_001,
        refundableBalanceCentavos: 200_000,
        amountInCentavos: 200_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 200_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("ESCALATE")
  })

  it("ESCALATE: large refund (R$ 5.000)", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 500_000,
        refundableBalanceCentavos: 500_000,
        amountInCentavos: 500_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 500_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("ESCALATE")
    if (decision.kind !== "ESCALATE") return
    expect(decision.to).toBe("human")
  })

  it("EXECUTE: refund with prior partial refund (state aligned)", () => {
    // Customer had R$ 100 refunded already; now refunding another R$ 50.
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-1",
        refundAmountCentavos: 5_000,
        refundableBalanceCentavos: 40_000, // 50_000 - 10_000 prior
        amountInCentavos: 50_000,
        currentRefundedCentavos: 10_000,
        actor: "admin",
      }),
      refundState(10_000, 50_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})
