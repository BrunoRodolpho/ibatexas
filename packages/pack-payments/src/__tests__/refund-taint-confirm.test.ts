/**
 * @ibatexas/pack-payments — BKL-085 UNTRUSTED-taint refund CONFIRM overlay.
 *
 * The exhaustive band × taint matrix for the refund ladder's overlay clause:
 * every magnitude band crossed with every taint level, proving
 *
 *   1. the overlay fires ONLY for `UNTRUSTED` (model-parsed / ops-plane) refunds;
 *   2. it NEVER pre-empts the ESCALATE band (a >R$1000 UNTRUSTED refund still
 *      ESCALATEs — the escalate check is ordered before the overlay);
 *   3. it NEVER masks the over-balance / amount-invalid / state-divergent
 *      REFUSEs (those are ordered before it);
 *   4. the TRUSTED (admin-HTTP) and SYSTEM (webhook/reconcile) paths are
 *      BYTE-IDENTICAL to the pre-BKL-085 ladder — no band weakened.
 *
 * Thresholds (defaults): CONFIRM R$500 (50_000), ESCALATE R$1000 (100_000).
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

type Taint = "TRUSTED" | "UNTRUSTED" | "SYSTEM"

function refundEnv(
  taint: Taint,
  payload: Record<string, unknown>,
): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  return buildEnvelope({
    kind: "payment.refund.issue",
    payload: payload as unknown as PaymentPayload,
    actor: { principal: "user", sessionId: "staff:1" },
    taint,
    nonce: "n-refund",
    createdAt: "2026-07-04T12:00:00.000Z",
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

/** A valid, in-band refund payload of `amount` centavos on a fresh R$X payment. */
function payload(amount: number, amountInCentavos = 200_000): Record<string, unknown> {
  return {
    paymentId: "pay_1",
    refundAmountCentavos: amount,
    refundableBalanceCentavos: amountInCentavos,
    amountInCentavos,
    currentRefundedCentavos: 0,
    actor: "admin",
  }
}

const ALL_TAINTS: Taint[] = ["TRUSTED", "UNTRUSTED", "SYSTEM"]

