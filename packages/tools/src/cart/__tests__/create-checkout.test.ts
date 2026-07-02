// Tests for create_checkout tool
// Mock-based; no network required.
//
// Scenarios:
// - Cash payment → completes cart, publishes NATS order.placed
// - Card payment → returns stripeClientSecret
// - PIX payment → calls Stripe confirm to retrieve QR code
// - Missing Stripe session → {success: false}
// - Metadata (tip, CEP, customerId) passed to cart update
// - Unsupported payment method → {success: false}
// - PIX retrieval error → graceful fallback

import { describe, it, expect, beforeEach, vi } from "vitest"
import { createCheckout } from "../create-checkout.js"
import { makeCtx, makePaymentSession } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockStripeConfirm = vi.hoisted(() => vi.fn())
const mockStripeUpdate = vi.hoisted(() => vi.fn())

// medusaStoreAdjudicated wrapper mocks — POST/DELETE/PATCH calls flow through
// these; reads (GETs) still go through medusaStoreFetch (`./_shared.js`).
const mockCartsUpdate = vi.hoisted(() => vi.fn())
const mockCartsComplete = vi.hoisted(() => vi.fn())
const mockCartsPromotionsAdd = vi.hoisted(() => vi.fn())
const mockPaymentCollectionsCreate = vi.hoisted(() => vi.fn())
const mockPaymentSessionsCreate = vi.hoisted(() => vi.fn())

vi.mock("../_shared.js", () => ({
  medusaStoreFetch: mockMedusaStoreFetch,
}))

vi.mock("../../medusa/store-adjudicated.js", () => ({
  medusaStoreAdjudicated: {
    carts: {
      update: mockCartsUpdate,
      complete: mockCartsComplete,
      promotions: { add: mockCartsPromotionsAdd },
    },
    paymentCollections: {
      create: mockPaymentCollectionsCreate,
      paymentSessions: { create: mockPaymentSessionsCreate },
    },
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// Schedule lookup drives the scheduled-pickup tagging (closed + no deliveryCep).
const mockLoadSchedule = vi.hoisted(() => vi.fn())
const mockGetMealPeriod = vi.hoisted(() => vi.fn())

vi.mock("../../cache/schedule-cache.js", () => ({
  loadSchedule: mockLoadSchedule,
}))

vi.mock("../../schedule/schedule-helpers.js", () => ({
  getMealPeriodFromSchedule: mockGetMealPeriod,
}))

vi.mock("stripe", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      paymentIntents: {
        confirm: mockStripeConfirm,
        update: mockStripeUpdate,
      },
    })),
  }
})

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CTX = makeCtx()

const BASE_INPUT = {
  cartId: "cart_01",
  paymentMethod: "cash" as const,
}

// Cart total check response — first call in every createCheckout path
const CART_WITH_TOTAL = { cart: { total: 8900, items: [{ id: "item_01" }] } }

// cartForPC response — second GET /store/carts call (after metadata update)
// No pre-existing payment_collection, so source will POST /store/payment-collections
const CART_FOR_PC_NO_PC = { cart: { items: [], region_id: "reg_br" } }

// Payment collection created by POST /store/payment-collections
const PAYMENT_COLLECTION_RESPONSE = { payment_collection: { id: "pc_test_01" } }

// Payment session init response from POST /store/payment-collections/pc_test_01/payment-sessions
// Matches the extraction path: rawSessionData.payment_session
const PAYMENT_SESSION_INIT_RESPONSE = {
  payment_session: makePaymentSession(),
}

// Providers response for non-cash payments
const PAYMENT_PROVIDERS_RESPONSE = {
  payment_providers: [{ id: "pp_stripe_stripe", is_enabled: true }],
}

// ── Helper: build mock sequence for cash checkout ─────────────────────────────
// medusaStoreFetch covers GET reads only; POST writes go through
// medusaStoreAdjudicated. Cash flow:
//   medusaStoreFetch (in order):
//     1. GET  /store/carts/cart_01        (total check)
//     2. GET  /store/carts/cart_01        (cartForPC — get payment_collection)
//   medusaStoreAdjudicated:
//     - carts.update                       (metadata)
//     - paymentCollections.create          (no existing PC)
//     - paymentCollections.paymentSessions.create
//     - carts.complete

