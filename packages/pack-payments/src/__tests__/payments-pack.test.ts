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
import { buildEnvelope, createAuthorityGraphStore, type IntentEnvelope } from "@adjudicate/core"
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

// ── Tenant binding (AuthReviewer-009 / RC-A1 D-12) ──────────────────────

describe("paymentsPolicyBundle — tenant binding (AuthReviewer-009)", () => {
  it("REFUSEs a cross-tenant request; no-op when the tenant matches/absent", () => {
    // requireTenantBindingGuard is the SOLE authGuard for this pack — confirm it
    // fires (the create otherwise EXECUTEs) on a state-tenant mismatch.
    const crossTenant = adjudicate(
      env("payment.create", { orderId: "ord-1", method: "pix", amountInCentavos: 50_000 }),
      { ctx: { actor: { principal: "system" }, exists: false, tenantId: "another-tenant" } },
      paymentsPolicyBundle,
    )
    expect(crossTenant.kind).toBe("REFUSE")
    if (crossTenant.kind === "REFUSE") {
      expect(crossTenant.refusal.kind).toBe("SECURITY")
      expect(crossTenant.refusal.code).toBe("tenant_binding_violation")
    }

    const sameTenant = adjudicate(
      env("payment.create", { orderId: "ord-1", method: "pix", amountInCentavos: 50_000 }),
      { ctx: { actor: { principal: "system" }, exists: false, tenantId: "ibatexas" } },
      paymentsPolicyBundle,
    )
    expect(sameTenant.kind).toBe("EXECUTE")
  })
})

// ── 034-F1: ownership/IDOR guard (defense-in-depth) ───────────────────────

describe("paymentsPolicyBundle — ownership/IDOR guard (034-F1)", () => {
  function refundEnv(owner: string, resource: string, sessionId: string) {
    return buildEnvelope({
      kind: "payment.refund.issue",
      payload: { orderId: resource, refundAmountCentavos: 1_000 } as unknown as PaymentPayload,
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
      nonce: `n-${sessionId}-${resource}`,
      createdAt: DET_TIME,
      resourceRefs: { owner, resource },
    }) as IntentEnvelope<PaymentIntentKind, PaymentPayload>
  }
  function authState(customerId: string, ownedResource: string, knownSession: string): PaymentState {
    return {
      ctx: {
        actor: { principal: "user" },
        tenantId: "ibatexas",
        exists: true,
        currentStatus: "paid",
        currentMethod: "pix",
        version: 1,
        orderId: ownedResource,
        isTerminal: false,
        refundedAmountCentavos: 0,
        amountInCentavos: 50_000,
        regenerationCount: 0,
        dailyRetryCount: 0,
        // D1: this fixture injects authority, so the 4-conjunct refund invariant is
        // now binding. A real authority-wired refund is read live this turn — supply
        // the freshness marker so these OWNERSHIP tests reach the ownership verdict
        // (the canary/IDOR cases still REFUSE in the AUTH phase, before freshness).
        paymentReadThisTurn: true,
      },
      authority: {
        store: createAuthorityGraphStore({
          edges: [{ principal: customerId, relationship: "owns", resource: ownedResource, permits: { actions: ["payment.refund.issue"] } }],
        }),
        principalOf: (sid: string) => (sid === knownSession ? customerId : null),
      },
    } as unknown as PaymentState
  }

  it("CANARY (de-vacuumed): a refund on a NON-owned order REFUSEs payment.ownership_denied", () => {
    const d = adjudicate(refundEnv("cust-A", "ord-B", "sess-A"), authState("cust-A", "ord-A", "sess-A"), paymentsPolicyBundle)
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("payment.ownership_denied")
  })
  it("a refund on the OWNED order is NOT refused by the ownership guard", () => {
    const d = adjudicate(refundEnv("cust-A", "ord-A", "sess-A"), authState("cust-A", "ord-A", "sess-A"), paymentsPolicyBundle)
    if (d.kind === "REFUSE") expect(d.refusal.code).not.toBe("payment.ownership_denied")
  })
  it("IDOR-gate: an unrecognised session REFUSEs even on an owned order", () => {
    const d = adjudicate(refundEnv("cust-A", "ord-A", "sess-B"), authState("cust-A", "ord-A", "sess-A"), paymentsPolicyBundle)
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("payment.ownership_denied")
  })
})

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
    // BKL-176 — payment.charge.confirm retired; payment.status.reconcile is a
    // remaining system-only kind.
    expect(paymentsPolicyBundle.taint.minimumFor("payment.status.reconcile")).toBe(
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

  it("declares 12 unique intent kinds", () => {
    // BKL-176 — 17 before retiring the 5 dead payment.charge.* kinds.
    expect(paymentsPack.intents.length).toBe(12)
    const unique = new Set(paymentsPack.intents)
    expect(unique.size).toBe(paymentsPack.intents.length)
  })

  it("planner returns a Plan with read-only tools and allowed intents", () => {
    const plan = paymentsPack.planner.plan(
      { ctx: { actor: { principal: "system" }, exists: false } },
      { actor: { principal: "user" } },
    )
    expect(plan.visibleReadTools.length).toBeGreaterThan(0)
    // P0-7: the EXACT advertised list — only the kind with a registered
    // chat tool. A new entry here must ship its tool in the same change.
    expect(plan.allowedIntents).toEqual(["payment.pix.regenerate"])
    // No MUTATING tool ever leaks into visibleReadTools.
    for (const t of plan.visibleReadTools) {
      expect(["get_payment_status", "get_payment_history"]).toContain(t)
    }
  })

  it("de-advertises payment.method.switch + payment.retry (P0-7 — no chat tool until WS4)", () => {
    const plan = paymentsPack.planner.plan(
      { ctx: { actor: { principal: "system" }, exists: false } },
      { actor: { principal: "user" } },
    )
    expect(plan.allowedIntents).not.toContain("payment.method.switch")
    expect(plan.allowedIntents).not.toContain("payment.retry")
    // They stay pack-owned (HTTP routes adjudicate them) — only the
    // planner advertisement was withdrawn.
    expect(paymentsPack.intents).toContain("payment.method.switch")
    expect(paymentsPack.intents).toContain("payment.retry")
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
