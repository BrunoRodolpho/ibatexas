/**
 * @ibatexas/pack-payments — PIX regeneration cap dedicated tests.
 *
 * Boundary-condition coverage for the W3 P0-2 guard:
 *   currentCount + 1 > cap                → REFUSE (cap exceeded)
 *   currentRegenerationCount diverges     → REFUSE (state divergent)
 *   under cap                             → EXECUTE (falls through to executeAll)
 *
 * Default cap is 5; env override `MAX_PIX_REGENERATIONS_PER_PAYMENT`.
 * This guard is now owned by pack-payments (was domain-internal under
 * `paymentProjectionPolicyBundle`).
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

function regenEnv(
  payload: Record<string, unknown>,
): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  return buildEnvelope({
    kind: "payment.pix.regenerate",
    payload: payload as unknown as PaymentPayload,
    actor: { principal: "user", sessionId: "cust:1" },
    taint: "UNTRUSTED",
    nonce: "n-regen",
    createdAt: "2026-05-22T12:00:00.000Z",
  })
}

function regenState(regenerationCount: number): PaymentState {
  return {
    ctx: {
      actor: { principal: "user" },
      exists: true,
      isTerminal: false,
      currentStatus: "pending",
      regenerationCount,
    },
  }
}

describe("PIX regeneration cap guard", () => {
  it("EXECUTE: first regeneration (count = 0)", () => {
    const decision = adjudicate(
      regenEnv({
        orderId: "ord-1",
        paymentId: "p-1",
        currentRegenerationCount: 0,
      }),
      regenState(0),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE: second regeneration (count = 1)", () => {
    const decision = adjudicate(
      regenEnv({
        orderId: "ord-1",
        paymentId: "p-1",
        currentRegenerationCount: 1,
      }),
      regenState(1),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE: at last allowed regeneration (count = 4 → 5)", () => {
    const decision = adjudicate(
      regenEnv({
        orderId: "ord-1",
        paymentId: "p-1",
        currentRegenerationCount: 4,
      }),
      regenState(4),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE: at cap boundary (count = 5 → 6 > 5)", () => {
    const decision = adjudicate(
      regenEnv({
        orderId: "ord-1",
        paymentId: "p-1",
        currentRegenerationCount: 5,
      }),
      regenState(5),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("regeneration.cap_exceeded")
  })

  it("REFUSE: above cap (count = 10)", () => {
    const decision = adjudicate(
      regenEnv({
        orderId: "ord-1",
        paymentId: "p-1",
        currentRegenerationCount: 10,
      }),
      regenState(10),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("REFUSE: state-divergent count (envelope says 2, state has 1)", () => {
    const decision = adjudicate(
      regenEnv({
        orderId: "ord-1",
        paymentId: "p-1",
        currentRegenerationCount: 2,
      }),
      regenState(1),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("regeneration.state_divergent")
  })

  it("REFUSE on missing payment (state guard runs before business)", () => {
    const decision = adjudicate(
      regenEnv({
        orderId: "ord-1",
        paymentId: "p-1",
        currentRegenerationCount: 0,
      }),
      { ctx: { actor: { principal: "user" }, exists: false } },
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("payment.not_found")
  })
})
