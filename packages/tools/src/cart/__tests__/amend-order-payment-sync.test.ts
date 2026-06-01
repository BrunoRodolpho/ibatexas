// Tests for amend_order — post-edit payment/PI sync concurrency guard (P1-CONC-AMEND)
// Mock-based; no network, DB, or Redis required.
//
// After an item edit (add / remove / update_qty) changes the order total, the tool
// regenerates the Stripe PI and swaps the active Payment row. That sync MUST run
// under withLock('payment:'+activePayment.id) with a RE-READ of the payment INSIDE
// the lock before mutating — mirroring the change_payment path. Without it, two
// concurrent amendments interleave and orphan each other's active payment / PI.
//
// Scenarios:
// - add: acquires withLock('payment:'+id) and re-reads (getById) inside the lock
// - re-read happens BEFORE any mutation (transitionStatus / create / Stripe / metadata)
// - concurrent amendment already swapped the payment (re-read terminal) → skip mutation
// - fresh version from the in-lock re-read is used for the cancel transition
// - remove + update_qty also route their sync through the lock
// - legacy order (no active Payment row) → no lock, falls back to metadata PI regen

import { describe, it, expect, beforeEach, vi } from "vitest"
import { amendOrder } from "../amend-order.js"
import { makeCtx } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn())
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn())
const mockGetById = vi.hoisted(() => vi.fn())
const mockTransitionStatus = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockGetOrder = vi.hoisted(() => vi.fn())
const mockCancelItem = vi.hoisted(() => vi.fn())
const mockCancelStalePaymentIntent = vi.hoisted(() => vi.fn())
const mockStripePaymentIntentsCreate = vi.hoisted(() => vi.fn())
const mockGetStripe = vi.hoisted(() => vi.fn())
const mockWithLock = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}))

vi.mock("@ibatexas/domain", () => ({
  createOrderService: vi.fn(() => ({
    getOrder: mockGetOrder,
    cancelItem: mockCancelItem,
  })),
  createOrderQueryService: vi.fn(() => ({
    getById: vi.fn().mockResolvedValue({ fulfillmentStatus: "pending" }),
  })),
  createPaymentQueryService: vi.fn(() => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    getById: mockGetById,
  })),
  createPaymentCommandService: vi.fn(() => ({
    transitionStatus: mockTransitionStatus,
    create: mockCreate,
  })),
  // update_qty dynamically imports the PONR helpers; default them to "within window"
  // so the quantity update proceeds to the guarded payment sync under test.
  getEffectivePonr: vi.fn(({ amendMinutes }: { amendMinutes?: number }) => ({
    amendMinutes: amendMinutes ?? 30,
  })),
  isWithinPonr: vi.fn(() => true),
}))

vi.mock("../_stripe-helpers.js", () => ({
  cancelStalePaymentIntent: mockCancelStalePaymentIntent,
  getStripe: mockGetStripe,
}))

