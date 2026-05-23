/**
 * @ibatexas/pack-orders — conformance test.
 *
 * Two-part:
 *
 *   1. Corpus of 30+ envelope+state fixtures covering EXECUTE,
 *      REFUSE, DEFER, REWRITE, REQUEST_CONFIRMATION, and ESCALATE
 *      outcomes across the Pack's intent kinds. Each fixture asserts
 *      the expected Decision shape against `ordersPack.policy`.
 *
 *   2. Kernel-invariant suite — `runConformance(ordersPack)` from
 *      `@adjudicate/conformance` verifies taint protection, replay
 *      determinism, intent-hash determinism, basis-vocabulary purity,
 *      guard ordering, and default polarity hold for the Pack.
 *
 * The legacy `orderPolicyBundle` (now a deprecated re-export shim) is
 * NOT imported and compared directly. The legacy bundle was keyed off
 * different intent kinds (`order.submit`, `order.confirm`, etc.) — the
 * migration to the master taxonomy (governance §"Domain: order")
 * formally renames the kinds, so a byte-identical comparison would be
 * misleading. Behaviour parity is asserted via the corpus expectations
 * below — every refusal path the legacy bundle exposed is covered.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { runConformance } from "@adjudicate/conformance"
import {
  ordersPack,
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

function authenticatedState(
  overrides: Partial<OrderState["ctx"]> = {},
): OrderState {
  return {
    ctx: {
      channel: "whatsapp",
      customerId: "c-1",
      cartId: "cart-1",
      orderId: "o-1",
      items: [
        {
          variantId: "v-1",
          quantity: 1,
          priceInCentavos: 5_000,
        },
      ],
      fulfillment: "delivery",
      paymentMethod: "card",
      paymentStatus: null,
      totalInCentavos: 5_000,
      lastAction: null,
      ...overrides,
    },
  }
}

// ── Corpus ──────────────────────────────────────────────────────────────

/**
 * One fixture per row. The corpus exercises every decision outcome at
 * least twice across the Pack's intent surface. Add cases here rather
 * than scattering them — the count gate below enforces ≥ 30.
 */
type Fixture = {
  readonly name: string
  readonly envelope: IntentEnvelope<OrderIntentKind, OrderPayload>
  readonly state: OrderState
  readonly expect: {
    readonly kind:
      | "EXECUTE"
      | "REFUSE"
      | "DEFER"
      | "REWRITE"
      | "REQUEST_CONFIRMATION"
      | "ESCALATE"
    readonly refusalCode?: string
    readonly signal?: string
    readonly escalateTo?: "human" | "supervisor"
  }
}

