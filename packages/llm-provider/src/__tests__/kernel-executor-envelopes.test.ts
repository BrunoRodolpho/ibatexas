// Unit tests for kernel-executor-envelopes.ts (Task 06).
//
// Verifies the four envelope factories that wrap the deterministic kernel's
// mutation calls (addItemToCart / processCheckout / cancelOrderAction /
// regeneratePixAction) in `IntentEnvelope`s before adjudicate() sees them.
//
// Per task-06 acceptance:
//   - actor.principal === "system"
//   - taint === "SYSTEM"
//   - kind matches the spec's literal name (DETERMINISTIC_KERNEL_COVERAGE)
//   - intentHash is sha256-shaped and stable (nonce-gated)

import { describe, it, expect } from "vitest"
import type { OrderContext } from "../machine/types.js"
import {
  buildAddItemEnvelope,
  buildCheckoutEnvelope,
  buildCancelOrderEnvelope,
  buildRegeneratePixEnvelope,
  KERNEL_INTENT_KIND_ADD_ITEM,
  KERNEL_INTENT_KIND_CHECKOUT,
  KERNEL_INTENT_KIND_CANCEL,
  KERNEL_INTENT_KIND_PIX_REGENERATE,
  type KernelAddItemPayload,
  type KernelCheckoutPayload,
  type KernelCancelPayload,
  type KernelRegeneratePixPayload,
} from "../kernel-executor-envelopes.js"

// ── Fixtures ────────────────────────────────────────────────────────────────

// Minimal OrderContext for the factories — they only read sessionId via the
// signature; ctx is currently advisory (the policy bundle reads it
// downstream, but the factories themselves don't inspect it).
function makeCtx(): OrderContext {
  return {
    channel: "whatsapp",
    customerId: "cust_01",
    customerName: "Cliente",
    isAuthenticated: true,
    isNewCustomer: false,
    cartId: "cart_01",
    items: [],
    totalInCentavos: 0,
    couponApplied: null,
    fulfillment: "pickup",
    deliveryCep: null,
    deliveryFeeInCentavos: null,
    deliveryEtaMinutes: null,
    paymentMethod: "pix",
    tipInCentavos: 0,
    customerEmail: null,
    customerTaxId: null,
    upsellRound: 0,
    hasMainDish: false,
    hasSide: false,
    hasDrink: false,
    isCombo: false,
    mealPeriod: "lunch",
    lastError: null,
    pendingProduct: null,
    alternatives: [],
    lastSearchResult: null,
    checkoutResult: null,
    orderId: null,
    orderCreatedAt: null,
    lastAction: null,
    loyaltyStamps: null,
    secondaryIntent: null,
    momentum: "high",
    lastObjectionSubtype: null,
    fallbackCount: 0,
    activeOrderId: null,
    activeOrderDisplayId: null,
    activeOrderStatus: null,
    paymentId: null,
    paymentStatus: null,
    pixExpiresAt: null,
  }
}

const SESSION_ID = "sess_test_01"

// ── Shared shape assertions ─────────────────────────────────────────────────

function expectKernelEnvelopeShape(
  envelope: {
    version: number
    kind: string
    actor: { principal: string; sessionId: string }
    taint: string
    intentHash: string
    nonce: string
    createdAt: string
  },
  kind: string,
): void {
  expect(envelope.version).toBe(2)
  expect(envelope.actor.principal).toBe("system")
  expect(envelope.actor.sessionId).toBe(SESSION_ID)
  expect(envelope.taint).toBe("SYSTEM")
  expect(envelope.kind).toBe(kind)
  // intentHash is sha256-shaped (lowercase hex, 64 chars).
  expect(envelope.intentHash).toMatch(/^[0-9a-f]{64}$/)
  // nonce is non-empty (UUID format) and createdAt is ISO 8601.
  expect(envelope.nonce.length).toBeGreaterThan(0)
  expect(() => new Date(envelope.createdAt).toISOString()).not.toThrow()
}

// ── buildAddItemEnvelope ────────────────────────────────────────────────────