vi.mock("../../redis/distributed-lock.js", () => ({
  withLock: mockWithLock,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CTX = makeCtx({ customerId: "cust_01" })

const ADD_INPUT = {
  orderId: "order_01",
  action: "add" as const,
  variantId: "variant_costela_500g",
  quantity: 1,
}

const REMOVE_INPUT = {
  orderId: "order_01",
  action: "remove" as const,
  itemTitle: "Costela Bovina Defumada 500g",
}

const UPDATE_QTY_INPUT = {
  orderId: "order_01",
  action: "update_qty" as const,
  itemTitle: "Costela Bovina Defumada 500g",
  quantity: 3,
}

// Active (non-terminal) PIX payment carrying amount in integer centavos.
function makeActivePayment(overrides?: Record<string, unknown>) {
  return {
    id: "pay_01",
    orderId: "order_01",
    method: "pix",
    status: "payment_pending",
    amountInCentavos: 26700,
    stripePaymentIntentId: "pi_old_01",
    version: 1,
    statusHistory: [],
    ...overrides,
  }
}

function newStripePi() {
  return {
    id: "pi_new_01",
    next_action: {
      pix_display_qr_code: {
        data: "00020101br.gov.bcb.pix.new",
        image_url_svg: "https://qr.stripe.com/new.svg",
      },
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("amendOrder — post-edit payment sync (P1-CONC-AMEND concurrency guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Order is pending, owned by cust_01, with an updated total (in centavos)
    // and a metadata PI to regenerate from.
    mockGetOrder.mockResolvedValue({
      order: {
        id: "order_01",
        status: "pending",
        customer_id: "cust_01",
        items: [
          { id: "item_01", title: "Costela Bovina Defumada 500g", quantity: 2 },
        ],
        total: 35600,
        created_at: new Date().toISOString(),
        metadata: { stripePaymentIntentId: "pi_old_01" },
      },
      ownershipValid: true,
    })

    // Medusa order-edit endpoints return an edit id then accept item ops + confirm.
    mockMedusaAdmin.mockImplementation(async (path: string) => {
      if (path.endsWith("/edits")) return { order_edit: { id: "edit_01" } }
      return {}
    })

    // remove path: cancelItem succeeds and changes the total.
    mockCancelItem.mockResolvedValue({ success: true, message: "Item removido." })

    // Active payment exists; re-read inside the lock returns the same (still active).
    mockGetActiveByOrderId.mockResolvedValue(makeActivePayment())
    mockGetById.mockResolvedValue(makeActivePayment())

    mockGetStripe.mockReturnValue({
      paymentIntents: { create: mockStripePaymentIntentsCreate },
    })
    mockStripePaymentIntentsCreate.mockResolvedValue(newStripePi())
    mockCancelStalePaymentIntent.mockResolvedValue(undefined)
    mockTransitionStatus.mockResolvedValue(undefined)
    mockCreate.mockResolvedValue(makeActivePayment({ id: "pay_02", version: 1 }))
    mockPublishNatsEvent.mockResolvedValue(undefined)

    // withLock runs the callback transparently by default.
    mockWithLock.mockImplementation(
      async (_key: string, fn: () => Promise<unknown>) => fn(),
    )
  })

  it("acquires withLock('payment:'+activePayment.id) for the add sync", async () => {
    await amendOrder(ADD_INPUT, CTX)

    expect(mockWithLock).toHaveBeenCalledTimes(1)
    expect(mockWithLock).toHaveBeenCalledWith("payment:pay_01", expect.any(Function))
  })

  it("re-reads the payment (getById) INSIDE the lock before mutating", async () => {
    // Track call ordering across getById (re-read) vs the mutations it guards.
    const order: string[] = []
    mockGetById.mockImplementation(async () => {
      order.push("getById")
      return makeActivePayment()
    })
    mockStripePaymentIntentsCreate.mockImplementation(async () => {
      order.push("stripe.create")
      return newStripePi()
    })
    mockCancelStalePaymentIntent.mockImplementation(async () => {
      order.push("cancelStalePI")
    })
    mockTransitionStatus.mockImplementation(async () => {
      order.push("transitionStatus")
    })
    mockCreate.mockImplementation(async () => {
      order.push("create")
      return makeActivePayment({ id: "pay_02" })
    })

    await amendOrder(ADD_INPUT, CTX)

    // getById (the in-lock re-read) must precede every mutating call.
    expect(order[0]).toBe("getById")
    const firstMutation = order.findIndex((s) => s !== "getById")
    expect(firstMutation).toBeGreaterThan(0)
    expect(order.indexOf("getById")).toBeLessThan(order.indexOf("transitionStatus"))
    expect(order.indexOf("getById")).toBeLessThan(order.indexOf("create"))
    expect(order.indexOf("getById")).toBeLessThan(order.indexOf("cancelStalePI"))
  })

  it("uses the FRESH in-lock version for the cancel transition (observes concurrent bump)", async () => {
    // A concurrent amendment bumped the version from 1 → 5 before we got the lock.
    mockGetActiveByOrderId.mockResolvedValue(makeActivePayment({ version: 1 }))
    mockGetById.mockResolvedValue(makeActivePayment({ version: 5 }))

    await amendOrder(ADD_INPUT, CTX)

    expect(mockTransitionStatus).toHaveBeenCalledWith(
      "pay_01",
      expect.objectContaining({
        newStatus: "canceled",
        reason: "order_amended_total_changed",
        expectedVersion: 5,
      }),
    )
  })

  it("creates the new Payment row with the updated total in centavos + new PI", async () => {
    await amendOrder(ADD_INPUT, CTX)

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_01",
        method: "pix",
        amountInCentavos: 35600,
        stripePaymentIntentId: "pi_new_01",
      }),
    )
  })

  // NetworkReviewer-001 (money residual): the regenerated PIX PaymentIntent MUST
  // carry an idempotency key. Without it, a retried amendment (HTTP/Twilio retry,
  // or our own re-invocation) creates a SECOND live PIX intent for the same order —
  // a duplicate-charge surface. The key is stable per (order, replaced-PI) so a
  // retry of the same amendment reuses the intent, while a genuinely-distinct
  // amendment (different oldPiId) still keys a fresh PI. Mirrors the change_payment
  // site's `pi-amend:` key. RED before the key is added; GREEN after.
  it("creates the regenerated PIX PI with a stable idempotency key (NetworkReviewer-001)", async () => {
    await amendOrder(ADD_INPUT, CTX)

    expect(mockStripePaymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method_types: ["pix"] }),
      expect.objectContaining({ idempotencyKey: "pi-amend-regen:order_01:pi_old_01" }),
    )
  })

  it("skips the Payment swap when a concurrent amendment already finalized it (re-read terminal)", async () => {
    // Concurrent amendment canceled this payment while we were acquiring the lock.
    mockGetById.mockResolvedValue(makeActivePayment({ status: "canceled" }))

    await amendOrder(ADD_INPUT, CTX)

    // Must NOT cancel/recreate on top of the concurrent amendment's fresh payment,
    // and must NOT regenerate a PI / touch order metadata.
    expect(mockTransitionStatus).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled()
  })

  it("skips the swap when the lock cannot be acquired (withLock returns null)", async () => {
    mockWithLock.mockResolvedValue(null)

    const result = await amendOrder(ADD_INPUT, CTX)

    // The item edit still succeeded; the guarded sync was simply not performed here.
    expect(result.success).toBe(true)
    expect(mockTransitionStatus).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("routes the remove-path sync through withLock('payment:'+id) too", async () => {
    await amendOrder(REMOVE_INPUT, CTX)

    expect(mockWithLock).toHaveBeenCalledWith("payment:pay_01", expect.any(Function))
  })

  it("routes the update_qty-path sync through withLock('payment:'+id) too", async () => {
    await amendOrder(UPDATE_QTY_INPUT, CTX)

    expect(mockWithLock).toHaveBeenCalledWith("payment:pay_01", expect.any(Function))
  })

  it("legacy order with no active Payment row → no lock, falls back to metadata PI regen", async () => {
    mockGetActiveByOrderId.mockResolvedValue(null)

    await amendOrder(ADD_INPUT, CTX)

    expect(mockWithLock).not.toHaveBeenCalled()
    // Still regenerates the PI from Medusa metadata (legacy path) without a row swap.
    expect(mockCancelStalePaymentIntent).toHaveBeenCalledWith("pi_old_01")
    expect(mockTransitionStatus).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
