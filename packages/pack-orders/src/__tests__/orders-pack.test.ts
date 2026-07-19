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
  type OrderContext,
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
  it("system-only kinds require TRUSTED taint; customer kinds tolerate UNTRUSTED", () => {
    // order.cancel.system was retired (BKL-177); the remaining system-only
    // kinds still require TRUSTED, and customer kinds still tolerate UNTRUSTED.
    expect(
      ordersPolicyBundle.taint.minimumFor("order.projection.create"),
    ).toBe("TRUSTED")
    expect(
      ordersPolicyBundle.taint.minimumFor("order.status.reconcile"),
    ).toBe("TRUSTED")
    expect(ordersPolicyBundle.taint.minimumFor("order.cancel")).toBe(
      "UNTRUSTED",
    )
    expect(ordersPolicyBundle.taint.minimumFor("order.item.add")).toBe(
      "UNTRUSTED",
    )
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
  it("ESCALATE order.cancel when total >= R$ 1.000 (unpaid — escalateLargeCancel)", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
      state({
        orderId: "o-1",
        // paymentStatus null ⇒ gatePaidCancel is inert; this exercises
        // escalateLargeCancel (the UNPAID large-cancel escalation).
        paymentStatus: null,
        totalInCentavos: 200_000,
        lastAction: null,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("ESCALATE")
    if (decision.kind !== "ESCALATE") return
    expect(decision.to).toBe("human")
  })

  it("EXECUTE small-ticket cancel (unpaid — no paid-cancel park, no large-cancel escalate)", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
      state({
        orderId: "o-1",
        // paymentStatus null ⇒ an unpaid small cancel EXECUTEs (a PAID small
        // cancel instead parks — see the BKL-036 paid-cancel block below).
        paymentStatus: null,
        totalInCentavos: 5_000,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Business: BKL-036 paid-state cancel gating (J015) ───────────────────
//
// A customer order.cancel on a SETTLED order implies a refund of the total, so
// it must never silently EXECUTE: it parks (REQUEST_CONFIRMATION) below the
// escalate band and ESCALATEs at/above it. The refund-equivalent magnitude is
// the order total. gatePaidCancel is ordered BEFORE escalateLargeCancel, so it
// owns the PAID cancel path in both bands.

describe("ordersPolicyBundle — BKL-036 paid-state cancel (J015)", () => {
  it("PAID sub-escalate cancel → REQUEST_CONFIRMATION (never silent EXECUTE)", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
      // default state() is paymentStatus "paid"; small total (< R$1.000).
      state({ orderId: "o-1", fulfillmentStatus: "confirmed", totalInCentavos: 5_000 }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
  })

  it("PAID high-band cancel (total >= R$1.000) → ESCALATE to human", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
      state({ orderId: "o-1", fulfillmentStatus: "confirmed", paymentStatus: "paid", totalInCentavos: 150_000 }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("ESCALATE")
    if (decision.kind !== "ESCALATE") return
    expect(decision.to).toBe("human")
  })

  it("PAID cancel with an UNKNOWN total still parks (never EXECUTEs)", () => {
    const decision = adjudicate(
      env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
      state({ orderId: "o-1", fulfillmentStatus: "confirmed", paymentStatus: "paid", totalInCentavos: undefined }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
  })

  it("partially_refunded / disputed count as settled → REQUEST_CONFIRMATION", () => {
    for (const paymentStatus of ["partially_refunded", "disputed"]) {
      const decision = adjudicate(
        env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
        state({ orderId: "o-1", fulfillmentStatus: "confirmed", paymentStatus, totalInCentavos: 5_000 }),
        ordersPolicyBundle,
      )
      expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    }
  })

  it("UNPAID small cancel is NOT parked by gatePaidCancel → EXECUTE", () => {
    for (const paymentStatus of ["awaiting_payment", "payment_pending", "cash_pending", null]) {
      const decision = adjudicate(
        env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
        state({ orderId: "o-1", fulfillmentStatus: "confirmed", paymentStatus, totalInCentavos: 5_000 }),
        ordersPolicyBundle,
      )
      expect(decision.kind).toBe("EXECUTE")
    }
  })

  it("CONFIRM-RESUME: the identical paid-cancel envelope + confirmationReceipt re-adjudicates to EXECUTE", async () => {
    const { adjudicateAndAudit } = await import("@adjudicate/core")
    const cancelEnvelope = env("order.cancel", { orderId: "o-1", reason: "changed_mind" })
    const paidState = state({ orderId: "o-1", fulfillmentStatus: "confirmed", paymentStatus: "paid", totalInCentavos: 5_000 })

    // Without a receipt the paid cancel parks.
    const parked = adjudicate(cancelEnvelope, paidState, ordersPolicyBundle)
    expect(parked.kind).toBe("REQUEST_CONFIRMATION")

    // The confirm leg re-adjudicates the SAME envelope carrying a matching
    // receipt; the kernel's 2a override substitutes EXECUTE while every
    // state/taint/auth/business guard is still evaluated (the paid guard would
    // still park a receipt-less re-ask). A no-op audit sink keeps this a pure
    // kernel-seam check.
    const sink = { emit: async () => {} }
    const resumed = await adjudicateAndAudit(cancelEnvelope, paidState, ordersPolicyBundle, {
      sink,
      confirmationReceipt: {
        intentHash: cancelEnvelope.intentHash,
        at: DET_TIME,
      },
    })
    expect(resumed.decision.kind).toBe("EXECUTE")
  })
})

// ── State: BKL-036 amend point-of-no-return (tier a) ────────────────────
//
// canAmendOrder now gates fulfillmentStatus against the cancel PONR floor:
// once ready / out-for-delivery / delivered (or already cancelled), a customer
// amend is REFUSEd at the kernel (was: "order exists" only, so the gate never
// reached the kernel). A still-`preparing` order stays amendable (add-item is
// allowed while preparing, mirroring the route validator's checkAddItem).

describe("ordersPolicyBundle — BKL-036 amend PONR (requireAmendable)", () => {
  it("REFUSE order.amend.request past the PONR (ready / in_delivery / delivered) — order.already_shipped", () => {
    for (const fs of ["ready", "in_delivery", "delivered"]) {
      const decision = adjudicate(
        env("order.amend.request", { orderId: "o-1", changes: [{ op: "remove", itemId: "i-1" }] }),
        state({ orderId: "o-1", fulfillmentStatus: fs }),
        ordersPolicyBundle,
      )
      expect(decision.kind).toBe("REFUSE")
      if (decision.kind !== "REFUSE") return
      expect(decision.refusal.code).toBe("order.already_shipped")
    }
  })

  it("REFUSE order.amend.request on a canceled fulfillment status — order.already_cancelled", () => {
    const decision = adjudicate(
      env("order.amend.request", { orderId: "o-1", changes: [{ op: "remove", itemId: "i-1" }] }),
      state({ orderId: "o-1", fulfillmentStatus: "canceled" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.already_cancelled")
  })

  it("ALLOW order.amend.request while still amendable (pending / preparing not blocked by PONR)", () => {
    for (const fs of ["pending", "confirmed", "preparing"]) {
      const decision = adjudicate(
        env("order.amend.request", { orderId: "o-1", changes: [{ op: "remove", itemId: "i-1" }] }),
        state({ orderId: "o-1", fulfillmentStatus: fs }),
        ordersPolicyBundle,
      )
      // Not REFUSEd by the amendability PONR guard (reaches EXECUTE via
      // executeAmend). preparing stays amendable per the route validator parity.
      if (decision.kind === "REFUSE") {
        expect(decision.refusal.code).not.toBe("order.already_shipped")
        expect(decision.refusal.code).not.toBe("order.already_cancelled")
      }
    }
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

// ── Business: §O#10 adjacent-type confident-wrong (stakes-aware confirm) ──

describe("ordersPolicyBundle — §O#10 adjacent-type (order.amend.add_item vs order.item.add)", () => {
  // The amend-add envelope used across this block — valid allergens + qty so
  // the only thing the assertions vary is the §O#10 disambiguation posture.
  const amendAddEnv = () =>
    env("order.amend.add_item", {
      orderId: "o-1",
      variantId: "v-2",
      quantity: 1,
      allergens: [],
    })

  it("REQUEST_CONFIRMATION: placed-order amend ADD with no disambiguation flag (the adjacent mis-frame must NOT silently EXECUTE)", () => {
    const decision = adjudicate(
      amendAddEnv(),
      state({ orderId: "o-1" }), // amendItemConfirmed absent ⇒ ambiguous/adjacent
      ordersPolicyBundle,
    )
    // The single residual the §2/§C guarantee line names: a wrong-but-adjacent
    // real-money action would otherwise EXECUTE and narrate truthfully. The
    // stakes-aware guard degrades it to a confirmation instead.
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    // Proposition-free, names the placed-order stakes (pt-BR, CLAUDE.md #4).
    expect(decision.prompt).toContain("pedido")
  })

  it("EXECUTE: placed-order amend ADD once the host disambiguates (amendItemConfirmed=true)", () => {
    const decision = adjudicate(
      amendAddEnv(),
      state({ orderId: "o-1", amendItemConfirmed: true }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE: the LOW-STAKES adjacent sibling order.item.add (cart op) is unaffected — no over-blocking", () => {
    const decision = adjudicate(
      env("order.item.add", {
        cartId: "cart-1",
        variantId: "v-1",
        quantity: 1,
        allergens: [],
      }),
      state(), // no amendItemConfirmed; cart op must still EXECUTE normally
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE-before-confirm: a structurally-invalid amend ADD (missing allergens) still REFUSEs — the §O#10 confirm never papers over data-validity", () => {
    const decision = adjudicate(
      env("order.amend.add_item", {
        orderId: "o-1",
        variantId: "v-2",
        quantity: 1,
        // allergens omitted — CLAUDE.md rule #1 REFUSE must precede the confirm
      }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("UNAFFECTED siblings: order.amend.update_qty / order.amend.remove_item still EXECUTE (only the registry's named adjacent pair is gated)", () => {
    const updateQty = adjudicate(
      env("order.amend.update_qty", { orderId: "o-1", itemId: "item-1", quantity: 2 }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(updateQty.kind).toBe("EXECUTE")

    const removeItem = adjudicate(
      env("order.amend.remove_item", { orderId: "o-1", itemId: "item-1" }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(removeItem.kind).toBe("EXECUTE")
  })

  // ── Inv 11 money bands UNCHANGED by this change ───────────────────────
  // The §O#10 guard keys on KIND, never on totalInCentavos, so the
  // refund/checkout/cancel amount-band verdicts are untouched. (Refund bands
  // live in pack-payments-pix; the order-domain bands are checkout+cancel.)
  it("Inv 11 UNCHANGED — checkout >= R$1.000 still REQUEST_CONFIRMATION (band, not §O#10)", () => {
    const decision = adjudicate(
      env("order.checkout.create", { cartId: "cart-1", paymentMethod: "card" }),
      state({ totalInCentavos: 150_000, paymentMethod: "card", paymentStatus: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
  })

  it("Inv 11 UNCHANGED — checkout < R$1.000 still EXECUTE (band, not §O#10)", () => {
    const decision = adjudicate(
      env("order.checkout.create", { cartId: "cart-1", paymentMethod: "card" }),
      state({ totalInCentavos: 50_000, paymentMethod: "card", paymentStatus: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("Inv 11 UNCHANGED — cancel >= R$1.000 still ESCALATE; checkout >= R$10.000 still REFUSE (bands, not §O#10)", () => {
    const cancel = adjudicate(
      env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
      state({ orderId: "o-1", totalInCentavos: 200_000 }),
      ordersPolicyBundle,
    )
    expect(cancel.kind).toBe("ESCALATE")

    const capped = adjudicate(
      env("order.checkout.create", { cartId: "cart-1", paymentMethod: "card" }),
      state({ totalInCentavos: 1_500_000, paymentMethod: "card", paymentStatus: null }),
      ordersPolicyBundle,
    )
    expect(capped.kind).toBe("REFUSE")
  })

  // ── NON-VACUITY: the guard is load-bearing ────────────────────────────
  // Rebuild the bundle with the §O#10 guard filtered out (by its function
  // name) and prove the EXACT same adjacent mis-frame then degrades to a
  // confident EXECUTE — i.e. the assertion above goes RED without the guard.
  // No shared state is mutated; the original bundle is untouched.
  it("NON-VACUITY: removing requireAmendItemDisambiguation flips the mis-frame back to EXECUTE", () => {
    const withGuard = adjudicate(
      amendAddEnv(),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(withGuard.kind).toBe("REQUEST_CONFIRMATION")

    const businessWithoutGuard = ordersPolicyBundle.business.filter(
      (g) => g.name !== "requireAmendItemDisambiguation",
    )
    // Sanity: exactly one guard was removed (the filter actually matched).
    expect(businessWithoutGuard.length).toBe(ordersPolicyBundle.business.length - 1)

    const bundleWithoutGuard = {
      ...ordersPolicyBundle,
      business: businessWithoutGuard,
    }
    const withoutGuard = adjudicate(
      amendAddEnv(),
      state({ orderId: "o-1" }),
      bundleWithoutGuard,
    )
    // The unsafe baseline §O#10 names: a confidently-narrated wrong real-money
    // action. Proves the guard — not some other gate — produces the safe verdict.
    expect(withoutGuard.kind).toBe("EXECUTE")
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

// ── FE-T09 (D-a): amend inversion — the model-visible capability re-route ──

describe("ordersCapabilityPlanner — FE-T09 amend inversion", () => {
  function authenticatedContext(): OrderContext {
    return { channel: "web", customerId: "c-1", cartId: "cart-1", orderId: null }
  }

  it("the grouped order.amend.request has NO reachable model producer (authenticated)", () => {
    const plan = ordersPack.planner.plan(state(), authenticatedContext())
    expect(plan.allowedIntents).not.toContain("order.amend.request")
  })

  it("the three granular amend kinds ARE model-proposable (authenticated)", () => {
    const plan = ordersPack.planner.plan(state(), authenticatedContext())
    expect(plan.allowedIntents).toContain("order.amend.add_item")
    expect(plan.allowedIntents).toContain("order.amend.update_qty")
    expect(plan.allowedIntents).toContain("order.amend.remove_item")
  })

  it("no amend kind (grouped or granular) is proposable for an unauthenticated/guest context", () => {
    const plan = ordersPack.planner.plan(state({ customerId: null }), {
      channel: "web",
      customerId: null,
      cartId: "cart-1",
      orderId: null,
    })
    expect(plan.allowedIntents).not.toContain("order.amend.request")
    expect(plan.allowedIntents).not.toContain("order.amend.add_item")
    expect(plan.allowedIntents).not.toContain("order.amend.update_qty")
    expect(plan.allowedIntents).not.toContain("order.amend.remove_item")
  })

  it("order.amend.request is STILL in ordersPack.intents[] — kernel-adjudicable, just not model-proposable (the legacy HTTP route still builds it directly)", () => {
    expect(ordersPack.intents).toContain("order.amend.request")
  })

  // FE-D28 — review-by-chat activation: order.review.submit joins the
  // authenticated allowedIntents (the resolver stamps the Identity-class
  // orderId/productId; the model only emits rating/comment + NL item/orderRef).
  it("order.review.submit IS model-proposable for an authenticated customer, never for a guest", () => {
    const authedPlan = ordersPack.planner.plan(state(), authenticatedContext())
    expect(authedPlan.allowedIntents).toContain("order.review.submit")
    const guestPlan = ordersPack.planner.plan(state({ customerId: null }), {
      channel: "web",
      customerId: null,
      cartId: "cart-1",
      orderId: null,
    })
    expect(guestPlan.allowedIntents).not.toContain("order.review.submit")
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

// ── BKL-090 — kernel transition-legality guard ────────────────────────────

/**
 * Envelope for `order.status.transition`. `sessionId` defaults to the ops/staff
 * `admin:` namespace (the live path this guard exists for); pass a non-`admin:`
 * id to exercise the lenient-on-absent generic contract.
 */
function transitionEnv(
  newStatus: string,
  opts: { orderId?: string; sessionId?: string } = {},
): IntentEnvelope<OrderIntentKind, OrderPayload> {
  return buildEnvelope({
    kind: "order.status.transition",
    payload: {
      orderId: opts.orderId ?? "o-1",
      newStatus,
      actor: "admin",
    } as OrderPayload,
    actor: {
      principal: "user",
      sessionId: opts.sessionId ?? "admin:staff-1",
      role: "OWNER",
    },
    taint: "TRUSTED",
    nonce: "n-test",
    createdAt: DET_TIME,
  })
}

describe("ordersPolicyBundle — transition legality (BKL-090)", () => {
  it("EXECUTE a legal advance (preparing → ready)", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      state({ orderId: "o-1", fulfillmentStatus: "preparing" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE an illegal target (confirmed → delivered)", () => {
    const decision = adjudicate(
      transitionEnv("delivered"),
      state({ orderId: "o-1", fulfillmentStatus: "confirmed" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.status.transition_illegal")
  })

  it("REFUSE from a terminal current state (delivered → preparing)", () => {
    const decision = adjudicate(
      transitionEnv("preparing"),
      state({ orderId: "o-1", fulfillmentStatus: "delivered" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.status.terminal")
  })

  it("REFUSE an unknown CURRENT status (fail-closed)", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      state({ orderId: "o-1", fulfillmentStatus: "bogus" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.status.unknown")
  })

  it("REFUSE an unknown TARGET status", () => {
    const decision = adjudicate(
      transitionEnv("teleported"),
      state({ orderId: "o-1", fulfillmentStatus: "preparing" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.status.unknown")
  })

  it("BKL-150(b): the guard itself does NOT normalize — a RAW en-GB 'cancelled' is an unknown target here; only the ops resolver's normalizeOrderStatusToken maps it to 'canceled' upstream, keeping this guard strict", () => {
    const decision = adjudicate(
      transitionEnv("cancelled"),
      state({ orderId: "o-1", fulfillmentStatus: "preparing" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.status.unknown")
    // The canonical token IS accepted (preparing → canceled is legal) — proving
    // the ONLY thing missing for the raw token was the resolver-side spelling fix.
    const ok = adjudicate(
      transitionEnv("canceled"),
      state({ orderId: "o-1", fulfillmentStatus: "preparing" }),
      ordersPolicyBundle,
    )
    expect(ok.kind).not.toBe("REFUSE")
  })

  it("REFUSE an ABSENT current status on the admin: ops plane (fail-closed)", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      // No fulfillmentStatus projected — an admin: envelope MUST carry one.
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.status.unknown")
  })

  it("lenient on an ABSENT status for a NON-admin session (no live caller; keeps generic contract EXECUTE)", () => {
    const decision = adjudicate(
      transitionEnv("ready", { sessionId: "s-1" }),
      state({ orderId: "o-1" }),
      ordersPolicyBundle,
    )
    // Non-admin + absent status → the legality guard SKIPS; executeW5Kinds runs.
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE no_order BEFORE the legality guard when the order is missing", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      state({ orderId: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    // requireOrderIdForMutation precedes requireLegalStatusTransition.
    expect(decision.refusal.code).toBe("order.not_found")
  })
})

// ── FE-T05 — grounded-resolution confirmation forcing (Language Engine) ──

describe("ordersPolicyBundle — requireConfirmationOnGroundedStatusTransition (FE-T05)", () => {
  it("REQUEST_CONFIRMATION on a GROUNDED (auto-resolved) target, even though the transition is legal — and NAMES the order (MAJOR-2)", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      state({
        orderId: "o-1",
        fulfillmentStatus: "preparing",
        orderResolutionTrust: "grounded",
        displayId: 928379,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toBe(
      'Não me disseram qual pedido — vou usar o pedido #928379. ' +
        'Confirma avançar o pedido #928379 para "ready"?',
    )
  })

  it("BKL-190: a grounded target the CURRENT message NAMED confirms WITHOUT the false 'não me disseram' frame", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      state({
        orderId: "o-1",
        fulfillmentStatus: "preparing",
        orderResolutionTrust: "grounded",
        displayId: 928379,
        orderNamedInMessage: true,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toBe('Confirma avançar o pedido #928379 para "ready"?')
    expect(decision.prompt).not.toContain("Não me disseram")
  })

  it("BKL-190: orderNamedInMessage false/absent keeps the honest 'não me disseram' frame verbatim", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      state({
        orderId: "o-1",
        fulfillmentStatus: "preparing",
        orderResolutionTrust: "grounded",
        displayId: 928379,
        orderNamedInMessage: false,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toBe(
      'Não me disseram qual pedido — vou usar o pedido #928379. ' +
        'Confirma avançar o pedido #928379 para "ready"?',
    )
  })

  it("REQUEST_CONFIRMATION with the generic phrasing when displayId is unavailable (defensive fallback — should not be reachable in practice)", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      state({
        orderId: "o-1",
        fulfillmentStatus: "preparing",
        orderResolutionTrust: "grounded",
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toContain("o pedido mais recente em aberto")
  })

  it("EXECUTE on an AUTHORITATIVE (explicit-reference) target — no re-confirmation", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      state({
        orderId: "o-1",
        fulfillmentStatus: "preparing",
        orderResolutionTrust: "authoritative",
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE when orderResolutionTrust is ABSENT — byte-identical to pre-FE-T05 behaviour", () => {
    const decision = adjudicate(
      transitionEnv("ready"),
      state({ orderId: "o-1", fulfillmentStatus: "preparing" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("an ILLEGAL transition still REFUSEs outright even when GROUNDED — legality is checked FIRST", () => {
    const decision = adjudicate(
      transitionEnv("delivered"),
      state({
        orderId: "o-1",
        fulfillmentStatus: "confirmed",
        orderResolutionTrust: "grounded",
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.status.transition_illegal")
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

// ── BKL-145 — the admin-session actor is an authenticated principal ─────────
// The `admin:` sessionId namespace is minted only behind the staff JWT and the
// actor is composition-stamped (NEW-032 slice-A pins), so a staff-plane note on
// an UNRESOLVED order must fall through to the honest `order.not_found` — never
// the customer-onboarding `auth.required`. Customer/guest planes byte-identical.

function adminEnv(
  kind: OrderIntentKind,
  payload: Record<string, unknown>,
): IntentEnvelope<OrderIntentKind, OrderPayload> {
  return buildEnvelope({
    kind,
    payload: payload as OrderPayload,
    actor: { principal: "user", sessionId: "admin:staff-1" },
    taint: "UNTRUSTED",
    nonce: "n-test-admin",
    createdAt: DET_TIME,
  })
}

describe("BKL-145 — admin-session note.add auth recognition", () => {
  it("admin session + UNRESOLVED order → honest order.not_found (NOT auth.required)", () => {
    const decision = adjudicate(
      adminEnv("order.note.add", { orderId: "", body: "cliente vai atrasar" }),
      state({ customerId: null, orderId: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.not_found")
  })

  it("admin session + RESOLVED order (customer null) → the note EXECUTEs", () => {
    const decision = adjudicate(
      adminEnv("order.note.add", { orderId: "ord-1", body: "cliente vai atrasar" }),
      state({ customerId: null, orderId: "ord-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("customer plane unchanged: a NON-admin unauthenticated session still gets auth.required", () => {
    const decision = adjudicate(
      env("order.note.add", { orderId: "ord-1", body: "oi" }),
      state({ customerId: null, orderId: "ord-1" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("auth.required")
  })
})