function setupCashMocks(_cartItemsResponse = { cart: { items: [] } }) {
  mockMedusaStoreFetch
    .mockResolvedValueOnce(CART_WITH_TOTAL)           // 1. cart total check
    .mockResolvedValueOnce(CART_FOR_PC_NO_PC)          // 2. cartForPC
  mockCartsUpdate.mockResolvedValueOnce({})
  mockPaymentCollectionsCreate.mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
  mockPaymentSessionsCreate.mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE)
  mockCartsComplete.mockResolvedValueOnce({ order: { id: "order_01" } })
}

// Helper: build mock sequence for card/pix checkout.
//   medusaStoreFetch (in order):
//     1. GET /store/carts/cart_01            (total check)
//     2. GET /store/carts/cart_01            (cartForPC)
//     3. GET /store/payment-providers        (resolve stripe provider)
//   medusaStoreAdjudicated:
//     - carts.update                          (metadata)
//     - paymentCollections.create
//     - paymentCollections.paymentSessions.create

function setupStripeMocks(sessionResponse = PAYMENT_SESSION_INIT_RESPONSE) {
  mockMedusaStoreFetch
    .mockResolvedValueOnce(CART_WITH_TOTAL)              // 1. cart total check
    .mockResolvedValueOnce(CART_FOR_PC_NO_PC)             // 2. cartForPC
    .mockResolvedValueOnce(PAYMENT_PROVIDERS_RESPONSE)    // 3. payment providers
  mockCartsUpdate.mockResolvedValueOnce({})
  mockPaymentCollectionsCreate.mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
  mockPaymentSessionsCreate.mockResolvedValueOnce(sessionResponse)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createCheckout", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaStoreFetch.mockResolvedValue({})
    mockCartsUpdate.mockResolvedValue({})
    mockCartsComplete.mockResolvedValue({})
    mockCartsPromotionsAdd.mockResolvedValue({})
    mockPaymentCollectionsCreate.mockResolvedValue({})
    mockPaymentSessionsCreate.mockResolvedValue({})
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockStripeConfirm.mockResolvedValue({})
    mockStripeUpdate.mockResolvedValue({})
    mockLoadSchedule.mockResolvedValue({ days: {} })
    mockGetMealPeriod.mockReturnValue("lunch")
    process.env.STRIPE_SECRET_KEY = "sk_test_123"
  })

  describe("metadata update", () => {
    it("updates cart with customerId in metadata", async () => {
      setupCashMocks()

      await createCheckout(BASE_INPUT, CTX)

      // Metadata update flows through the adjudicated wrapper.
      expect(mockCartsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          cartId: "cart_01",
          body: expect.objectContaining({
            metadata: expect.objectContaining({ customerId: CTX.customerId }),
          }),
        }),
        expect.objectContaining({
          sourceSubject: "cart:create-checkout:update-email",
          actorPrincipal: "llm",
        }),
      )
    })

    it("includes tipInCentavos in metadata when provided", async () => {
      setupCashMocks()

      await createCheckout({ ...BASE_INPUT, tipInCentavos: 1000 }, CTX)

      const [payload] = mockCartsUpdate.mock.calls[0]
      expect(payload.body.metadata.tipInCentavos).toBe("1000")
    })

    it("includes deliveryCep in metadata when provided", async () => {
      setupCashMocks()

      await createCheckout({ ...BASE_INPUT, deliveryCep: "12345-678" }, CTX)

      const [payload] = mockCartsUpdate.mock.calls[0]
      expect(payload.body.metadata.deliveryCep).toBe("12345-678")
    })

    // ── Closed-hours policy: scheduled-pickup tagging ───────────────────────
    // Mirrors the cart.ts checkout gate — a closed PICKUP order (no deliveryCep)
    // is ACCEPTED and tagged `scheduledPickup`, while an immediate-delivery
    // order (deliveryCep present) is never tagged.
    it("tags scheduledPickup=true for a PICKUP order while the kitchen is closed", async () => {
      setupCashMocks()
      mockGetMealPeriod.mockReturnValue("closed")

      await createCheckout(BASE_INPUT, CTX) // no deliveryCep → pickup

      const [payload] = mockCartsUpdate.mock.calls[0]
      expect(payload.body.metadata.scheduledPickup).toBe("true")
      expect(payload.body.metadata.deliveryType).toBe("pickup")
    })

    it("does NOT tag scheduledPickup for an immediate DELIVERY order while closed", async () => {
      setupCashMocks()
      mockGetMealPeriod.mockReturnValue("closed")

      await createCheckout({ ...BASE_INPUT, deliveryCep: "12345-678" }, CTX)

      const [payload] = mockCartsUpdate.mock.calls[0]
      expect(payload.body.metadata.scheduledPickup).toBeUndefined()
      expect(payload.body.metadata.deliveryType).toBe("delivery")
    })

    it("does NOT tag scheduledPickup for a PICKUP order while OPEN", async () => {
      setupCashMocks()
      mockGetMealPeriod.mockReturnValue("lunch")

      await createCheckout(BASE_INPUT, CTX)

      const [payload] = mockCartsUpdate.mock.calls[0]
      expect(payload.body.metadata.scheduledPickup).toBeUndefined()
    })
  })

  // ── Coupon application (CUS-016) ──────────────────────────────────────────
  // A customer-validated coupon threaded via the checkout body must be applied
  // to the REAL Medusa cart before the payment collection is created, so the
  // charged total reflects the discount. Absent → no coupon promotion added.
  describe("coupon application (CUS-016)", () => {
    const couponAddCalls = () =>
      mockCartsPromotionsAdd.mock.calls.filter(
        ([, opts]) => (opts as { sourceSubject?: string })?.sourceSubject === "cart:create-checkout:apply-coupon",
      )

    it("applies a supplied couponCode to the Medusa cart via a governed promotion.add", async () => {
      setupCashMocks()

      await createCheckout({ ...BASE_INPUT, couponCode: "SAVE10" }, CTX)

      const calls = couponAddCalls()
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toEqual(
        expect.objectContaining({ cartId: "cart_01", promoCodes: ["SAVE10"] }),
      )
      expect(calls[0][1]).toEqual(
        expect.objectContaining({ sourceSubject: "cart:create-checkout:apply-coupon", actorPrincipal: "llm" }),
      )
    })

    it("does NOT add a coupon promotion when no couponCode is supplied", async () => {
      setupCashMocks()

      await createCheckout(BASE_INPUT, CTX)

      expect(couponAddCalls()).toHaveLength(0)
    })

    it("swallows a Medusa rejection of the coupon and still completes checkout", async () => {
      setupCashMocks()
      mockCartsPromotionsAdd.mockRejectedValueOnce(new Error("promotion expired"))

      const result = await createCheckout({ ...BASE_INPUT, couponCode: "EXPIRED" }, CTX)

      expect(result.success).toBe(true)
    })
  })

  describe("cash payment", () => {
    const CART_ITEMS_RESPONSE = {
      cart: {
        items: [
          { variant_id: "var_01", quantity: 2, unit_price: 5000, variant: { product_id: "prod_01" } },
        ],
      },
    }

    it("completes cart directly for cash payment", async () => {
      setupCashMocks()

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.paymentMethod).toBe("cash")
      expect(result.orderId).toBe("order_01")
    })

    it("calls cart complete endpoint for cash payment", async () => {
      setupCashMocks()

      await createCheckout(BASE_INPUT, CTX)

      expect(mockCartsComplete).toHaveBeenCalledWith(
        expect.objectContaining({ cartId: "cart_01" }),
        expect.objectContaining({
          sourceSubject: "cart:create-checkout:complete",
          actorPrincipal: "llm",
        }),
      )
    })

    it("publishes order.placed NATS event with items on cash success", async () => {
      // Use cart items in cartForPC so they appear in the NATS payload
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce({
          cart: {
            items: CART_ITEMS_RESPONSE.cart.items,
            region_id: "reg_br",
          },
        })
      mockCartsUpdate.mockResolvedValueOnce({})
      mockPaymentCollectionsCreate.mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
      mockPaymentSessionsCreate.mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE)
      mockCartsComplete.mockResolvedValueOnce({ order: { id: "order_01" } })

      await createCheckout(BASE_INPUT, CTX)

      expect(mockPublishNatsEvent).toHaveBeenCalledWith(
        "order.placed",
        expect.objectContaining({
          eventType: "order.placed",
          orderId: "order_01",
          paymentMethod: "cash",
          customerId: CTX.customerId,
          // unit_price: 5000 passed through reaisToCentavos() → 500000
          items: expect.arrayContaining([
            expect.objectContaining({ productId: "prod_01", variantId: "var_01", quantity: 2, priceInCentavos: 500000 }),
          ]),
        }),
      )
    })

    it("returns success message with order ID", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
      mockCartsUpdate.mockResolvedValueOnce({})
      mockPaymentCollectionsCreate.mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
      mockPaymentSessionsCreate.mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE)
      mockCartsComplete.mockResolvedValueOnce({ order: { id: "order_42" } })

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.message).toContain("order_42")
      expect(result.message).toContain("dinheiro")
    })

    it("returns success even when order.id is missing from complete response", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
      mockCartsUpdate.mockResolvedValueOnce({})
      mockPaymentCollectionsCreate.mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
      mockPaymentSessionsCreate.mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE)
      mockCartsComplete.mockResolvedValueOnce({ order: undefined })

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.orderId).toBeUndefined()
      expect(result.message).toContain("dinheiro")
    })

    it("does not publish NATS when order.id is missing", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
      mockCartsUpdate.mockResolvedValueOnce({})
      mockPaymentCollectionsCreate.mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
      mockPaymentSessionsCreate.mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE)
      mockCartsComplete.mockResolvedValueOnce({ order: undefined })

      await createCheckout(BASE_INPUT, CTX)

      expect(mockPublishNatsEvent).not.toHaveBeenCalled()
    })
  })

  describe("card payment", () => {
    const CARD_INPUT = { ...BASE_INPUT, paymentMethod: "card" as const }

    it("returns stripeClientSecret on success", async () => {
      setupStripeMocks()

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.paymentMethod).toBe("card")
      expect(result.stripeClientSecret).toBe("pi_secret_test123")
    })

    it("returns message about using client_secret in frontend", async () => {
      setupStripeMocks()

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.message).toContain("client_secret")
    })

    it("returns success:false when no Stripe session found", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
        .mockResolvedValueOnce(PAYMENT_PROVIDERS_RESPONSE)
      mockCartsUpdate.mockResolvedValueOnce({})
      mockPaymentCollectionsCreate.mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
      mockPaymentSessionsCreate.mockResolvedValueOnce({ payment_session: { data: {} } }) // no client_secret

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.success).toBe(false)
      expect(result.message).toContain("N\u00e3o foi poss\u00edvel inicializar o pagamento")
    })

    it("returns success:false when payment_sessions is null", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
        .mockResolvedValueOnce(PAYMENT_PROVIDERS_RESPONSE)
      mockCartsUpdate.mockResolvedValueOnce({})
      mockPaymentCollectionsCreate.mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
      mockPaymentSessionsCreate.mockResolvedValueOnce({}) // no payment_session at all

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.success).toBe(false)
    })
  })

  describe("PIX payment", () => {
    const PIX_INPUT = { ...BASE_INPUT, paymentMethod: "pix" as const }
    const PIX_EXTRA = { customerName: "João Silva", customerEmail: "joao@example.com" }

    it("retrieves PIX QR code from Stripe", async () => {
      setupStripeMocks()

      mockStripeConfirm.mockResolvedValue({
        status: "requires_action",
        next_action: {
          pix_display_qr_code: {
            data: "00020126580014br.gov.bcb.pix...",
            image_url_svg: "https://stripe.com/pix-qr.svg",
            expires_at: 1711987200,
          },
        },
      })
      mockStripeUpdate.mockResolvedValue({})

      const result = await createCheckout(PIX_INPUT, CTX, PIX_EXTRA)

      expect(result.success).toBe(true)
      expect(result.paymentMethod).toBe("pix")
      expect(result.pixQrCode).toBe("https://stripe.com/pix-qr.svg")
      expect(result.pixCopyPaste).toContain("00020126")
      expect(result.pixExpiresAt).toBeDefined()
    })

    it("returns success message about scanning QR code", async () => {
      setupStripeMocks()

      mockStripeConfirm.mockResolvedValue({
        status: "requires_action",
        next_action: {
          pix_display_qr_code: {
            data: "pix-code-data",
            image_url_svg: "https://stripe.com/qr.svg",
          },
        },
      })
      mockStripeUpdate.mockResolvedValue({})

      const result = await createCheckout(PIX_INPUT, CTX, PIX_EXTRA)

      expect(result.message).toContain("PIX gerado com sucesso")
    })

    it("returns success:false when PIX data is missing", async () => {
      setupStripeMocks()

      mockStripeConfirm.mockResolvedValue({
        status: "requires_action",
        next_action: {
          pix_display_qr_code: {},
        },
      })
      mockStripeUpdate.mockResolvedValue({})

      const result = await createCheckout(PIX_INPUT, CTX, PIX_EXTRA)

      expect(result.success).toBe(false)
      expect(result.message).toContain("N\u00e3o foi poss\u00edvel gerar o QR Code PIX")
    })

    it("returns success:false when Stripe PIX confirm throws", async () => {
      setupStripeMocks()

      mockStripeConfirm.mockRejectedValue(new Error("Stripe error"))

      const result = await createCheckout(PIX_INPUT, CTX, PIX_EXTRA)

      expect(result.success).toBe(false)
      expect(result.paymentMethod).toBe("pix")
      expect(result.message).toContain("Erro ao gerar QR Code PIX")
    })

    it("returns success:false when no Stripe session found for PIX", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
        .mockResolvedValueOnce(PAYMENT_PROVIDERS_RESPONSE)
      mockCartsUpdate.mockResolvedValueOnce({})
      mockPaymentCollectionsCreate.mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
      mockPaymentSessionsCreate.mockResolvedValueOnce({}) // no client_secret or payment intent id

      const result = await createCheckout(PIX_INPUT, CTX, PIX_EXTRA)

      expect(result.success).toBe(false)
      expect(result.message).toContain("N\u00e3o foi poss\u00edvel inicializar o pagamento")
    })

    it("converts expires_at timestamp to ISO string", async () => {
      setupStripeMocks()

      const expiresAtUnix = 1711987200
      mockStripeConfirm.mockResolvedValue({
        status: "requires_action",
        next_action: {
          pix_display_qr_code: {
            data: "pix-code",
            image_url_svg: "https://stripe.com/qr.svg",
            expires_at: expiresAtUnix,
          },
        },
      })
      mockStripeUpdate.mockResolvedValue({})

      const result = await createCheckout(PIX_INPUT, CTX, PIX_EXTRA)

      expect(result.pixExpiresAt).toBe(new Date(expiresAtUnix * 1000).toISOString())
    })
  })

  describe("unsupported payment method", () => {
    it("throws ZodError for unknown payment method (rejected at schema level)", async () => {
      // Force an unknown type by casting — Zod rejects invalid enum values at parse
      const input = { ...BASE_INPUT, paymentMethod: "bitcoin" as "pix" }

      await expect(createCheckout(input, CTX)).rejects.toThrow("Invalid option")
    })
  })

  describe("minimum total guard", () => {
    it("throws NonRetryableError when cart total is zero", async () => {
      mockMedusaStoreFetch.mockResolvedValueOnce({ cart: { total: 0, items: [] } })

      await expect(createCheckout(BASE_INPUT, CTX)).rejects.toThrow(
        "Carrinho vazio ou com valor zero",
      )
    })

    it("throws NonRetryableError when cart total is negative", async () => {
      mockMedusaStoreFetch.mockResolvedValueOnce({ cart: { total: -100, items: [] } })

      await expect(createCheckout(BASE_INPUT, CTX)).rejects.toThrow(
        "Carrinho vazio ou com valor zero",
      )
    })
  })

  describe("payment sessions initialization", () => {
    it("initializes payment session on the payment collection", async () => {
      setupCashMocks()

      await createCheckout(BASE_INPUT, CTX)

      expect(mockPaymentSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentCollectionId: "pc_test_01",
          providerId: "pp_system_default",
        }),
        expect.objectContaining({
          sourceSubject: "cart:create-checkout:create-payment-session",
          actorPrincipal: "llm",
        }),
      )
    })
  })
})
