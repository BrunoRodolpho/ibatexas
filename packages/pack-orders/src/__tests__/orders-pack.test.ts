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
import { buildEnvelope, createAuthorityGraphStore, type IntentEnvelope } from "@adjudicate/core"
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
  it("Allow guest cart-building (order.item.add) — identity is gated at checkout, not here (RC-A1 Chunk 0 / D-20.4)", () => {
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
    // A guest may build a cart (mirrors the HTTP optionalAuth cart routes);
    // requireAuthenticated exempts GUEST_CART_KINDS. The guest-identity REFUSE
    // assertion for a mutating intent lives on order.review.submit below.
    expect(decision.kind).toBe("EXECUTE")
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

// ── Tenant binding (AuthReviewer-009 / RC-A1 D-12) ──────────────────────

describe("ordersPolicyBundle — tenant binding (AuthReviewer-009)", () => {
  it("REFUSEs a write whose state tenant is not the configured tenant (cross-tenant)", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1,
        allergens: [],
      }),
      state({ tenantId: "another-tenant" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.kind).toBe("SECURITY")
    expect(decision.refusal.code).toBe("tenant_binding_violation")
  })

  it("EXECUTEs the single-tenant happy path (state tenant === configured)", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1,
        allergens: [],
      }),
      state({ tenantId: "ibatexas" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("is a no-op when the tenant is not supplied in state (gateway/legacy path)", () => {
    // The default state carries no tenantId — the guard must NOT refuse (so the
    // gateway path, which does not yet supply a tenant, is unaffected).
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1,
        allergens: [],
      }),
      state({}),
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

  it("REFUSE order.cancel past the point-of-no-return (J006: kernel-enforced)", () => {
    // Mirrors the route-layer canPerformAction rule: once ready / out-for-delivery
    // / delivered the kernel itself REFUSEs the cancel (not just the route).
    for (const fs of ["ready", "in_delivery", "delivered"]) {
      const decision = adjudicate(
        env("order.cancel", { orderId: "o-1" }),
        state({ orderId: "o-1", fulfillmentStatus: fs }),
        ordersPolicyBundle,
      )
      expect(decision.kind).toBe("REFUSE")
      if (decision.kind !== "REFUSE") return
      expect(decision.refusal.code).toBe("order.past_ponr")
    }
  })

  it("EXECUTE/allow order.cancel while still cancellable (pending / confirmed)", () => {
    for (const fs of ["pending", "confirmed"]) {
      const decision = adjudicate(
        env("order.cancel", { orderId: "o-1" }),
        state({ orderId: "o-1", fulfillmentStatus: fs }),
        ordersPolicyBundle,
      )
      // not REFUSEd by the cancellability guard (may EXECUTE or hit a money gate,
      // but never the past_ponr/already_cancelled terminal refusal).
      if (decision.kind === "REFUSE") {
        expect(decision.refusal.code).not.toBe("order.past_ponr")
        expect(decision.refusal.code).not.toBe("order.already_cancelled")
      }
    }
  })

  it("REFUSE a CUSTOMER order.cancel once the kitchen is preparing (route-aligned PONR)", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1" }),
      state({ orderId: "o-1", fulfillmentStatus: "preparing" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.past_ponr")
  })

  it("ALLOW a SYSTEM order.cancel.system of a preparing order (compensation exempt)", () => {
    // pix-expiry / stale-order jobs build order.cancel.system (actor.principal=
    // "system") and must be able to cancel a preparing order as compensation.
    const sysEnv = buildEnvelope({
      kind: "order.cancel.system",
      payload: { orderId: "o-1" } as OrderPayload,
      actor: { principal: "system", sessionId: "stale-order-checker:evt-1" },
      taint: "SYSTEM",
      nonce: "n-sys",
      createdAt: DET_TIME,
    })
    const decision = adjudicate(
      sysEnv,
      state({ orderId: "o-1", fulfillmentStatus: "preparing" }),
      ordersPolicyBundle,
    )
    // The cancellability guard does NOT block a system cancel of a preparing order.
    if (decision.kind === "REFUSE") {
      expect(decision.refusal.code).not.toBe("order.past_ponr")
    }
  })

  it("REFUSE order.cancel on a canceled fulfillment status as already-cancelled", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1" }),
      state({ orderId: "o-1", fulfillmentStatus: "canceled" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.already_cancelled")
  })

  // ── 034-F1: kernel ownership/IDOR guard (defense-in-depth) ────────────────
  function cancelEnv(owner: string, resource: string, sessionId: string) {
    return buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: resource },
      actor: { principal: "llm", sessionId },
      taint: "UNTRUSTED",
      nonce: `n-${sessionId}-${resource}`,
      createdAt: DET_TIME,
      resourceRefs: { owner, resource },
    }) as IntentEnvelope<OrderIntentKind, OrderPayload>
  }
  function authState(customerId: string, ownedResource: string, knownSession: string, orderId: string): OrderState {
    return {
      ctx: {
        tenantId: "ibatexas",
        channel: "whatsapp",
        customerId,
        isAuthenticated: true,
        actor: { principal: "user", id: customerId },
        cartId: null,
        orderId,
        fulfillmentStatus: "pending",
        lastAction: null,
      },
      authority: {
        store: createAuthorityGraphStore({
          edges: [{ principal: customerId, relationship: "owns", resource: ownedResource, permits: { actions: ["order.cancel"] } }],
        }),
        principalOf: (sid: string) => (sid === knownSession ? customerId : null),
      },
    } as unknown as OrderState
  }

  it("OWNERSHIP: a customer cancelling their OWN order is NOT refused by the ownership guard", () => {
    const decision = adjudicate(cancelEnv("cust-A", "order-A", "sess-A"), authState("cust-A", "order-A", "sess-A", "order-A"), ordersPolicyBundle)
    if (decision.kind === "REFUSE") expect(decision.refusal.code).not.toBe("order.ownership_denied")
  })

  it("OWNERSHIP CANARY (de-vacuumed): cancelling a NON-owned order REFUSEs order.ownership_denied", () => {
    // store binds cust-A → order-A only; the envelope targets order-B → unbound → REFUSE.
    const decision = adjudicate(cancelEnv("cust-A", "order-B", "sess-A"), authState("cust-A", "order-A", "sess-A", "order-B"), ordersPolicyBundle)
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.ownership_denied")
  })

  it("OWNERSHIP IDOR-gate: an unrecognised session acting on an owned order REFUSEs", () => {
    // resource IS owned (bound), but principalOf(sess-B)=null != owner → IDOR REFUSE.
    const decision = adjudicate(cancelEnv("cust-A", "order-A", "sess-B"), authState("cust-A", "order-A", "sess-A", "order-A"), ordersPolicyBundle)
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.ownership_denied")
  })

  it("OWNERSHIP: guard is INERT when the host injects NO authority (no resourceRefs path)", () => {
    // no authority on state ⇒ the ownership guard returns null; cancel proceeds on
    // the normal guards (here: cancellable order → not an ownership refusal).
    const decision = adjudicate(env("order.cancel", { orderId: "o-1" }), state({ orderId: "o-1", fulfillmentStatus: "pending" }), ordersPolicyBundle)
    if (decision.kind === "REFUSE") expect(decision.refusal.code).not.toBe("order.ownership_denied")
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

  it("EXECUTE fresh PIX checkout (null status) — QR-first, not DEFER (D-24 Ruling 1)", () => {
    const decision = adjudicate(
      env("order.checkout.create", { cartId: "cart-1", paymentMethod: "pix" }),
      state({ paymentMethod: "pix", paymentStatus: null, totalInCentavos: 5_000 }),
      ordersPolicyBundle,
    )
    // A fresh PIX checkout EXECUTEs immediately — createCheckout generates the QR;
    // the routed payment.status.reconcile webhook governs confirmation.
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE guest CARD checkout — SEC-001 allows guest card (D-24 Ruling 2)", () => {
    const decision = adjudicate(
      env("order.checkout.create", { cartId: "cart-1", paymentMethod: "card" }),
      state({ customerId: null, channel: "web", paymentMethod: "card" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE guest PIX checkout — the guest exemption is CARD-only (cash/PIX still need auth)", () => {
    const decision = adjudicate(
      env("order.checkout.create", { cartId: "cart-1", paymentMethod: "pix" }),
      state({ customerId: null, channel: "web", paymentMethod: "pix", paymentStatus: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("auth.required")
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

  it("version is 1.1.0 (W5-2 expansion of pack-orders)", () => {
    expect(ordersPack.version).toBe("1.1.0")
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

// ── order.review.submit ─────────────────────────────────────────────────

describe("ordersPolicyBundle — order.review.submit", () => {
  it("EXECUTE happy path: rating=5, orderId set, customer authenticated", () => {
    const decision = adjudicate(
      env("order.review.submit", {
        orderId: "o-1",
        productId: "prod-1",
        rating: 5,
        comment: "Tudo ótimo!",
      }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE happy path: rating=1 (lower boundary)", () => {
    const decision = adjudicate(
      env("order.review.submit", {
        orderId: "o-1",
        productId: "prod-1",
        rating: 1,
      }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE: rating=0 (below range)", () => {
    const decision = adjudicate(
      env("order.review.submit", {
        orderId: "o-1",
        productId: "prod-1",
        rating: 0,
      }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.review.rating_invalid")
  })

  it("REFUSE: rating=6 (above range)", () => {
    const decision = adjudicate(
      env("order.review.submit", {
        orderId: "o-1",
        productId: "prod-1",
        rating: 6,
      }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.review.rating_invalid")
  })

  it("REFUSE: rating=3.5 (non-integer)", () => {
    const decision = adjudicate(
      env("order.review.submit", {
        orderId: "o-1",
        productId: "prod-1",
        rating: 3.5,
      }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.review.rating_invalid")
  })

  it("REFUSE: rating missing from payload", () => {
    const decision = adjudicate(
      env("order.review.submit", {
        orderId: "o-1",
        productId: "prod-1",
      }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.review.rating_invalid")
  })

  it("REFUSE: missing orderId in state (requireOrderIdForMutation)", () => {
    const decision = adjudicate(
      env("order.review.submit", {
        orderId: "o-1",
        productId: "prod-1",
        rating: 4,
      }),
      state({ orderId: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.not_found")
  })

  it("REFUSE: customer not authenticated", () => {
    const decision = adjudicate(
      env("order.review.submit", {
        orderId: "o-1",
        productId: "prod-1",
        rating: 4,
      }),
      state({ orderId: "o-1", customerId: null, channel: "web" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("auth.required")
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