describe("buildAddItemEnvelope", () => {
  it("produces a SYSTEM-taint system-actor envelope of kind order.cart.add", () => {
    const payload: KernelAddItemPayload = {
      cartId: "cart_01",
      variantId: "var_01",
      quantity: 2,
      allergens: ["amendoim"],
    }
    const envelope = buildAddItemEnvelope(payload, makeCtx(), SESSION_ID)
    expectKernelEnvelopeShape(envelope, KERNEL_INTENT_KIND_ADD_ITEM)
    expect(envelope.payload).toEqual(payload)
  })

  it("uses the exported intent kind literal", () => {
    expect(KERNEL_INTENT_KIND_ADD_ITEM).toBe("order.cart.add")
  })

  it("produces distinct nonces on consecutive calls (idempotency keys)", () => {
    const payload: KernelAddItemPayload = {
      cartId: "cart_01",
      variantId: "var_01",
      quantity: 1,
      allergens: [],
    }
    const a = buildAddItemEnvelope(payload, makeCtx(), SESSION_ID)
    const b = buildAddItemEnvelope(payload, makeCtx(), SESSION_ID)
    expect(a.nonce).not.toBe(b.nonce)
    // Distinct nonces ⇒ distinct intentHashes even with identical payload.
    expect(a.intentHash).not.toBe(b.intentHash)
  })

  it("preserves the explicit-allergens-array shape (CLAUDE.md rule #1)", () => {
    // The payload contract requires an array — even if empty. We don't
    // enforce here (the pack-orders guard does that downstream), but we
    // verify the field roundtrips literally.
    const payload: KernelAddItemPayload = {
      cartId: "cart_01",
      variantId: "var_01",
      quantity: 1,
      allergens: [],
    }
    const envelope = buildAddItemEnvelope(payload, makeCtx(), SESSION_ID)
    expect(Array.isArray(envelope.payload.allergens)).toBe(true)
  })
})

// ── buildCheckoutEnvelope ───────────────────────────────────────────────────

describe("buildCheckoutEnvelope", () => {
  it("produces a SYSTEM-taint system-actor envelope of kind order.checkout.create", () => {
    const payload: KernelCheckoutPayload = {
      cartId: "cart_01",
      paymentMethod: "pix",
      tipInCentavos: 500,
      deliveryCep: "01001000",
    }
    const envelope = buildCheckoutEnvelope(payload, makeCtx(), SESSION_ID)
    expectKernelEnvelopeShape(envelope, KERNEL_INTENT_KIND_CHECKOUT)
    expect(envelope.payload).toEqual(payload)
  })

  it("uses the exported intent kind literal", () => {
    expect(KERNEL_INTENT_KIND_CHECKOUT).toBe("order.checkout.create")
  })

  it("carries centavos integers (CLAUDE.md rule #2)", () => {
    const payload: KernelCheckoutPayload = {
      cartId: "cart_01",
      paymentMethod: "pix",
      tipInCentavos: 8900, // R$ 89,00 — integer centavos
      deliveryCep: null,
    }
    const envelope = buildCheckoutEnvelope(payload, makeCtx(), SESSION_ID)
    expect(Number.isInteger(envelope.payload.tipInCentavos)).toBe(true)
  })
})

// ── buildCancelOrderEnvelope ────────────────────────────────────────────────

describe("buildCancelOrderEnvelope", () => {
  it("produces a SYSTEM-taint system-actor envelope of kind order.cancel", () => {
    const payload: KernelCancelPayload = { orderId: "ord_01" }
    const envelope = buildCancelOrderEnvelope(payload, makeCtx(), SESSION_ID)
    expectKernelEnvelopeShape(envelope, KERNEL_INTENT_KIND_CANCEL)
    expect(envelope.payload).toEqual(payload)
  })

  it("uses the exported intent kind literal", () => {
    expect(KERNEL_INTENT_KIND_CANCEL).toBe("order.cancel")
  })
})

// ── buildRegeneratePixEnvelope ──────────────────────────────────────────────

describe("buildRegeneratePixEnvelope", () => {
  it("produces a SYSTEM-taint system-actor envelope of kind order.pix.regenerate", () => {
    const payload: KernelRegeneratePixPayload = { orderId: "ord_01" }
    const envelope = buildRegeneratePixEnvelope(payload, makeCtx(), SESSION_ID)
    expectKernelEnvelopeShape(envelope, KERNEL_INTENT_KIND_PIX_REGENERATE)
    expect(envelope.payload).toEqual(payload)
  })

  it("uses the exported intent kind literal", () => {
    expect(KERNEL_INTENT_KIND_PIX_REGENERATE).toBe("order.pix.regenerate")
  })
})
