/**
 * NEW-P0-X6 — NaN refund passes every gate.
 *
 * Test exercises `refundMagnitudeGuard` directly (via the public
 * `paymentsPolicyBundle`) with `refundAmountCentavos: NaN`. Because
 * `typeof NaN === "number"` and every `NaN > x` and `NaN <= 0` comparison
 * returns `false`, every gate in the existing ladder evaluates to
 * "amount is OK" and the kernel falls through to EXECUTE.
 *
 * Defense (two layers, after the audit-2026-05-27 kernel hardening):
 *   1. Non-finite amounts (NaN / ±Infinity) are now rejected at the
 *      content-addressing boundary: canonical-JSON (RFC 8785 §3.2.2.3) has
 *      no representation for a non-finite number, so `buildEnvelope()` THROWS
 *      before the payload can ever be adjudicated. NEW-P0-X6 ("NaN refund must
 *      never reach EXECUTE") is therefore upheld *a fortiori* — the malformed
 *      intent cannot even be constructed, kernel-wide, for every payload.
 *      (This subsumes — does not weaken — the per-pack guard; the guard could
 *      never see a NaN because the envelope it lives behind can't be built.)
 *   2. Finite-but-invalid amounts (negative, over-balance) still flow through
 *      `refundMagnitudeGuard`, which REFUSEs with the typed
 *      `refund.amount_invalid` code (the `-1` case below).
 *
 * Mirrors the audit's NEW-P0-X6 (deep-audit/05-hidden-bugs.md #2) and the
 * sibling Infinity / -Infinity edges that the comparison semantics share.
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
    nonce: "n-refund-nan",
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

describe("NEW-P0-X6 — refundMagnitudeGuard rejects NaN/Infinity", () => {
  // Layer 1 — non-finite amounts cannot even be built into an envelope:
  // canonical-JSON (RFC 8785) throws, so the malformed intent never reaches
  // adjudicate() / EXECUTE. We assert at `refundEnv` (= buildEnvelope) since
  // that is where the content-addressing hash is computed and the throw fires.
  it("THROW at envelope boundary: refundAmountCentavos = NaN", () => {
    expect(() =>
      refundEnv({
        paymentId: "p-nan",
        refundAmountCentavos: NaN,
        refundableBalanceCentavos: 10_000,
        amountInCentavos: 10_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
    ).toThrow(/non-finite/i)
  })

  it("THROW at envelope boundary: refundAmountCentavos = Infinity", () => {
    expect(() =>
      refundEnv({
        paymentId: "p-inf",
        refundAmountCentavos: Infinity,
        refundableBalanceCentavos: 10_000,
        amountInCentavos: 10_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
    ).toThrow(/non-finite/i)
  })

  it("THROW at envelope boundary: refundAmountCentavos = -Infinity", () => {
    expect(() =>
      refundEnv({
        paymentId: "p-ninf",
        refundAmountCentavos: -Infinity,
        refundableBalanceCentavos: 10_000,
        amountInCentavos: 10_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
    ).toThrow(/non-finite/i)
  })

  it("REFUSE: refundAmountCentavos = -1 (negative)", () => {
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-neg",
        refundAmountCentavos: -1,
        refundableBalanceCentavos: 10_000,
        amountInCentavos: 10_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 10_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind === "REFUSE") {
      expect(decision.refusal.code).toBe("refund.amount_invalid")
    }
  })

  it("EXECUTE remains for valid amount (regression check)", () => {
    // Confirm the fix doesn't accidentally reject a legitimate amount.
    const decision = adjudicate(
      refundEnv({
        paymentId: "p-ok",
        refundAmountCentavos: 1_000,
        refundableBalanceCentavos: 10_000,
        amountInCentavos: 10_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }),
      refundState(0, 10_000),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})
