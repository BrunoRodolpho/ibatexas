/**
 * @ibatexas/pack-payments — per-guard unit tests.
 *
 * Each guard tested in isolation: input → expected decision.
 *
 * Companion to `conformance.test.ts` (kernel invariants + 30+ corpus
 * cross-checks). This file targets readability of each guard's
 * behaviour for future Pack maintainers; the conformance file targets
 * the bypass-detection invariants.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  paymentsPack,
  paymentsPolicyBundle,
  type PaymentIntentKind,
  type PaymentPayload,
  type PaymentState,
} from "../index.js"

const DET_TIME = "2026-05-22T12:00:00.000Z"

function env(
  kind: PaymentIntentKind,
  payload: Record<string, unknown>,
  taint: "SYSTEM" | "TRUSTED" | "UNTRUSTED" = "SYSTEM",
): IntentEnvelope<PaymentIntentKind, PaymentPayload> {
  return buildEnvelope({
    kind,
    payload: payload as unknown as PaymentPayload,
    actor: { principal: "system", sessionId: "s-1" },
    taint,
    nonce: "n-test",
    createdAt: DET_TIME,
  })
}

function existsState(overrides: Partial<PaymentState["ctx"]> = {}): PaymentState {
  return {
    ctx: {
      actor: { principal: "system" },
      exists: true,
      currentStatus: "pending",
      currentMethod: "pix",
      version: 1,
      orderId: "ord-1",
      isTerminal: false,
      refundedAmountCentavos: 0,
      amountInCentavos: 50_000,
      regenerationCount: 0,
      dailyRetryCount: 0,
      ...overrides,
    },
  }
}

// ── State phase ─────────────────────────────────────────────────────────

describe("paymentsPolicyBundle — state guards", () => {
  it("REFUSE payment.refund.issue when payment doesn't exist", () => {
    const decision = adjudicate(
      env(
        "payment.refund.issue",
        {
          paymentId: "p-1",
          refundAmountCentavos: 10_000,
          refundableBalanceCentavos: 50_000,
          amountInCentavos: 50_000,
          currentRefundedCentavos: 0,
          actor: "admin",
        },
        "TRUSTED",
      ),
      { ctx: { actor: { principal: "admin" }, exists: false } },
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("payment.not_found")
  })

  it("REFUSE payment.status.transition on terminal payment", () => {
    const decision = adjudicate(
      env(
        "payment.status.transition",
        { paymentId: "p-1", newStatus: "paid", actor: "admin" },
        "TRUSTED",
      ),
      existsState({ isTerminal: true, currentStatus: "refunded" }),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("payment.terminal_state")
  })
})

// ── Taint phase ─────────────────────────────────────────────────────────

describe("paymentsPolicyBundle — taint policy", () => {
  it("system-only kinds require TRUSTED (default systemMinimum) taint", () => {
    expect(paymentsPolicyBundle.taint.minimumFor("payment.create")).toBe(
      "TRUSTED",
    )
    expect(paymentsPolicyBundle.taint.minimumFor("payment.charge.confirm")).toBe(
      "TRUSTED",
    )
    expect(paymentsPolicyBundle.taint.minimumFor("payment.dispute.open")).toBe(
      "TRUSTED",
    )
    expect(paymentsPolicyBundle.taint.minimumFor("payment.refund.confirm")).toBe(
      "TRUSTED",
    )
  })

  it("customer-driven kinds tolerate UNTRUSTED", () => {
    expect(paymentsPolicyBundle.taint.minimumFor("payment.pix.regenerate")).toBe(
      "UNTRUSTED",
    )
    expect(paymentsPolicyBundle.taint.minimumFor("payment.method.switch")).toBe(
      "UNTRUSTED",
    )
    expect(paymentsPolicyBundle.taint.minimumFor("payment.retry")).toBe(
      "UNTRUSTED",
    )
  })

  it("UNTRUSTED payment.create is refused by the taint gate", () => {
    const decision = adjudicate(
      env(
        "payment.create",
        { orderId: "ord-1", method: "pix", amountInCentavos: 50_000 },
        "UNTRUSTED",
      ),
      { ctx: { actor: { principal: "user" }, exists: false } },
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })
})

// ── Business: payment.create validation ─────────────────────────────────

describe("paymentsPolicyBundle — create method/amount validation", () => {
  it("REFUSE payment.create with invalid method", () => {
    const decision = adjudicate(
      env("payment.create", {
        orderId: "ord-1",
        method: "crypto",
        amountInCentavos: 50_000,
      }),
      { ctx: { actor: { principal: "system" }, exists: false } },
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("payment.method.invalid")
  })

  it("REFUSE payment.create with zero amount", () => {
    const decision = adjudicate(
      env("payment.create", {
        orderId: "ord-1",
        method: "pix",
        amountInCentavos: 0,
      }),
      { ctx: { actor: { principal: "system" }, exists: false } },
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("payment.amount_invalid")
  })

  it("EXECUTE payment.create with valid method and centavos integer", () => {
    const decision = adjudicate(
      env("payment.create", {
        orderId: "ord-1",
        method: "pix",
        amountInCentavos: 50_000,
      }),
      { ctx: { actor: { principal: "system" }, exists: false } },
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Business: refund magnitude ladder (W3 P0-1) ─────────────────────────

describe("paymentsPolicyBundle — refund magnitude ladder", () => {
  it("EXECUTE refund ≤ R$500", () => {
    const decision = adjudicate(
      env("payment.refund.issue", {
        paymentId: "p-1",
        refundAmountCentavos: 50_000,
        refundableBalanceCentavos: 100_000,
        amountInCentavos: 100_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }, "TRUSTED"),
      existsState({ refundedAmountCentavos: 0, amountInCentavos: 100_000 }),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REQUEST_CONFIRMATION refund between R$500 and R$1000", () => {
    const decision = adjudicate(
      env("payment.refund.issue", {
        paymentId: "p-1",
        refundAmountCentavos: 75_000,
        refundableBalanceCentavos: 100_000,
        amountInCentavos: 100_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }, "TRUSTED"),
      existsState({ refundedAmountCentavos: 0, amountInCentavos: 100_000 }),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
  })

  it("ESCALATE refund above R$1000", () => {
    const decision = adjudicate(
      env("payment.refund.issue", {
        paymentId: "p-1",
        refundAmountCentavos: 200_000,
        refundableBalanceCentavos: 300_000,
        amountInCentavos: 300_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }, "TRUSTED"),
      existsState({ refundedAmountCentavos: 0, amountInCentavos: 300_000 }),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("ESCALATE")
  })

  it("REFUSE refund with negative amount", () => {
    const decision = adjudicate(
      env("payment.refund.issue", {
        paymentId: "p-1",
        refundAmountCentavos: -1,
        refundableBalanceCentavos: 100_000,
        amountInCentavos: 100_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }, "TRUSTED"),
      existsState({ refundedAmountCentavos: 0, amountInCentavos: 100_000 }),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("refund.amount_invalid")
  })

  it("REFUSE refund > refundable balance", () => {
    const decision = adjudicate(
      env("payment.refund.issue", {
        paymentId: "p-1",
        refundAmountCentavos: 60_000,
        refundableBalanceCentavos: 50_000,
        amountInCentavos: 50_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      }, "TRUSTED"),
      existsState({ refundedAmountCentavos: 0, amountInCentavos: 50_000 }),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })
})

// ── Business: PIX regeneration cap (W3 P0-2) ────────────────────────────

describe("paymentsPolicyBundle — PIX regeneration cap", () => {
  it("EXECUTE pix.regenerate when under cap", () => {
    const decision = adjudicate(
      env(
        "payment.pix.regenerate",
        {
          orderId: "ord-1",
          paymentId: "p-1",
          currentRegenerationCount: 0,
        },
        "UNTRUSTED",
      ),
      existsState({ regenerationCount: 0 }),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE pix.regenerate at cap (5 default)", () => {
    const decision = adjudicate(
      env(
        "payment.pix.regenerate",
        {
          orderId: "ord-1",
          paymentId: "p-1",
          currentRegenerationCount: 5,
        },
        "UNTRUSTED",
      ),
      existsState({ regenerationCount: 5 }),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("regeneration.cap_exceeded")
  })

  it("REFUSE pix.regenerate with divergent count state", () => {
    const decision = adjudicate(
      env(
        "payment.pix.regenerate",
        {
          orderId: "ord-1",
          paymentId: "p-1",
          currentRegenerationCount: 2,
        },
        "UNTRUSTED",
      ),
      existsState({ regenerationCount: 1 }),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("regeneration.state_divergent")
  })
})

// ── Business: always-escalate / always-confirm rules ────────────────────

describe("paymentsPolicyBundle — always-escalate / always-confirm rules", () => {
  it("ESCALATE payment.dispute.open always", () => {
    const decision = adjudicate(
      env("payment.dispute.open", {
        paymentId: "p-1",
        stripeEventId: "evt_1",
      }),
      existsState(),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("ESCALATE")
    if (decision.kind !== "ESCALATE") return
    expect(decision.to).toBe("human")
  })

  it("REQUEST_CONFIRMATION payment.waive always", () => {
    const decision = adjudicate(
      env("payment.waive", {
        paymentId: "p-1",
        reason: "test",
        adminId: "staff-1",
      }, "TRUSTED"),
      existsState(),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
  })

  it("REQUEST_CONFIRMATION payment.status.force always", () => {
    const decision = adjudicate(
      env("payment.status.force", {
        paymentId: "p-1",
        newStatus: "paid",
        reason: "manual",
        adminId: "staff-1",
      }, "TRUSTED"),
      existsState(),
      paymentsPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
  })
})

// ── Default-deny invariant ──────────────────────────────────────────────

describe("paymentsPolicyBundle — default-deny invariant", () => {
  it("policy.default is REFUSE (fail-safe — master plan #4)", () => {
    expect(paymentsPolicyBundle.default).toBe("REFUSE")
  })

  it("paymentsPack.policy.default mirrors the bundle default", () => {
    expect(paymentsPack.policy.default).toBe("REFUSE")
  })
})

// ── PackV0 conformance (shape-level) ────────────────────────────────────

describe("paymentsPack — PackV0 shape", () => {
  it("declares v0 contract", () => {
    expect(paymentsPack.contract).toBe("v0")
  })

  it("id matches the org convention", () => {
    expect(paymentsPack.id).toBe("ibatexas/pack-payments")
  })

  it("version is 1.0.0", () => {
    expect(paymentsPack.version).toBe("1.0.0")
  })

  it("declares 17 unique intent kinds", () => {
    expect(paymentsPack.intents.length).toBe(17)
    const unique = new Set(paymentsPack.intents)
    expect(unique.size).toBe(paymentsPack.intents.length)
  })

  it("planner returns a Plan with read-only tools and allowed intents", () => {
    const plan = paymentsPack.planner.plan(
      { ctx: { actor: { principal: "system" }, exists: false } },
      { actor: { principal: "user" } },
    )
    expect(plan.visibleReadTools.length).toBeGreaterThan(0)
    expect(plan.allowedIntents.length).toBeGreaterThan(0)
    // No MUTATING tool ever leaks into visibleReadTools.
    for (const t of plan.visibleReadTools) {
      expect(["get_payment_status", "get_payment_history"]).toContain(t)
    }
  })
})

// ── Rehydrator ──────────────────────────────────────────────────────────

describe("rehydratePaymentState", () => {
  it("returns a default-empty PaymentState for malformed input", () => {
    const out = paymentsPack.rehydrateState?.(null)
    expect(out).toBeDefined()
    expect(out!.ctx.exists).toBe(false)
  })

  it("passes through a well-formed PaymentState (idempotent)", () => {
    const s: PaymentState = {
      ctx: {
        actor: { principal: "system" },
        exists: true,
        currentStatus: "pending",
        orderId: "ord-1",
      },
    }
    const out = paymentsPack.rehydrateState?.(s)
    expect(out).toEqual(s)
  })
})
