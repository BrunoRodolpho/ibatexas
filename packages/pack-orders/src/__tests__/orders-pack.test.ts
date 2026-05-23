/**
 * @ibatexas/pack-orders — per-guard unit tests.
 *
 * Each guard tested in isolation: input → expected decision.
 *
 * Companion to `conformance.test.ts` (kernel invariants + 30+ corpus
 * cross-checked against the legacy `orderPolicyBundle`). This file
 * targets readability of each guard's behaviour for future Pack
 * maintainers; the conformance file targets byte-identical migration
 * proof.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  ordersPack,
  ordersPolicyBundle,
  type OrderIntentKind,
  type OrderPayload,
  type OrderState,
} from "../index.js"

const DET_TIME = "2026-05-22T12:00:00.000Z"

function env(
  kind: OrderIntentKind,
  payload: Record<string, unknown>,
  taint: "SYSTEM" | "TRUSTED" | "UNTRUSTED" = "UNTRUSTED",
): IntentEnvelope<OrderIntentKind, OrderPayload> {
  return buildEnvelope({
    kind,
    payload: payload as OrderPayload,
    actor: { principal: "llm", sessionId: "s-1" },
    taint,
    nonce: "n-test",
    createdAt: DET_TIME,
  })
}

function state(overrides: Partial<OrderState["ctx"]> = {}): OrderState {
  return {
    ctx: {
      channel: "whatsapp",
      customerId: "c-1",
      cartId: "cart-1",
      orderId: null,
      items: [
        {
          variantId: "v-1",
          quantity: 1,
          priceInCentavos: 5_000,
        },
      ],
      fulfillment: "delivery",
      paymentMethod: "pix",
      paymentStatus: "paid",
      totalInCentavos: 5_000,
      lastAction: null,
      ...overrides,
    },
  }
}

// ── Auth phase ──────────────────────────────────────────────────────────

describe("ordersPolicyBundle — auth guards", () => {
  it("REFUSE when customer is not authenticated for a mutating intent", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1,
        allergens: [],
      }),
      state({ customerId: null, channel: "web" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("auth.required")
  })

  it("Allow anonymous order.cart.ensure (bootstrap intent)", () => {
    const decision = adjudicate(
      env("order.cart.ensure", { cartId: "cart-1" }),
      state({ customerId: null, channel: "web" }),
      ordersPolicyBundle,
    )
    // No state preconditions block; default-deny would refuse but
    // executeCartOps grants EXECUTE.
    expect(decision.kind).toBe("EXECUTE")
  })

  it("Authenticated WhatsApp user checkout succeeds through the auth gate", () => {
    // requireAuthenticated fires first (state phase precedes auth in
    // evaluation order); requireCheckoutEligibility is a secondary
    // gate for the eventual checkout-specific WA-without-customer
    // bypass. With a customerId set, both pass.
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "card",
      }),
      state({
        customerId: "c-1",
        paymentMethod: "card",
        paymentStatus: null,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── State phase ─────────────────────────────────────────────────────────

describe("ordersPolicyBundle — state guards", () => {
  it("REFUSE order.checkout.create with empty cart", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "pix",
      }),
      state({ items: [] }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.cart.empty")
  })

  it("REFUSE order.cancel without orderId", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1" }),
      state({ orderId: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.not_found")
  })

  it("REFUSE order.cancel on already-cancelled order", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1" }),
      state({ orderId: "o-1", lastAction: "cancelled" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.already_cancelled")
  })

  it("REFUSE order.checkout.create with incomplete slots (no payment method in state)", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "pix",
      }),
      state({ fulfillment: null, paymentMethod: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.checkout.slots_incomplete")
  })
})

// ── Taint phase ─────────────────────────────────────────────────────────

describe("ordersPolicyBundle — taint policy", () => {
  it("system-only kind order.cancel.system requires TRUSTED taint", () => {
    expect(
      ordersPolicyBundle.taint.minimumFor("order.cancel.system"),
    ).toBe("TRUSTED")
    expect(ordersPolicyBundle.taint.minimumFor("order.cancel")).toBe(
      "UNTRUSTED",
    )
    expect(ordersPolicyBundle.taint.minimumFor("order.item.add")).toBe(
      "UNTRUSTED",
    )
  })

  it("UNTRUSTED-tainted order.cancel.system is REFUSEd by the taint gate", () => {
    const decision = adjudicate(
      env(
        "order.cancel.system",
        { orderId: "o-1", reason: "stale" },
        "UNTRUSTED",
      ),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("TRUSTED-tainted order.cancel.system is accepted by the taint gate", () => {
    const decision = adjudicate(
      env(
        "order.cancel.system",
        { orderId: "o-1", reason: "stale" },
        "TRUSTED",
      ),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Business: allergens (SAFETY-CRITICAL — CLAUDE.md #1) ────────────────

describe("ordersPolicyBundle — allergens explicit array (CLAUDE.md rule #1)", () => {
  it("REFUSE order.item.add when allergens is missing", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1,
        // allergens intentionally absent
      }),
      state(),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe(
      "order.item.allergens_not_explicit",
    )
  })

  it("REFUSE order.item.add when allergens is a non-array (e.g. inferred from text)", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1,
        allergens: "contains nuts" as unknown as string[],
      }),
      state(),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe(
      "order.item.allergens_not_explicit",
    )
  })

  it("REFUSE order.item.add when allergens contains non-string entries", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1,
        allergens: ["nuts", 123 as unknown as string],
      }),
      state(),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe(
      "order.item.allergens_not_explicit",
    )
  })

  it("EXECUTE order.item.add with explicit empty allergens array", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1,
        allergens: [],
      }),
      state(),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Business: quantity (positive integer) ───────────────────────────────

describe("ordersPolicyBundle — quantity validation", () => {
  it("REFUSE order.item.add with zero quantity", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 0,
        allergens: [],
      }),
      state(),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.item.quantity_invalid")
  })

  it("REFUSE order.item.add with non-integer quantity", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1.5,
        allergens: [],
      }),
      state(),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })
})

// ── Business: REWRITE-clamp on order.item.update ────────────────────────

describe("ordersPolicyBundle — REWRITE-clamp on stock-capped item.update", () => {
  it("REWRITE order.item.update when requested quantity exceeds stockCap", () => {
    const decision = adjudicate(
      env("order.item.update", {
        cartId: "cart-1",
        itemId: "v-1",
        quantity: 100,
      }),
      state({
        items: [
          {
            variantId: "v-1",
            quantity: 1,
            priceInCentavos: 5_000,
            stockCap: 5,
          },
        ],
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REWRITE")
    if (decision.kind !== "REWRITE") return
    expect(
      (decision.rewritten.payload as { quantity: number }).quantity,
    ).toBe(5)
  })

  it("EXECUTE order.item.update at-or-below stockCap (no rewrite)", () => {
    const decision = adjudicate(
      env("order.item.update", {
        cartId: "cart-1",
        itemId: "v-1",
        quantity: 3,
      }),
      state({
        items: [
          {
            variantId: "v-1",
            quantity: 1,
            priceInCentavos: 5_000,
            stockCap: 5,
          },
        ],
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Business: REQUEST_CONFIRMATION for large-ticket checkout ────────────

describe("ordersPolicyBundle — REQUEST_CONFIRMATION for large checkout", () => {
  it("REQUEST_CONFIRMATION when total >= R$ 1.000 (100_000 centavos)", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "card",
      }),
      state({
        totalInCentavos: 150_000,
        paymentMethod: "card",
        paymentStatus: null,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toContain("R$")
  })

  it("EXECUTE when total below threshold", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "card",
      }),
      state({
        totalInCentavos: 50_000,
        paymentMethod: "card",
        paymentStatus: null,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Business: ESCALATE for large-ticket cancel ──────────────────────────

describe("ordersPolicyBundle — ESCALATE for large cancel", () => {
  it("ESCALATE order.cancel when total >= R$ 1.000", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
      state({
        orderId: "o-1",
        totalInCentavos: 200_000,
        lastAction: null,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("ESCALATE")
    if (decision.kind !== "ESCALATE") return
    expect(decision.to).toBe("human")
  })

  it("EXECUTE small-ticket cancel", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
      state({
        orderId: "o-1",
        totalInCentavos: 5_000,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Business: amount cap REFUSE ─────────────────────────────────────────

describe("ordersPolicyBundle — amount cap (REFUSE above 10× threshold)", () => {
  it("REFUSE order.checkout.create above R$ 10.000 cap", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "card",
      }),
      state({
        totalInCentavos: 1_500_000, // R$ 15.000
        paymentMethod: "card",
        paymentStatus: null,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe(
      "order.checkout.amount_exceeds_limit",
    )
  })
})

// ── Business: DEFER on pending PIX ──────────────────────────────────────

describe("ordersPolicyBundle — DEFER for pending PIX checkout", () => {
  it("DEFER order.checkout.create when paymentMethod=pix and paymentStatus pending", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "pix",
      }),
      state({
        paymentMethod: "pix",
        paymentStatus: "pending",
        totalInCentavos: 5_000,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("DEFER")
    if (decision.kind !== "DEFER") return
    expect(decision.signal).toBe("payment.confirmed")
    expect(decision.timeoutMs).toBe(15 * 60 * 1000)
  })

  it("EXECUTE order.checkout.create when PIX status is confirmed", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "pix",
      }),
      state({
        paymentMethod: "pix",
        paymentStatus: "confirmed",
        totalInCentavos: 5_000,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE non-PIX checkout (paymentMethod=card) without DEFER", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "card",
      }),
      state({
        paymentMethod: "card",
        paymentStatus: null,
        totalInCentavos: 5_000,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Default-deny invariant (CLAUDE.md / master plan #4) ─────────────────

describe("ordersPolicyBundle — default-deny invariant", () => {
  it("policy.default is REFUSE (fail-safe — master plan #4)", () => {
    expect(ordersPolicyBundle.default).toBe("REFUSE")
  })

  it("ordersPack.policy.default mirrors the bundle default", () => {
    expect(ordersPack.policy.default).toBe("REFUSE")
  })
})

// ── PackV0 conformance (shape-level) ────────────────────────────────────

describe("ordersPack — PackV0 shape", () => {
  it("declares v0 contract", () => {
    expect(ordersPack.contract).toBe("v0")
  })

  it("id matches the org convention", () => {
    expect(ordersPack.id).toBe("ibatexas/pack-orders")
  })

  it("version is 1.0.0 (first stable release of pack-orders)", () => {
    expect(ordersPack.version).toBe("1.0.0")
  })

  it("declares non-empty unique intents", () => {
    expect(ordersPack.intents.length).toBeGreaterThan(0)
    const unique = new Set(ordersPack.intents)
    expect(unique.size).toBe(ordersPack.intents.length)
  })

  it("declares the PIX confirmation signal in signals", () => {
    expect(ordersPack.signals).toContain("payment.confirmed")
  })

  it("planner returns a Plan with read-only tools and allowed intents", () => {
    const plan = ordersPack.planner.plan(state(), {
      channel: "whatsapp",
      customerId: "c-1",
      cartId: "cart-1",
      orderId: null,
    })
    expect(plan.visibleReadTools.length).toBeGreaterThan(0)
    expect(plan.allowedIntents.length).toBeGreaterThan(0)
    // No MUTATING tool ever leaks into visibleReadTools.
    for (const t of plan.visibleReadTools) {
      expect([
        "get_cart",
        "get_order_history",
        "check_order_status",
        "get_recommendations",
        "get_also_added",
        "get_ordered_together",
      ]).toContain(t)
    }
  })
})

// ── Rehydrator ──────────────────────────────────────────────────────────

describe("rehydrateOrderState", () => {
  it("returns a default-empty OrderState for malformed input", () => {
    const out = ordersPack.rehydrateState?.(null)
    expect(out).toBeDefined()
    expect(out!.ctx.customerId).toBeNull()
  })

  it("passes through a well-formed OrderState (idempotent)", () => {
    const s = state()
    const out = ordersPack.rehydrateState?.(s)
    expect(out).toEqual(s)
  })
})