describe("BKL-085 refund taint-CONFIRM overlay — band × taint matrix", () => {
  // ── REFUSE bands pre-empt the overlay for EVERY taint ──────────────────────
  describe("REFUSE bands pre-empt the overlay (all taints)", () => {
    for (const taint of ALL_TAINTS) {
      it(`amount ≤ 0 REFUSEs (${taint})`, () => {
        const d = adjudicate(
          refundEnv(taint, payload(0)),
          refundState(0, 200_000),
          paymentsPolicyBundle,
        )
        expect(d.kind).toBe("REFUSE")
      })

      it(`over-balance REFUSEs before the overlay (${taint})`, () => {
        // Balance R$100; ask R$150 → over-balance REFUSE, NOT a confirm.
        const d = adjudicate(
          refundEnv(taint, {
            paymentId: "pay_1",
            refundAmountCentavos: 15_000,
            refundableBalanceCentavos: 10_000,
            amountInCentavos: 10_000,
            currentRefundedCentavos: 0,
            actor: "admin",
          }),
          refundState(0, 10_000),
          paymentsPolicyBundle,
        )
        expect(d.kind).toBe("REFUSE")
      })

      it(`state-divergent REFUSEs before the overlay (${taint})`, () => {
        const d = adjudicate(
          refundEnv(taint, {
            paymentId: "pay_1",
            refundAmountCentavos: 5_000,
            refundableBalanceCentavos: 50_000,
            amountInCentavos: 50_000,
            currentRefundedCentavos: 0, // payload says 0…
            actor: "admin",
          }),
          refundState(25_000, 50_000), // …state says 25_000
          paymentsPolicyBundle,
        )
        expect(d.kind).toBe("REFUSE")
        if (d.kind !== "REFUSE") return
        expect(d.refusal.code).toBe("refund.state_divergent")
      })
    }
  })

  // ── ESCALATE band pre-empts the overlay for EVERY taint ────────────────────
  describe("ESCALATE band pre-empts the overlay (overlay never downgrades a >R$1000 refund)", () => {
    for (const taint of ALL_TAINTS) {
      it(`>R$1000 ESCALATEs, not CONFIRM (${taint})`, () => {
        const d = adjudicate(
          refundEnv(taint, payload(100_001, 200_000)),
          refundState(0, 200_000),
          paymentsPolicyBundle,
        )
        expect(d.kind).toBe("ESCALATE")
        if (d.kind !== "ESCALATE") return
        expect(d.to).toBe("human")
      })
    }
  })

  // ── ≤ R$500 band — the DISTINGUISHING band ─────────────────────────────────
  describe("≤R$500 band: EXECUTE for TRUSTED/SYSTEM, CONFIRM for UNTRUSTED", () => {
    it("TRUSTED ≤R$500 EXECUTEs (admin-HTTP path untouched)", () => {
      const d = adjudicate(
        refundEnv("TRUSTED", payload(20_000, 200_000)),
        refundState(0, 200_000),
        paymentsPolicyBundle,
      )
      expect(d.kind).toBe("EXECUTE")
    })

    it("SYSTEM ≤R$500 EXECUTEs (webhook/reconcile path untouched)", () => {
      const d = adjudicate(
        refundEnv("SYSTEM", payload(20_000, 200_000)),
        refundState(0, 200_000),
        paymentsPolicyBundle,
      )
      expect(d.kind).toBe("EXECUTE")
    })

    it("UNTRUSTED ≤R$500 REQUEST_CONFIRMATION (the new overlay)", () => {
      const d = adjudicate(
        refundEnv("UNTRUSTED", payload(20_000, 200_000)),
        refundState(0, 200_000),
        paymentsPolicyBundle,
      )
      expect(d.kind).toBe("REQUEST_CONFIRMATION")
      if (d.kind !== "REQUEST_CONFIRMATION") return
      // pt-BR prompt states the parsed amount + payment reference.
      expect(d.prompt).toContain("R$ 200,00")
      expect(d.prompt).toContain("pay_1")
      expect(d.prompt.toLowerCase()).toContain("sim")
    })
  })

  // ── R$500 boundary (inclusive EXECUTE for TRUSTED, CONFIRM for UNTRUSTED) ───
  describe("R$500 boundary (inclusive)", () => {
    it("TRUSTED R$500 EXECUTEs (≤ confirm threshold)", () => {
      const d = adjudicate(
        refundEnv("TRUSTED", payload(50_000, 200_000)),
        refundState(0, 200_000),
        paymentsPolicyBundle,
      )
      expect(d.kind).toBe("EXECUTE")
    })

    it("UNTRUSTED R$500 REQUEST_CONFIRMATION (overlay)", () => {
      const d = adjudicate(
        refundEnv("UNTRUSTED", payload(50_000, 200_000)),
        refundState(0, 200_000),
        paymentsPolicyBundle,
      )
      expect(d.kind).toBe("REQUEST_CONFIRMATION")
    })
  })

  // ── R$500 < amount ≤ R$1000 band — CONFIRM for EVERY taint ─────────────────
  describe("R$500–R$1000 band: REQUEST_CONFIRMATION for every taint", () => {
    for (const taint of ALL_TAINTS) {
      it(`R$750 REQUEST_CONFIRMATION (${taint})`, () => {
        const d = adjudicate(
          refundEnv(taint, payload(75_000, 200_000)),
          refundState(0, 200_000),
          paymentsPolicyBundle,
        )
        expect(d.kind).toBe("REQUEST_CONFIRMATION")
      })
    }

    it("UNTRUSTED and TRUSTED both CONFIRM in the medium band (overlay does not change the outcome, only the basis)", () => {
      const trusted = adjudicate(
        refundEnv("TRUSTED", payload(75_000, 200_000)),
        refundState(0, 200_000),
        paymentsPolicyBundle,
      )
      const untrusted = adjudicate(
        refundEnv("UNTRUSTED", payload(75_000, 200_000)),
        refundState(0, 200_000),
        paymentsPolicyBundle,
      )
      expect(trusted.kind).toBe("REQUEST_CONFIRMATION")
      expect(untrusted.kind).toBe("REQUEST_CONFIRMATION")
    })
  })
})