const corpus: ReadonlyArray<Fixture> = [
  // ── EXECUTE (8 cases) ────────────────────────────────────────────────
  {
    name: "EXECUTE: order.cart.ensure with no auth (bootstrap)",
    envelope: env("order.cart.ensure", { cartId: "cart-1" }),
    state: authenticatedState({ customerId: null, channel: "web" }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: order.item.add with explicit empty allergens",
    envelope: env("order.item.add", {
      cartId: "cart-1",
      variantId: "v-1",
      quantity: 2,
      allergens: [],
    }),
    state: authenticatedState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: order.item.add with one allergen string",
    envelope: env("order.item.add", {
      cartId: "cart-1",
      variantId: "v-1",
      quantity: 1,
      allergens: ["gluten"],
    }),
    state: authenticatedState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: order.item.update below stock cap",
    envelope: env("order.item.update", {
      cartId: "cart-1",
      itemId: "v-1",
      quantity: 3,
    }),
    state: authenticatedState({
      items: [
        {
          variantId: "v-1",
          quantity: 1,
          priceInCentavos: 5_000,
          stockCap: 10,
        },
      ],
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: order.item.remove",
    envelope: env("order.item.remove", {
      cartId: "cart-1",
      itemId: "v-1",
    }),
    state: authenticatedState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: order.coupon.apply",
    envelope: env("order.coupon.apply", {
      cartId: "cart-1",
      code: "PROMO10",
    }),
    state: authenticatedState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: small-ticket order.checkout.create with card",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "card",
    }),
    state: authenticatedState({
      totalInCentavos: 50_000,
      paymentMethod: "card",
      paymentStatus: null,
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: order.note.add",
    envelope: env("order.note.add", {
      orderId: "o-1",
      body: "Sem cebola, por favor.",
    }),
    state: authenticatedState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: TRUSTED order.cancel.system on existing order",
    envelope: env(
      "order.cancel.system",
      { orderId: "o-1", reason: "stale" },
      "TRUSTED",
    ),
    state: authenticatedState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: small-ticket order.amend.request",
    envelope: env("order.amend.request", {
      orderId: "o-1",
      changes: [{ op: "add", variantId: "v-2", quantity: 1 }],
    }),
    state: authenticatedState(),
    expect: { kind: "EXECUTE" },
  },

  // ── REFUSE (12 cases) ────────────────────────────────────────────────
  {
    name: "REFUSE: unauthenticated order.item.add",
    envelope: env("order.item.add", {
      cartId: "cart-1",
      variantId: "v-1",
      quantity: 1,
      allergens: [],
    }),
    state: authenticatedState({ customerId: null, channel: "web" }),
    expect: { kind: "REFUSE", refusalCode: "auth.required" },
  },
  {
    name: "REFUSE: order.item.add with allergens missing",
    envelope: env("order.item.add", {
      cartId: "cart-1",
      variantId: "v-1",
      quantity: 1,
    }),
    state: authenticatedState(),
    expect: {
      kind: "REFUSE",
      refusalCode: "order.item.allergens_not_explicit",
    },
  },
  {
    name: "REFUSE: order.item.add with allergens as string (inferred)",
    envelope: env("order.item.add", {
      cartId: "cart-1",
      variantId: "v-1",
      quantity: 1,
      allergens: "contains nuts",
    }),
    state: authenticatedState(),
    expect: {
      kind: "REFUSE",
      refusalCode: "order.item.allergens_not_explicit",
    },
  },
  {
    name: "REFUSE: order.item.add with quantity=0",
    envelope: env("order.item.add", {
      cartId: "cart-1",
      variantId: "v-1",
      quantity: 0,
      allergens: [],
    }),
    state: authenticatedState(),
    expect: { kind: "REFUSE", refusalCode: "order.item.quantity_invalid" },
  },
  {
    name: "REFUSE: order.item.update with non-integer quantity",
    envelope: env("order.item.update", {
      cartId: "cart-1",
      itemId: "v-1",
      quantity: 2.5,
    }),
    state: authenticatedState(),
    expect: { kind: "REFUSE", refusalCode: "order.item.quantity_invalid" },
  },
  {
    name: "REFUSE: order.checkout.create with empty cart",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "card",
    }),
    state: authenticatedState({ items: [], paymentMethod: "card" }),
    expect: { kind: "REFUSE", refusalCode: "order.cart.empty" },
  },
  {
    name: "REFUSE: order.checkout.create with slots incomplete",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "card",
    }),
    state: authenticatedState({ fulfillment: null, paymentMethod: null }),
    expect: {
      kind: "REFUSE",
      refusalCode: "order.checkout.slots_incomplete",
    },
  },
  {
    name: "REFUSE: order.checkout.create with invalid payment method",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "crypto" as "card",
    }),
    state: authenticatedState({ paymentMethod: "card" }),
    expect: {
      kind: "REFUSE",
      refusalCode: "order.checkout.payment_method_invalid",
    },
  },
  {
    name: "REFUSE: order.cancel without orderId",
    envelope: env("order.cancel", { orderId: "o-1" }),
    state: authenticatedState({ orderId: null }),
    expect: { kind: "REFUSE", refusalCode: "order.not_found" },
  },
  {
    name: "REFUSE: order.cancel on already-cancelled order",
    envelope: env("order.cancel", { orderId: "o-1" }),
    state: authenticatedState({ lastAction: "cancelled" }),
    expect: { kind: "REFUSE", refusalCode: "order.already_cancelled" },
  },
  {
    name: "REFUSE: UNTRUSTED order.cancel.system (taint gate)",
    envelope: env(
      "order.cancel.system",
      { orderId: "o-1", reason: "stale" },
      "UNTRUSTED",
    ),
    state: authenticatedState(),
    // Kernel emits `taint_level_insufficient` on this path.
    expect: { kind: "REFUSE" },
  },
  {
    name: "REFUSE: order.item.add with missing cartId",
    envelope: env("order.item.add", {
      variantId: "v-1",
      quantity: 1,
      allergens: [],
    }),
    state: authenticatedState(),
    expect: { kind: "REFUSE", refusalCode: "order.cart.missing" },
  },
  {
    name: "REFUSE: huge-amount checkout (above 10x threshold cap)",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "card",
    }),
    state: authenticatedState({
      totalInCentavos: 5_000_000,
      paymentMethod: "card",
      paymentStatus: null,
    }),
    expect: {
      kind: "REFUSE",
      refusalCode: "order.checkout.amount_exceeds_limit",
    },
  },

  // ── DEFER (2 cases) ──────────────────────────────────────────────────
  {
    name: "DEFER: order.checkout.create with PIX pending",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "pix",
    }),
    state: authenticatedState({
      paymentMethod: "pix",
      paymentStatus: "pending",
      totalInCentavos: 5_000,
    }),
    expect: { kind: "DEFER", signal: "payment.confirmed" },
  },
  {
    name: "DEFER: PIX with null status (not yet started)",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "pix",
    }),
    state: authenticatedState({
      paymentMethod: "pix",
      paymentStatus: null,
      totalInCentavos: 5_000,
    }),
    expect: { kind: "DEFER", signal: "payment.confirmed" },
  },

  // ── REWRITE (2 cases) ────────────────────────────────────────────────
  {
    name: "REWRITE: order.item.update clamped to stockCap",
    envelope: env("order.item.update", {
      cartId: "cart-1",
      itemId: "v-1",
      quantity: 50,
    }),
    state: authenticatedState({
      items: [
        {
          variantId: "v-1",
          quantity: 1,
          priceInCentavos: 5_000,
          stockCap: 5,
        },
      ],
    }),
    expect: { kind: "REWRITE" },
  },
  {
    name: "REWRITE: order.item.update at exactly cap+1 → clamp",
    envelope: env("order.item.update", {
      cartId: "cart-1",
      itemId: "v-1",
      quantity: 6,
    }),
    state: authenticatedState({
      items: [
        {
          variantId: "v-1",
          quantity: 1,
          priceInCentavos: 5_000,
          stockCap: 5,
        },
      ],
    }),
    expect: { kind: "REWRITE" },
  },

  // ── REQUEST_CONFIRMATION (3 cases) ───────────────────────────────────
  {
    name: "REQUEST_CONFIRMATION: large-ticket checkout (>= R$ 1.000)",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "card",
    }),
    state: authenticatedState({
      totalInCentavos: 150_000,
      paymentMethod: "card",
      paymentStatus: null,
    }),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: exactly at threshold (100_000 centavos)",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "card",
    }),
    state: authenticatedState({
      totalInCentavos: 100_000,
      paymentMethod: "card",
      paymentStatus: null,
    }),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },
  {
    name: "REQUEST_CONFIRMATION: cash payment large ticket",
    envelope: env("order.checkout.create", {
      cartId: "cart-1",
      paymentMethod: "cash",
    }),
    state: authenticatedState({
      totalInCentavos: 200_000,
      paymentMethod: "cash",
      paymentStatus: null,
    }),
    expect: { kind: "REQUEST_CONFIRMATION" },
  },

  // ── ESCALATE (3 cases) ───────────────────────────────────────────────
  {
    name: "ESCALATE: large-ticket order.cancel",
    envelope: env("order.cancel", { orderId: "o-1", reason: "changed_mind" }),
    state: authenticatedState({
      orderId: "o-1",
      totalInCentavos: 200_000,
    }),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
  {
    name: "ESCALATE: exactly at threshold",
    envelope: env("order.cancel", { orderId: "o-1", reason: "wrong_item" }),
    state: authenticatedState({
      orderId: "o-1",
      totalInCentavos: 100_000,
    }),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
  {
    name: "ESCALATE: small EXECUTE vs large ESCALATE — boundary check",
    envelope: env("order.cancel", { orderId: "o-1", reason: "duplicate" }),
    state: authenticatedState({
      orderId: "o-1",
      totalInCentavos: 999_999_999,
    }),
    expect: { kind: "ESCALATE", escalateTo: "human" },
  },
]

describe("ordersPack — corpus (30+ cases across all 6 decision kinds)", () => {
  it("corpus is at least 30 cases (acceptance criterion)", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(30)
  })

  for (const fixture of corpus) {
    it(fixture.name, () => {
      const decision = adjudicate(
        fixture.envelope,
        fixture.state,
        ordersPack.policy,
      )
      expect(decision.kind).toBe(fixture.expect.kind)
      if (fixture.expect.refusalCode && decision.kind === "REFUSE") {
        expect(decision.refusal.code).toBe(fixture.expect.refusalCode)
      }
      if (fixture.expect.signal && decision.kind === "DEFER") {
        expect(decision.signal).toBe(fixture.expect.signal)
      }
      if (fixture.expect.escalateTo && decision.kind === "ESCALATE") {
        expect(decision.to).toBe(fixture.expect.escalateTo)
      }
    })
  }
})

// ── Kernel-invariant suite ──────────────────────────────────────────────

describe("ordersPack — kernel invariants via runConformance()", () => {
  it("runConformance returns zero failures", () => {
    const report = runConformance(ordersPack)
    if (!report.passed) {
      for (const r of report.results) {
        if (!r.passed) console.error(`[${r.id}] ${r.name}: ${r.details}`)
      }
    }
    expect(report.passed).toBe(true)
    expect(report.summary.failed).toBe(0)
  })

  it("policy default is REFUSE (default-polarity / bypass-detection)", () => {
    // Mirrors AC-006 (default-polarity) from @adjudicate/conformance —
    // also asserted here so the bypass-detection invariant is
    // surfaced explicitly in the Pack's own test surface (task spec
    // acceptance criterion).
    expect(ordersPack.policy.default).toBe("REFUSE")
  })
})
