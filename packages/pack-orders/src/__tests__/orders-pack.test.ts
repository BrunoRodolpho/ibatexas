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

  // ── BKL-216 — the amend in-message order-reference ambiguity CLARIFY ──────
  //
  // `resolveAmendOrderReference` (apps/api resolve-and-assemble.ts) resolves NO
  // orderId when the message named ≥2 of the customer's OWN orders, stamping
  // `orderReferenceAmbiguous*` instead. This guard must voice WHICH orders rather
  // than let the turn fall to the generic `order.not_found` — the orders WERE
  // found, the resolver just would not pick between two the customer named.
  const AMBIGUITY_KINDS: readonly OrderIntentKind[] = [
    "order.amend.request",
    "order.amend.add_item",
    "order.amend.update_qty",
    "order.amend.remove_item",
  ]

  it.each(AMBIGUITY_KINDS)(
    "%s: ≥2 named owned orders → REFUSE order.ambiguous_reference (pre-empts order.not_found) and voices both numbers",
    (kind) => {
      const decision = adjudicate(
        env(kind, {
          item: "coca",
          orderReferenceAmbiguousCount: 2,
          orderReferenceAmbiguousDisplayIds: [960763, 933869],
        }),
        state({ orderId: null }),
        ordersPolicyBundle,
      )
      expect(decision.kind).toBe("REFUSE")
      if (decision.kind !== "REFUSE") return
      expect(decision.refusal.code).toBe("order.ambiguous_reference")
      expect(decision.refusal.userFacing).toContain("#960763")
      expect(decision.refusal.userFacing).toContain("#933869")
      expect(decision.refusal.userFacing).toContain("Em qual deles?")
    },
  )

  it("the ambiguity refusal carries the count in its audit basis (machine-readable, not just copy)", () => {
    const decision = adjudicate(
      env("order.amend.remove_item", {
        item: "coca",
        orderReferenceAmbiguousCount: 3,
        orderReferenceAmbiguousDisplayIds: [1, 2, 3],
      }),
      state({ orderId: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(
      decision.basis.some(
        (b) =>
          (b.detail as { reason?: string } | undefined)?.reason ===
            "order_reference_ambiguous" &&
          (b.detail as { count?: number } | undefined)?.count === 3,
      ),
    ).toBe(true)
  })

  it("NO ambiguity marker → the guard is inert; an unresolved amend keeps the honest order.not_found", () => {
    const decision = adjudicate(
      env("order.amend.remove_item", { item: "coca" }),
      state({ orderId: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.not_found")
  })

  it("a malformed (non-numeric) count is inert, not fail-open — order.not_found stands", () => {
    const decision = adjudicate(
      env("order.amend.remove_item", {
        item: "coca",
        orderReferenceAmbiguousCount: "2",
        orderReferenceAmbiguousDisplayIds: [1, 2],
      }),
      state({ orderId: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.not_found")
  })

  it("missing/garbled displayIds still CLARIFY, and never fabricate a number", () => {
    const decision = adjudicate(
      env("order.amend.remove_item", {
        item: "coca",
        orderReferenceAmbiguousCount: 2,
        orderReferenceAmbiguousDisplayIds: ["nope", null],
      }),
      state({ orderId: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.ambiguous_reference")
    expect(decision.refusal.userFacing).toBe(
      "Você citou mais de um pedido. Em qual deles?",
    )
    expect(decision.refusal.userFacing).not.toContain("#")
  })

  // Scope pin: the marker is only ever stamped for order.amend.* (BKL-198 owns the
  // rest of the mutation plane), so the guard must not fire for other kinds.
  it("order.cancel carrying the marker is NOT clarified by this guard (scope pin)", () => {
    const decision = adjudicate(
      env("order.cancel", {
        orderId: "o-1",
        orderReferenceAmbiguousCount: 2,
        orderReferenceAmbiguousDisplayIds: [1, 2],
      }),
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
  //
  // F-26 — `enforceOrderOwnership` has TWO conjuncts and they REFUSE with the SAME
  // code (`order.ownership_denied`): (1) the BINDING — the declared owner does not
  // own the resource — and (2) the IDOR gate — the authenticated principal behind
  // the acting session is not the declared owner. A code-only assertion cannot tell
  // them apart, so either conjunct silently stands in for the other. Measured: with
  // the two branches' reasons SWAPPED, all 222 tests in this package stayed green.
  // The discriminating information is the auth basis `reason`, so every test below
  // that drives a conjunct pins WHICH one spoke. Mirrors the house style of the
  // adopter's claustrum/__tests__/ownership-set-agreement.test.ts (PR #530).
  const BINDING_CONJUNCT = "resource_not_owned"
  const IDOR_CONJUNCT = "tenant_binding_violation"

  /**
   * Flattens a decision to `EXECUTE` / `REQUEST_CONFIRMATION` / `REFUSE:<code>:<auth
   * basis reason>` so one assertion reds by NAME on both the code and the conjunct.
   * The basis row is keyed `category` (never `kind`).
   */
  function outcome(decision: unknown): string {
    const d = decision as {
      kind: string
      refusal?: { code?: string }
      basis?: readonly { category?: string; detail?: { reason?: string } }[]
    }
    if (d.kind !== "REFUSE") return d.kind
    const reason = d.basis?.find((b) => b.category === "auth")?.detail?.reason ?? "no-auth-basis"
    return `REFUSE:${d.refusal?.code}:${reason}`
  }

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

  it("OWNERSHIP CANARY (de-vacuumed): cancelling a NON-owned order REFUSEs order.ownership_denied from the BINDING conjunct", () => {
    // store binds cust-A → order-A only; the envelope targets order-B → unbound → REFUSE.
    // The session IS the authenticated owner (sess-A → cust-A), so the IDOR conjunct
    // is not what spoke — but it WOULD speak with the SAME code if the binding branch
    // were neutered (an unbound resource resolves principal to null, which also fails
    // the IDOR equality). Pinning the conjunct is what makes this canary test its own
    // mechanism instead of accepting the other one's refusal. See F-26 above.
    const decision = adjudicate(cancelEnv("cust-A", "order-B", "sess-A"), authState("cust-A", "order-A", "sess-A", "order-B"), ordersPolicyBundle)
    expect(decision.kind).toBe("REFUSE")
    expect(outcome(decision)).toBe(`REFUSE:order.ownership_denied:${BINDING_CONJUNCT}`)
  })

  it("OWNERSHIP IDOR-gate: an unrecognised session acting on an owned order REFUSEs — from the IDOR conjunct, not the binding", () => {
    // resource IS owned (bound), but principalOf(sess-B)=null != owner → IDOR REFUSE.
    // Asserting the conjunct is what makes the name ("IDOR-gate") the tested part: a
    // code-only pin is satisfied by the binding conjunct just as well. See F-26 above.
    const decision = adjudicate(cancelEnv("cust-A", "order-A", "sess-B"), authState("cust-A", "order-A", "sess-A", "order-A"), ordersPolicyBundle)
    expect(decision.kind).toBe("REFUSE")
    expect(outcome(decision)).toBe(`REFUSE:order.ownership_denied:${IDOR_CONJUNCT}`)
  })

  it("F-26 — the two conjuncts are DISTINGUISHABLE: same code, different reason, on the same fixtures", () => {
    // The finding itself, pinned as a standing claim: swapping the guard's two
    // branches must not be a no-op. Same helper, same authority graph — the only
    // difference between the rows is which conjunct the input trips.
    const binding = outcome(
      adjudicate(cancelEnv("cust-A", "order-B", "sess-A"), authState("cust-A", "order-A", "sess-A", "order-B"), ordersPolicyBundle),
    )
    const idor = outcome(
      adjudicate(cancelEnv("cust-A", "order-A", "sess-B"), authState("cust-A", "order-A", "sess-A", "order-A"), ordersPolicyBundle),
    )
    // The codes AGREE (that is the shadowing hazard)…
    expect(binding.split(":")[1]).toBe(idor.split(":")[1])
    // …and the reasons DISAGREE (that is what defeats it).
    expect([binding, idor]).toEqual([
      `REFUSE:order.ownership_denied:${BINDING_CONJUNCT}`,
      `REFUSE:order.ownership_denied:${IDOR_CONJUNCT}`,
    ])
    expect(BINDING_CONJUNCT).not.toBe(IDOR_CONJUNCT)
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

// ── Business: guard ORDER is protective (F-57) ──────────────────────────

/**
 * `validateQuantity` sits ABOVE `clampUpdateToStockCap` in the business
 * phase, and these tests exist so that fact cannot be edited away silently.
 * Before this block the whole suite was 223/223 GREEN with the two guards in
 * EITHER order, while swapping them turns a REFUSE of a malformed proposal
 * into a clamp-then-EXECUTE of a laundered one.
 *
 * The two cases are a CONTROL/TREATMENT pair on ONE variable — integrality —
 * and the control is what stops the treatment from being vacuous. Identical
 * kind, itemId, state and stockCap; identical over-cap relation (both request
 * more than the cap of 3). The control REWRITEs, which PROVES the clamp
 * engages on exactly this envelope+state shape; so when the treatment REFUSEs
 * instead, the only thing that can explain it is which guard ran first. Drop
 * the control and the treatment would still pass with the clamp deleted
 * entirely, and would be pinning nothing.
 *
 * Revert-to-red: swap the two entries in `ordersPolicyBundle.business` and
 * the treatment must RED (it becomes REWRITE). Measured — see F-57.
 */
describe("ordersPolicyBundle — guard ORDER is protective (F-57)", () => {
  const cappedAtThree = {
    items: [
      {
        variantId: "v-1",
        quantity: 1,
        priceInCentavos: 5_000,
        stockCap: 3,
      },
    ],
  }

  it("CONTROL: an INTEGER over-cap quantity REWRITEs — the clamp does engage here", () => {
    const decision = adjudicate(
      env("order.item.update", {
        cartId: "cart-1",
        itemId: "v-1",
        quantity: 7,
      }),
      state(cappedAtThree),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REWRITE")
    if (decision.kind !== "REWRITE") return
    expect(
      (decision.rewritten.payload as { quantity: number }).quantity,
    ).toBe(3)
  })

  it("TREATMENT: a NON-INTEGER over-cap quantity REFUSEs, and is never clamped into an EXECUTE", () => {
    const decision = adjudicate(
      env("order.item.update", {
        cartId: "cart-1",
        itemId: "v-1",
        quantity: 7.5,
      }),
      state(cappedAtThree),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("order.item.quantity_invalid")
    // The failure this pins is not "some refusal happened" but "the malformed
    // 7.5 never became a well-formed 3". Name the value so a future clamp-first
    // ordering cannot satisfy this test by refusing for some later reason.
    expect(decision.refusal.detail).toBe("quantity=7.5")
  })
})

// ── Business: KNOWN HOLE — zero stockCap clamps to an invalid quantity ──

/**
 * CHARACTERIZATION, not an endorsement (F-57). `stockCap: 0` is a DEFINED
 * cap, so `clampUpdateToStockCap` engages and rewrites any positive request
 * to `quantity: 0` — a value `validateQuantity` itself rejects (`q <= 0`),
 * reached because the clamp runs after validation and the kernel does not
 * re-validate a rewritten envelope.
 *
 * This test asserts what the Pack DOES today so the hole stays visible; it is
 * not a claim that this is correct. Closing it is a behaviour change (REFUSE
 * where an EXECUTE happens now, via `refuseQuantityOverLimit`) and is open
 * with the governor. When that ruling lands, this test SHOULD be replaced —
 * deleting it is the intended outcome of the fix, not a regression.
 *
 * Inert in the ibatexas host: nothing populates `stockCap` and the live
 * `ctx.items` is `undefined`, so this is an adopter-facing contract defect.
 */
describe("ordersPolicyBundle — stockCap: 0 (known hole, F-57)", () => {
  it("clamps a positive request to quantity 0 and does NOT refuse", () => {
    const decision = adjudicate(
      env("order.item.update", {
        cartId: "cart-1",
        itemId: "v-1",
        quantity: 5,
      }),
      state({
        items: [
          {
            variantId: "v-1",
            quantity: 1,
            priceInCentavos: 5_000,
            stockCap: 0,
          },
        ],
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REWRITE")
    if (decision.kind !== "REWRITE") return
    expect(
      (decision.rewritten.payload as { quantity: number }).quantity,
    ).toBe(0)
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

// ── Business: the reorder-last whole-workflow confirm (LE2-021) ──────────
//
// Driven through `adjudicate` against the REAL bundle, not by calling the guard
// directly: the guard's whole contract is its position in `business[]` — above
// `executeW5Kinds`, which also matches this kind — and a direct call would prove
// the body works while saying nothing about whether it is reachable.

describe("ordersPolicyBundle — confirmReorderLast (LE2-021)", () => {
  const PREVIOUS_ORDER = {
    previousOrderId: "order_prev_1",
    previousOrderDisplayId: 1042,
    previousOrderTotalInCentavos: 12_500,
    previousOrderItems: [
      { title: "Costela bovina defumada", quantity: 2 },
      { title: "Pão de alho", quantity: 1 },
      { title: "Farofa de bacon", quantity: 1 },
    ],
  }

  /** A reorder-request state: authenticated, with (or without) a previous order. */
  function reorderState(overrides: Partial<OrderState["ctx"]> = {}): OrderState {
    return state({
      cartId: null,
      orderId: null,
      items: undefined,
      totalInCentavos: undefined,
      ...overrides,
    })
  }

  const reorderEnv = () => env("order.reorder.request", {})

  it("REQUEST_CONFIRMATION naming the projected items and the projected total", () => {
    const decision = adjudicate(
      reorderEnv(),
      reorderState(PREVIOUS_ORDER),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    expect((decision as { prompt?: string }).prompt).toBe(
      "Vou repetir seu último pedido: 2x Costela bovina defumada, 1x Pão de alho, " +
        "1x Farofa de bacon, total R$ 125,00. Confirma?",
    )
  })

  it("QUOTES the projected total — it does not add the lines up", () => {
    // The lines here sum to R$ 30,00; the projection says R$ 125,00 (a real
    // order carries shipping and tips). The guard must say what the projection
    // says. If it ever starts computing, this is the assertion that catches it.
    const decision = adjudicate(
      reorderEnv(),
      reorderState({
        ...PREVIOUS_ORDER,
        previousOrderItems: [{ title: "Costela", quantity: 1 }],
      }),
      ordersPolicyBundle,
    )
    expect((decision as { prompt?: string }).prompt).toContain("total R$ 125,00")
    expect((decision as { prompt?: string }).prompt).not.toContain("R$ 30,00")
  })

  it("caps the item list at three and counts the remainder", () => {
    const decision = adjudicate(
      reorderEnv(),
      reorderState({
        ...PREVIOUS_ORDER,
        previousOrderItems: [
          ...PREVIOUS_ORDER.previousOrderItems,
          { title: "Vinagrete", quantity: 1 },
          { title: "Guaraná", quantity: 3 },
        ],
      }),
      ordersPolicyBundle,
    )
    expect((decision as { prompt?: string }).prompt).toContain(
      "1x Farofa de bacon e mais 2 itens, total R$ 125,00",
    )
  })

  it("uses the SINGULAR for a remainder of one", () => {
    const decision = adjudicate(
      reorderEnv(),
      reorderState({
        ...PREVIOUS_ORDER,
        previousOrderItems: [
          ...PREVIOUS_ORDER.previousOrderItems,
          { title: "Vinagrete", quantity: 1 },
        ],
      }),
      ordersPolicyBundle,
    )
    expect((decision as { prompt?: string }).prompt).toContain("e mais 1 item,")
  })

  // ── The no-history REFUSE, one case per missing field ──────────────────
  // Four fields, four independent absences. Parameterised because a single
  // "no previous order" case would leave three of them free to be dropped from
  // the condition without a test noticing.
  it.each([
    ["previousOrderId", { previousOrderId: undefined }],
    ["previousOrderTotalInCentavos", { previousOrderTotalInCentavos: undefined }],
    ["previousOrderItems", { previousOrderItems: undefined }],
    ["an EMPTY item list", { previousOrderItems: [] }],
  ])("REFUSEs honestly when %s is absent", (_label, missing) => {
    const decision = adjudicate(
      reorderEnv(),
      reorderState({ ...PREVIOUS_ORDER, ...(missing as Partial<OrderState["ctx"]>) }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    const refusal = (decision as { refusal?: { code?: string; userFacing?: string } }).refusal
    expect(refusal?.code).toBe("order.reorder.no_history")
    // HONEST: a state fact, never a permission frame.
    expect(refusal?.userFacing).toBe(
      "Ainda não encontrei nenhum pedido anterior seu pra repetir. Quer montar um novo?",
    )
    expect(refusal?.userFacing).not.toContain("não permitida")
  })

  it("REFUSEs an unwired host — no previousOrder* fields at all", () => {
    const decision = adjudicate(reorderEnv(), reorderState(), ordersPolicyBundle)
    expect(decision.kind).toBe("REFUSE")
    expect(
      (decision as { refusal?: { code?: string } }).refusal?.code,
    ).toBe("order.reorder.no_history")
  })

  it("is INERT for every other kind", () => {
    // The guard's first line. Without it a projected previous order would park
    // an unrelated cart operation.
    const decision = adjudicate(
      env("order.cart.ensure", { cartId: "cart-1" }),
      state(PREVIOUS_ORDER),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  // ── NON-VACUITY: the confirm is the only thing between the customer and
  // an unasked cart rebuild. Same shape as the §O#10 proof above.
  it("NON-VACUITY: removing confirmReorderLast flips the reorder to EXECUTE", () => {
    const withGuard = adjudicate(
      reorderEnv(),
      reorderState(PREVIOUS_ORDER),
      ordersPolicyBundle,
    )
    expect(withGuard.kind).toBe("REQUEST_CONFIRMATION")

    const businessWithoutGuard = ordersPolicyBundle.business.filter(
      (g) => g.name !== "confirmReorderLast",
    )
    expect(businessWithoutGuard.length).toBe(ordersPolicyBundle.business.length - 1)

    const withoutGuard = adjudicate(
      reorderEnv(),
      reorderState(PREVIOUS_ORDER),
      { ...ordersPolicyBundle, business: businessWithoutGuard },
    )
    // `executeW5Kinds` matches this kind too, and it sits BELOW the confirm.
    // Removing the confirm does not fail the kind closed — it silently executes
    // it, which is exactly why the ordering in `business[]` is load-bearing.
    expect(withoutGuard.kind).toBe("EXECUTE")
  })

  it("REFUSEs an UNAUTHENTICATED reorder before the confirm is ever considered", () => {
    // `order.reorder.request` is absent from SYSTEM_OR_ANON_KINDS, so
    // `requireAuthenticated` (an auth-phase guard) fires first. Asserted so the
    // kind's auth posture is a tested property rather than an omission.
    const decision = adjudicate(
      reorderEnv(),
      reorderState({ ...PREVIOUS_ORDER, customerId: null as unknown as string }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    expect(
      (decision as { refusal?: { code?: string } }).refusal?.code,
    ).not.toBe("order.reorder.no_history")
  })
})

// ── Business: the swap-for-coupon whole-workflow confirm (LE2-023) ───────
//
// Driven through `adjudicate` against the REAL bundle for the same reason the
// reorder block above is: this guard's contract is its POSITION in `business[]`
// — above `executeW5Kinds`, which matches `order.coupon.swap.request` too — and
// a direct call would prove the body works while saying nothing about whether it
// is reachable.
//
// THE SENTENCE TEST IS THE POINT OF THIS BLOCK. The workflow declares
// `confirm.statesFacts: ["orderAmount", "refundConsequence", "newTotal"]`, and
// the cancel activity declares a coverage claiming the first two. The compiler
// checks that claim against the workflow's own claim (`confirm-coverage-unstated`);
// nothing static can check either against the guard's actual WORDS, because the
// words live in this package. So these tests are the other half of that gate:
// they drive the real guard and assert the real sentence carries each declared
// fact. A copy edit here that dropped the amount would turn the coverage into a
// lie, and this is the only thing that would notice.

describe("ordersPolicyBundle — confirmSwapForCoupon (LE2-023)", () => {
  /** A feasible, PAID swap: every ctx field the guard needs, all present. */
  const FEASIBLE_PAID = {
    previousOrderId: "order_prev_9",
    previousOrderDisplayId: 2087,
    previousOrderTotalInCentavos: 12_000,
    previousOrderIsCancelable: true,
    previousOrderPaymentIsSettled: true,
    couponIsValid: true,
    couponNewTotalInCentavos: 10_800,
    couponCode: "BEMVINDO10",
  }

  function swapState(overrides: Partial<OrderState["ctx"]> = {}): OrderState {
    return state({
      cartId: null,
      orderId: null,
      items: undefined,
      totalInCentavos: undefined,
      paymentStatus: null,
      ...overrides,
    })
  }

  // The code rides the payload (a customer-authored slot) but the guard must
  // never quote it — see the `couponCode` ctx field's doc. The payload here
  // deliberately carries a DIFFERENT spelling from the ctx so the assertion
  // below can tell the two apart.
  const swapEnv = () => env("order.coupon.swap.request", { code: "bemvindo10" })

  it("GATE 2 — the confirm sentence STATES all three declared facts", () => {
    const decision = adjudicate(swapEnv(), swapState(FEASIBLE_PAID), ordersPolicyBundle)
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    const prompt = (decision as { prompt?: string }).prompt ?? ""

    // `orderAmount` — the projected order total, as money.
    expect(prompt).toContain("R$ 120,00")
    // `refundConsequence` — that the money comes back.
    expect(prompt).toContain("reembolso")
    // `newTotal` — what the customer pays after the route completes.
    expect(prompt).toContain("R$ 108,00")
  })

  it("quotes the STORE's spelling of the coupon, never the payload's", () => {
    const decision = adjudicate(swapEnv(), swapState(FEASIBLE_PAID), ordersPolicyBundle)
    const prompt = (decision as { prompt?: string }).prompt ?? ""
    // ctx says BEMVINDO10, the payload said bemvindo10. The sentence a customer
    // approves a cancellation against must not be assembled from untrusted text.
    expect(prompt).toContain("BEMVINDO10")
    expect(prompt).not.toContain("bemvindo10")
  })

  it("names the order by its DISPLAY id, the number a customer recognises", () => {
    const decision = adjudicate(swapEnv(), swapState(FEASIBLE_PAID), ordersPolicyBundle)
    expect((decision as { prompt?: string }).prompt ?? "").toContain("#2087")
  })

  // ── The directional negative for the refund clause. ──────────────────────
  //
  // The clause is CONDITIONAL on `previousOrderPaymentIsSettled`, which is
  // exactly the condition under which `gatePaidCancel` asks the question the
  // workflow's coverage covers. So on the unpaid shape the clause must be
  // ABSENT — we do not promise a refund that is not coming — and there is also
  // no coverable confirm to resolve, because `gatePaidCancel` returns null.
  // Without this test the conditional could collapse to unconditional and the
  // GATE 2 test above would still pass.
  it("OMITS the refund clause when the order was never PAID", () => {
    const decision = adjudicate(
      swapEnv(),
      swapState({ ...FEASIBLE_PAID, previousOrderPaymentIsSettled: false }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    const prompt = (decision as { prompt?: string }).prompt ?? ""
    expect(prompt).not.toContain("reembolso")
    // …and still states the two facts that ARE true of an unpaid swap.
    expect(prompt).toContain("R$ 120,00")
    expect(prompt).toContain("R$ 108,00")
  })

  it("REFUSEs `order.reorder.no_history` when there is no previous order", () => {
    const decision = adjudicate(
      swapEnv(),
      swapState({ ...FEASIBLE_PAID, previousOrderId: undefined }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    expect((decision as { refusal?: { code?: string } }).refusal?.code).toBe(
      "order.reorder.no_history",
    )
  })

  it("REFUSEs `order.past_ponr` for an order past the point of no return", () => {
    const decision = adjudicate(
      swapEnv(),
      swapState({ ...FEASIBLE_PAID, previousOrderIsCancelable: false }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    expect((decision as { refusal?: { code?: string } }).refusal?.code).toBe(
      "order.past_ponr",
    )
  })

  it("REFUSEs `order.coupon.not_usable` for a coupon the store rejected", () => {
    const decision = adjudicate(
      swapEnv(),
      swapState({ ...FEASIBLE_PAID, couponIsValid: false }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    expect((decision as { refusal?: { code?: string } }).refusal?.code).toBe(
      "order.coupon.not_usable",
    )
  })

  // ABSENT is not the same fact as `false` (Inv 7 — "could not check" is not
  // "not valid"), and the projection keeps them apart on purpose. They converge
  // on ONE refusal here because the only honest sentence is about what we could
  // establish about ourselves; see `refuseCouponNotUsable`'s doc. Asserted so
  // the convergence is a tested decision rather than an accident of `!== true`.
  it("REFUSEs the same way when the coupon lookup could not be MADE at all", () => {
    const decision = adjudicate(
      swapEnv(),
      swapState({ ...FEASIBLE_PAID, couponIsValid: undefined }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    expect((decision as { refusal?: { code?: string } }).refusal?.code).toBe(
      "order.coupon.not_usable",
    )
  })

  it("REFUSEs `order.coupon.swap.total_unknown` for a VALID but unpriceable coupon", () => {
    const decision = adjudicate(
      swapEnv(),
      swapState({ ...FEASIBLE_PAID, couponNewTotalInCentavos: undefined }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    // Its OWN code, not `order.coupon.not_usable`: nothing is wrong with the
    // customer's coupon, so the useful answer points them at checkout rather
    // than at a different code.
    expect((decision as { refusal?: { code?: string } }).refusal?.code).toBe(
      "order.coupon.swap.total_unknown",
    )
  })

  // ── NON-VACUITY. The confirm is the only thing between the customer and an
  // unasked CANCELLATION of a real, paid order.
  it("NON-VACUITY: removing confirmSwapForCoupon flips the swap to EXECUTE", () => {
    const withGuard = adjudicate(swapEnv(), swapState(FEASIBLE_PAID), ordersPolicyBundle)
    expect(withGuard.kind).toBe("REQUEST_CONFIRMATION")

    const businessWithoutGuard = ordersPolicyBundle.business.filter(
      (g) => g.name !== "confirmSwapForCoupon",
    )
    expect(businessWithoutGuard.length).toBe(ordersPolicyBundle.business.length - 1)

    const withoutGuard = adjudicate(swapEnv(), swapState(FEASIBLE_PAID), {
      ...ordersPolicyBundle,
      business: businessWithoutGuard,
    })
    // `executeW5Kinds` matches this kind and sits BELOW the confirm, so removing
    // the confirm does not fail the kind closed — it silently executes it. That
    // is precisely why the ordering in `business[]` is load-bearing, and why the
    // guard's own doc says so.
    expect(withoutGuard.kind).toBe("EXECUTE")
  })

  it("REFUSEs an UNAUTHENTICATED swap before the confirm is ever considered", () => {
    const decision = adjudicate(
      swapEnv(),
      swapState({ ...FEASIBLE_PAID, customerId: null as unknown as string }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    expect((decision as { refusal?: { code?: string } }).refusal?.code).not.toBe(
      "order.coupon.not_usable",
    )
  })
})

// ── LE2-023 · THE SECOND LOCK, proven behaviourally ──────────────────────────
//
// `order.coupon.adjust` is declared so the swap-for-coupon workflow's
// `coupon_on_placed_order` branch can NAME a real capability while shipping
// closed. Two independent locks keep it unexecutable, in two packages:
//
//   LOCK 1 (catalog)     — `workflowScoped: true`, so no parse can propose it.
//                          Pinned in the catalog's own projection tests and in
//                          apps/api's WORKFLOW_SCOPED_KINDS pin.
//   LOCK 2 (this bundle)  — no guard produces EXECUTE for the kind, so the
//                          kernel's DEFAULT REFUSE is the only verdict it can
//                          ever receive.
//
// This block is lock 2, and it is a BEHAVIOURAL assertion rather than a
// structural one on purpose. The catalog cannot see guard verdicts (the same
// reason `escalatable` is review-enforced), so "the pack refuses it" can only be
// established by adjudicating it. It is the force-the-route-open experiment: the
// route branch is bypassed entirely here — the envelope is submitted directly, as
// though the switch were open — and the kind is still refused.

describe("ordersPolicyBundle — order.coupon.adjust is DECLARED AND UNEXECUTABLE (LE2-023)", () => {
  it("REFUSEs even on the shape most likely to succeed", () => {
    // Authenticated, owning a live cart, a valid-looking code — everything a
    // coupon apply would need. `order.coupon.apply` EXECUTEs on this state; this
    // kind must not.
    const decision = adjudicate(
      env("order.coupon.adjust", { cartId: "cart-1", orderId: "order-1", code: "BEMVINDO10" }),
      state({ orderId: "order-1", fulfillmentStatus: "pending", paymentStatus: "paid" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("is refused by the DEFAULT DENY, not by an incidental guard", () => {
    // The distinction matters for the lock's durability. A refusal from some
    // state guard would evaporate the moment a caller supplied whatever that
    // guard wanted; a DEFAULT-DENY refusal cannot be satisfied by any payload or
    // state at all, because no guard in the bundle claims the kind. So this
    // asserts the SHAPE of the protection, not merely its current effect.
    const decision = adjudicate(
      env("order.coupon.adjust", { cartId: "cart-1", orderId: "order-1", code: "BEMVINDO10" }),
      state({ orderId: "order-1", fulfillmentStatus: "pending", paymentStatus: "paid" }),
      ordersPolicyBundle,
    )
    // `default_deny` is the KERNEL's own code, not this pack's declared
    // `order.default.deny` — which is the stronger reading: the refusal is not
    // authored anywhere in this bundle at all. No guard here has an opinion
    // about the kind, so the kernel falls all the way through to its
    // default-REFUSE floor. That floor cannot be satisfied by any payload or
    // state, which is precisely the property the lock needs.
    expect((decision as { refusal?: { code?: string } }).refusal?.code).toBe("default_deny")
  })

  it("CONTROL: the same state EXECUTEs the real cart coupon apply", () => {
    // Without this the two cases above could pass because the state was wrong
    // rather than because the kind is unexecutable — the vacuity that makes a
    // negative test worthless. `order.coupon.apply` is the nearest neighbour and
    // the capability this route actually uses.
    const decision = adjudicate(
      env("order.coupon.apply", { cartId: "cart-1", code: "BEMVINDO10" }),
      state({ orderId: null, fulfillmentStatus: undefined, paymentStatus: null }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("appears in NO execute-producing kind set", () => {
    // The structural complement of the behavioural cases: a future edit that
    // adds the kind to an EXECUTE producer would flip the two REFUSE assertions
    // above, but this one says WHY in one line at the point of the mistake.
    const decision = adjudicate(
      env("order.coupon.adjust", {}),
      state({}),
      ordersPolicyBundle,
    )
    expect(decision.kind).not.toBe("EXECUTE")
    expect(decision.kind).not.toBe("REQUEST_CONFIRMATION")
  })
})

/**
 * BKL-280 — the stay-home / pickup contradiction guard.
 *
 * The V7-proven defect: on "não vou poder sair de casa hoje, fecha aí, pago em
 * dinheiro na entrega" the 4B emits `order.checkout.create {delivery_type:
 * "pickup", payment_method: "cash"}` — a valid capability with a wrong payload,
 * which EXECUTES. `confirmDeliveryContradiction` turns that one case into a
 * question without touching any other checkout path.
 *
 * Note the state these tests use: `totalInCentavos: 5_000` (R$ 50) sits BELOW
 * the R$ 1.000 `confirmLargeTicket` band, so any REQUEST_CONFIRMATION observed
 * here is unambiguously THIS guard's and never the money band's — and the
 * prompt assertions pin exactly which sentence was asked.
 */
describe("BKL-280 — confirmDeliveryContradiction", () => {
  /** The checkout state the V7 row actually adjudicates against. */
  function checkoutState(overrides: Partial<OrderState["ctx"]> = {}): OrderState {
    return state({
      fulfillment: "pickup",
      paymentMethod: "cash",
      paymentStatus: null,
      totalInCentavos: 5_000,
      ...overrides,
    })
  }

  const CONTRADICTION_PROMPT =
    "O pedido está marcado como retirada no local, mas sua mensagem indica entrega. Como você prefere receber: entrega no seu endereço ou retirada no local?"

  it("THE DEFECT: stay-home marker + delivery_type pickup ⇒ REQUEST_CONFIRMATION, never EXECUTE", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "cash",
        deliveryType: "pickup",
      }),
      checkoutState({ stayHomeDeliveryMarker: true }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    // The specific sentence — proves it is THIS guard and not the money band.
    expect(decision.prompt).toBe(CONTRADICTION_PROMPT)
    // pt-BR customer copy (CLAUDE.md rule #4), offering BOTH options.
    expect(decision.prompt).toContain("entrega")
    expect(decision.prompt).toContain("retirada")
  })

  it("carries a business basis naming the rule (audit provenance)", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "cash",
        deliveryType: "pickup",
      }),
      checkoutState({ stayHomeDeliveryMarker: true }),
      ordersPolicyBundle,
    )
    const rules = decision.basis.map(
      (b) => (b.detail as { rule?: string } | undefined)?.rule,
    )
    expect(rules).toContain("delivery_type_contradicts_utterance")
  })

  it("tolerates wire spelling of the pickup value (case/whitespace)", () => {
    // Can only ever ADD the question, never skip it.
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "cash",
        deliveryType: " Pickup ",
      }),
      checkoutState({ stayHomeDeliveryMarker: true }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
  })

  // ── CONTROLS: every other checkout path is untouched ────────────────────

  it("CONTROL — plain pickup ask (no marker) still EXECUTEs", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "cash",
        deliveryType: "pickup",
      }),
      checkoutState(),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("CONTROL — stay-home marker WITH delivery_type delivery is untouched (EXECUTE)", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "cash",
        deliveryType: "delivery",
      }),
      checkoutState({ fulfillment: "delivery", stayHomeDeliveryMarker: true }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("CONTROL — plain delivery ask (no marker) still EXECUTEs", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "cash",
        deliveryType: "delivery",
      }),
      checkoutState({ fulfillment: "delivery" }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("CONTROL — an ABSENT flag (unwired host / resume path) leaves the checkout unchanged", () => {
    // `stayHomeDeliveryMarker` undefined — not false. Lenient-when-absent.
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "cash",
        deliveryType: "pickup",
      }),
      checkoutState(),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("CONTROL — the marker is INERT on a non-checkout kind", () => {
    // The flag is only ever stamped for order.checkout.create, but even if some
    // host set it elsewhere the guard must not move another kind's verdict.
    const payload = {
      cartId: "cart-1",
      variantId: "v-1",
      quantity: 1,
      allergens: [],
    }
    const withFlag = adjudicate(
      env("order.item.add", payload),
      state({ stayHomeDeliveryMarker: true }),
      ordersPolicyBundle,
    )
    const without = adjudicate(
      env("order.item.add", payload),
      state(),
      ordersPolicyBundle,
    )
    expect(withFlag.kind).toBe(without.kind)
  })

  // ── THE MONEY LADDER IS NOT WEAKENED ───────────────────────────────────

  it("MONEY BAND UNCHANGED — large-ticket delivery checkout still asks the MONEY question", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "card",
        deliveryType: "delivery",
      }),
      checkoutState({
        fulfillment: "delivery",
        paymentMethod: "card",
        totalInCentavos: 150_000,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toContain("R$")
    expect(decision.prompt).not.toBe(CONTRADICTION_PROMPT)
  })

  it("ORDERING — on a CONTRADICTING large-ticket cart the contradiction is asked FIRST", () => {
    // Both guards match and business guards are first-non-null-wins. Below
    // confirmLargeTicket this guard would be unreachable here: the money
    // sentence would be asked, a "sim" would satisfy it, and the wrong pickup
    // checkout would EXECUTE unasked — the defect, for the priciest carts.
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "card",
        deliveryType: "pickup",
      }),
      checkoutState({
        paymentMethod: "card",
        totalInCentavos: 150_000,
        stayHomeDeliveryMarker: true,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toBe(CONTRADICTION_PROMPT)
  })

  it("MONEY BAND STILL GOVERNS the CORRECTED envelope (answering 'entrega' re-enters the ladder)", () => {
    // The corrected turn is a NEW envelope carrying deliveryType: delivery.
    // This guard is silent on it and confirmLargeTicket asks normally — which
    // is why asking the contradiction first does not SKIP the money band.
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "card",
        deliveryType: "delivery",
      }),
      checkoutState({
        fulfillment: "delivery",
        paymentMethod: "card",
        totalInCentavos: 150_000,
      }),
      ordersPolicyBundle,
    )
    expect(decision.kind).toBe("REQUEST_CONFIRMATION")
    if (decision.kind !== "REQUEST_CONFIRMATION") return
    expect(decision.prompt).toContain("R$")
  })

  it("the amount CAP still outranks the guard (a contradicting R$10.000+ cart REFUSEs)", () => {
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "card",
        deliveryType: "pickup",
      }),
      checkoutState({
        paymentMethod: "card",
        totalInCentavos: 1_500_000,
        stayHomeDeliveryMarker: true,
      }),
      ordersPolicyBundle,
    )
    // refuseAmountAboveCap runs BEFORE this guard — an over-cap checkout is
    // still REFUSEd outright, never softened into a mere question.
    expect(decision.kind).toBe("REFUSE")
  })

  // ── CONFIRMATION-RECEIPT SCOPING (the binding hazard) ───────────────────

  it("a STALE receipt (different intentHash) does NOT bypass the guard", async () => {
    const { adjudicateAndAudit } = await import("@adjudicate/core")
    const contradicting = env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "cash",
      deliveryType: "pickup",
    })
    // A receipt the customer earned against a DIFFERENT intent earlier in the
    // conversation. Receipts are scoped to an intentHash, not to a question, so
    // this is precisely the shape that must NOT let a pickup checkout through.
    const otherEnvelope = env("order.cancel", {
      orderId: "o-1",
      reason: "changed_mind",
    })
    expect(otherEnvelope.intentHash).not.toBe(contradicting.intentHash)

    const sink = { emit: async () => {} }
    const resumed = await adjudicateAndAudit(
      contradicting,
      checkoutState({ stayHomeDeliveryMarker: true }),
      ordersPolicyBundle,
      {
        sink,
        confirmationReceipt: {
          intentHash: otherEnvelope.intentHash,
          at: DET_TIME,
        },
      },
    )
    expect(resumed.decision.kind).toBe("REQUEST_CONFIRMATION")
    if (resumed.decision.kind !== "REQUEST_CONFIRMATION") return
    expect(resumed.decision.prompt).toBe(CONTRADICTION_PROMPT)
  })

  it("the guard mints its OWN question — only a MATCHING receipt converts it", async () => {
    // The positive half of the scoping pin: the confirm is a real, resolvable
    // question (not a dead end), and it is resolved by a receipt for THIS
    // envelope. Paired with the stale-receipt test, this proves the conversion
    // is keyed on identity rather than on "some confirmation exists".
    const { adjudicateAndAudit } = await import("@adjudicate/core")
    const contradicting = env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "cash",
      deliveryType: "pickup",
    })
    const sink = { emit: async () => {} }
    const resumed = await adjudicateAndAudit(
      contradicting,
      checkoutState({ stayHomeDeliveryMarker: true }),
      ordersPolicyBundle,
      {
        sink,
        confirmationReceipt: {
          intentHash: contradicting.intentHash,
          at: DET_TIME,
        },
      },
    )
    expect(resumed.decision.kind).toBe("EXECUTE")
  })

  // ── NON-VACUITY / REVERT-TO-RED at the guard seam ──────────────────────

  it("REVERT-TO-RED — with the guard removed the V7 case EXECUTEs the wrong pickup checkout", () => {
    const businessWithoutGuard = ordersPolicyBundle.business.filter(
      (g) => g.name !== "confirmDeliveryContradiction",
    )
    // Sanity: exactly one guard was removed (the filter actually matched).
    expect(businessWithoutGuard.length).toBe(
      ordersPolicyBundle.business.length - 1,
    )
    const decision = adjudicate(
      env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: "cash",
        deliveryType: "pickup",
      }),
      checkoutState({ stayHomeDeliveryMarker: true }),
      { ...ordersPolicyBundle, business: businessWithoutGuard },
    )
    // THE MEASURED DEFECT, reproduced: valid capability, wrong payload, EXECUTES.
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REVERT-TO-RED — with the guard removed the CONTROLS are unchanged (the guard is the only difference)", () => {
    const businessWithoutGuard = ordersPolicyBundle.business.filter(
      (g) => g.name !== "confirmDeliveryContradiction",
    )
    const bundleWithout = {
      ...ordersPolicyBundle,
      business: businessWithoutGuard,
    }
    const controls: ReadonlyArray<[string, OrderState, string]> = [
      ["plain pickup", checkoutState(), "pickup"],
      ["plain delivery", checkoutState({ fulfillment: "delivery" }), "delivery"],
      [
        "marker + delivery",
        checkoutState({ fulfillment: "delivery", stayHomeDeliveryMarker: true }),
        "delivery",
      ],
      [
        "large-ticket delivery",
        checkoutState({
          fulfillment: "delivery",
          paymentMethod: "card",
          totalInCentavos: 150_000,
        }),
        "delivery",
      ],
    ]
    for (const [label, ctxState, deliveryType] of controls) {
      const e = env("order.checkout.create", {
        cartId: "cart-1",
        paymentMethod: ctxState.ctx.paymentMethod ?? "cash",
        deliveryType,
      })
      const withGuard = adjudicate(e, ctxState, ordersPolicyBundle)
      const withoutGuard = adjudicate(e, ctxState, bundleWithout)
      expect(`${label}:${withGuard.kind}`).toBe(`${label}:${withoutGuard.kind}`)
    }
  })
})
