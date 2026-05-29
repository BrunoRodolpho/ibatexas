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

vi.mock("../_shared.js", () => ({
  medusaStoreFetch: mockMedusaStoreFetch,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
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

// Cart total check response — first call in every createCheckout path.
// Carries a real line item so the P2-LOGIC-CHECKOUTREVAL snapshot (variant_id +
// unit_price + quantity) is meaningful; the revalidation re-fetch compares
// against this exact shape.
const CART_WITH_TOTAL = {
  cart: {
    total: 8900,
    items: [{ id: "item_01", variant_id: "var_01", quantity: 1, unit_price: 89, title: "Costela" }],
  },
}

// Revalidation re-fetch (P2-LOGIC-CHECKOUTREVAL) — identical to the snapshot, so
// no price/stock drift is detected and checkout proceeds.
const CART_REVALIDATE_OK = CART_WITH_TOTAL

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
// Actual call sequence for cash:
//   1. GET  /store/carts/cart_01          (total check + revalidation snapshot)
//   2. POST /store/carts/cart_01          (metadata update)
//   3. GET  /store/carts/cart_01          (cartForPC — get payment_collection)
//   4. POST /store/payment-collections    (create PC, no existing one)
//   5. POST /store/payment-collections/pc_test_01/payment-sessions (init session)
//   6. GET  /store/carts/cart_01          (P2-LOGIC-CHECKOUTREVAL re-fetch)
//   7. POST /store/carts/cart_01/complete

function setupCashMocks(revalidateResponse = CART_REVALIDATE_OK) {
  mockMedusaStoreFetch
    .mockResolvedValueOnce(CART_WITH_TOTAL)           // 1. cart total check
    .mockResolvedValueOnce({})                         // 2. cart metadata update
    .mockResolvedValueOnce(CART_FOR_PC_NO_PC)          // 3. cartForPC
    .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE) // 4. create payment collection
    .mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE) // 5. init payment session
    .mockResolvedValueOnce(revalidateResponse)         // 6. revalidation re-fetch
    .mockResolvedValueOnce({ order: { id: "order_01" } }) // 7. complete
}

// Helper: build mock sequence for card/pix checkout
// Actual call sequence for card:
//   1. GET  /store/carts/cart_01           (total check + revalidation snapshot)
//   2. POST /store/carts/cart_01           (metadata update)
//   3. GET  /store/carts/cart_01           (cartForPC)
//   4. POST /store/payment-collections     (create PC)
//   5. GET  /store/payment-providers       (resolve stripe provider)
//   6. POST /store/payment-collections/pc_test_01/payment-sessions (init session)
// PIX adds, after step 6:
//   7. GET  /store/carts/cart_01           (P2-LOGIC-CHECKOUTREVAL re-fetch before confirm)

function setupStripeMocks(sessionResponse = PAYMENT_SESSION_INIT_RESPONSE) {
  mockMedusaStoreFetch
    .mockResolvedValueOnce(CART_WITH_TOTAL)              // 1. cart total check
    .mockResolvedValueOnce({})                            // 2. cart metadata update
    .mockResolvedValueOnce(CART_FOR_PC_NO_PC)             // 3. cartForPC
    .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)   // 4. create payment collection
    .mockResolvedValueOnce(PAYMENT_PROVIDERS_RESPONSE)    // 5. payment providers
    .mockResolvedValueOnce(sessionResponse)               // 6. init payment session
}

// PIX runs the revalidation re-fetch after session init (step 7). Card returns
// before revalidation, so it does not consume this. Tests that drive PIX must
// queue a revalidation response after setupStripeMocks().
function queuePixRevalidation(revalidateResponse = CART_REVALIDATE_OK) {
  mockMedusaStoreFetch.mockResolvedValueOnce(revalidateResponse) // 7. revalidation re-fetch
}

// Cash sequence that stops at the revalidation re-fetch — used when we expect
// the cart to have DRIFTED, so createCheckout returns before /complete. Queuing
// no trailing complete keeps the mock once-queue balanced (no bleed into the
// next test under the suite's shared clearAllMocks()).
function setupCashMocksExpectingDrift(driftResponse: unknown) {
  mockMedusaStoreFetch
    .mockResolvedValueOnce(CART_WITH_TOTAL)           // 1. cart total check
    .mockResolvedValueOnce({})                         // 2. cart metadata update
    .mockResolvedValueOnce(CART_FOR_PC_NO_PC)          // 3. cartForPC
    .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE) // 4. create payment collection
    .mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE) // 5. init payment session
    .mockResolvedValueOnce(driftResponse)              // 6. revalidation re-fetch (drift → return)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createCheckout", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMedusaStoreFetch.mockResolvedValue({})
    mockPublishNatsEvent.mockResolvedValue(undefined)
    mockStripeConfirm.mockResolvedValue({})
    mockStripeUpdate.mockResolvedValue({})
    process.env.STRIPE_SECRET_KEY = "sk_test_123"
  })

  describe("metadata update", () => {
    it("updates cart with customerId in metadata", async () => {
      setupCashMocks()

      await createCheckout(BASE_INPUT, CTX)

      // Call index 1 (0-based) is metadata update
      expect(mockMedusaStoreFetch).toHaveBeenNthCalledWith(
        2,
        "/store/carts/cart_01",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("customerId"),
        }),
      )
    })

    it("includes tipInCentavos in metadata when provided", async () => {
      setupCashMocks()

      await createCheckout({ ...BASE_INPUT, tipInCentavos: 1000 }, CTX)

      // calls[1] is the metadata update (0-based index 1)
      const [, opts] = mockMedusaStoreFetch.mock.calls[1]
      const body = JSON.parse(opts.body)
      expect(body.metadata.tipInCentavos).toBe("1000")
    })

    it("includes deliveryCep in metadata when provided", async () => {
      setupCashMocks()

      await createCheckout({ ...BASE_INPUT, deliveryCep: "12345-678" }, CTX)

      // calls[1] is the metadata update (0-based index 1)
      const [, opts] = mockMedusaStoreFetch.mock.calls[1]
      const body = JSON.parse(opts.body)
      expect(body.metadata.deliveryCep).toBe("12345-678")
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

      expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
        "/store/carts/cart_01/complete",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      )
    })

    it("publishes order.placed NATS event with items on cash success", async () => {
      // Use cart items in cartForPC so they appear in the NATS payload
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          cart: {
            items: CART_ITEMS_RESPONSE.cart.items,
            region_id: "reg_br",
          },
        })
        .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
        .mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE)
        .mockResolvedValueOnce(CART_REVALIDATE_OK)         // revalidation re-fetch
        .mockResolvedValueOnce({ order: { id: "order_01" } })

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
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
        .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
        .mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE)
        .mockResolvedValueOnce(CART_REVALIDATE_OK)         // revalidation re-fetch
        .mockResolvedValueOnce({ order: { id: "order_42" } })

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.message).toContain("order_42")
      expect(result.message).toContain("dinheiro")
    })

    it("returns success even when order.id is missing from complete response", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
        .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
        .mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE)
        .mockResolvedValueOnce(CART_REVALIDATE_OK)         // revalidation re-fetch
        .mockResolvedValueOnce({ order: undefined })

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.orderId).toBeUndefined()
      expect(result.message).toContain("dinheiro")
    })

    it("does not publish NATS when order.id is missing", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
        .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
        .mockResolvedValueOnce(PAYMENT_SESSION_INIT_RESPONSE)
        .mockResolvedValueOnce(CART_REVALIDATE_OK)         // revalidation re-fetch
        .mockResolvedValueOnce({ order: undefined })

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
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
        .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
        .mockResolvedValueOnce(PAYMENT_PROVIDERS_RESPONSE)
        .mockResolvedValueOnce({ payment_session: { data: {} } }) // no client_secret

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.success).toBe(false)
      expect(result.message).toContain("N\u00e3o foi poss\u00edvel inicializar o pagamento")
    })

    it("returns success:false when payment_sessions is null", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
        .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
        .mockResolvedValueOnce(PAYMENT_PROVIDERS_RESPONSE)
        .mockResolvedValueOnce({}) // no payment_session at all

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.success).toBe(false)
    })
  })

  describe("PIX payment", () => {
    const PIX_INPUT = { ...BASE_INPUT, paymentMethod: "pix" as const }
    // P2-LOGIC-PIXIDENTITY: PIX now requires name + a checksum-valid tax_id.
    // 529.982.247-25 is a well-known valid CPF used across the suite.
    const PIX_EXTRA = { customerName: "João Silva", customerEmail: "joao@example.com", customerTaxId: "529.982.247-25" }

    it("retrieves PIX QR code from Stripe", async () => {
      setupStripeMocks()
      queuePixRevalidation()

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
      queuePixRevalidation()

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
      queuePixRevalidation()

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
      queuePixRevalidation()

      mockStripeConfirm.mockRejectedValue(new Error("Stripe error"))

      const result = await createCheckout(PIX_INPUT, CTX, PIX_EXTRA)

      expect(result.success).toBe(false)
      expect(result.paymentMethod).toBe("pix")
      expect(result.message).toContain("Erro ao gerar QR Code PIX")
    })

    it("returns success:false when no Stripe session found for PIX", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce(CART_WITH_TOTAL)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(CART_FOR_PC_NO_PC)
        .mockResolvedValueOnce(PAYMENT_COLLECTION_RESPONSE)
        .mockResolvedValueOnce(PAYMENT_PROVIDERS_RESPONSE)
        .mockResolvedValueOnce({}) // no client_secret or payment intent id

      const result = await createCheckout(PIX_INPUT, CTX, PIX_EXTRA)

      expect(result.success).toBe(false)
      expect(result.message).toContain("N\u00e3o foi poss\u00edvel inicializar o pagamento")
    })

    it("converts expires_at timestamp to ISO string", async () => {
      setupStripeMocks()
      queuePixRevalidation()

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

  // ── P2-LOGIC-CHECKOUTREVAL: stock/price revalidation before completion ──────
  describe("cart revalidation (P2-LOGIC-CHECKOUTREVAL)", () => {
    // Snapshot = CART_WITH_TOTAL (var_01, qty 1, unit_price 89, total 8900).
    const CART_PRICE_DRIFT = {
      cart: { total: 9900, items: [{ id: "item_01", variant_id: "var_01", quantity: 1, unit_price: 99, title: "Costela" }] },
    }
    const CART_ITEM_GONE = {
      cart: { total: 0, items: [] },
    }
    const CART_QTY_REDUCED = {
      cart: { total: 8900, items: [{ id: "item_01", variant_id: "var_01", quantity: 0, unit_price: 89, title: "Costela" }] },
    }

    it("cash: returns cartChanged when a line price drifted (does not complete)", async () => {
      setupCashMocksExpectingDrift(CART_PRICE_DRIFT)

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.success).toBe(false)
      expect(result.cartChanged).toBe(true)
      expect(result.cartChanges?.length).toBeGreaterThan(0)
      expect(result.message).toContain("carrinho mudou")
      // The cart-complete side-effect must NOT have fired.
      expect(mockMedusaStoreFetch).not.toHaveBeenCalledWith(
        "/store/carts/cart_01/complete",
        expect.anything(),
      )
    })

    it("cash: returns cartChanged when an item is no longer available (out of stock)", async () => {
      setupCashMocksExpectingDrift(CART_ITEM_GONE)

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.success).toBe(false)
      expect(result.cartChanged).toBe(true)
      expect(mockPublishNatsEvent).not.toHaveBeenCalled()
    })

    it("cash: returns cartChanged when a line quantity was reduced", async () => {
      setupCashMocksExpectingDrift(CART_QTY_REDUCED)

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.success).toBe(false)
      expect(result.cartChanged).toBe(true)
    })

    it("pix: returns cartChanged on price drift and never confirms the PaymentIntent", async () => {
      setupStripeMocks()
      queuePixRevalidation(CART_PRICE_DRIFT)

      const PIX_EXTRA = { customerName: "João Silva", customerEmail: "joao@example.com", customerTaxId: "529.982.247-25" }
      const result = await createCheckout({ ...BASE_INPUT, paymentMethod: "pix" as const }, CTX, PIX_EXTRA)

      expect(result.success).toBe(false)
      expect(result.cartChanged).toBe(true)
      // Stripe confirm must NOT run when the cart drifted.
      expect(mockStripeConfirm).not.toHaveBeenCalled()
    })

    it("cash: completes normally when the cart is unchanged", async () => {
      setupCashMocks() // revalidation returns the identical snapshot

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.cartChanged).toBeUndefined()
    })
  })

  // ── P2-LOGIC-PIXIDENTITY: name + valid tax_id required for PIX ──────────────
  describe("PIX identity (P2-LOGIC-PIXIDENTITY)", () => {
    const PIX_INPUT = { ...BASE_INPUT, paymentMethod: "pix" as const }

    it("rejects PIX when name is missing (no restaurant-name fallback)", async () => {
      setupStripeMocks()

      const result = await createCheckout(PIX_INPUT, CTX, { customerEmail: "j@e.com", customerTaxId: "529.982.247-25" })

      expect(result.success).toBe(false)
      expect(result.message).toContain("Nome completo")
      expect(mockStripeConfirm).not.toHaveBeenCalled()
    })

    it("rejects PIX when tax_id is missing (no restaurant tax_id fallback)", async () => {
      setupStripeMocks()

      const result = await createCheckout(PIX_INPUT, CTX, { customerName: "João Silva", customerEmail: "j@e.com" })

      expect(result.success).toBe(false)
      expect(result.message).toContain("CPF ou CNPJ")
      expect(mockStripeConfirm).not.toHaveBeenCalled()
    })

    it("rejects PIX when tax_id fails the checksum", async () => {
      setupStripeMocks()

      const result = await createCheckout(PIX_INPUT, CTX, { customerName: "João Silva", customerTaxId: "111.111.111-11" })

      expect(result.success).toBe(false)
      expect(result.message).toContain("CPF ou CNPJ")
      expect(mockStripeConfirm).not.toHaveBeenCalled()
    })

    it("accepts PIX with a valid CNPJ and passes it to Stripe as tax_id", async () => {
      setupStripeMocks()
      queuePixRevalidation()

      mockStripeConfirm.mockResolvedValue({
        status: "requires_action",
        next_action: { pix_display_qr_code: { data: "pix", image_url_svg: "https://s/qr.svg" } },
      })
      mockStripeUpdate.mockResolvedValue({})

      // 11.222.333/0001-81 is a checksum-valid CNPJ.
      const result = await createCheckout(PIX_INPUT, CTX, {
        customerName: "Restaurante Parceiro LTDA",
        customerEmail: "fin@parceiro.com",
        customerTaxId: "11.222.333/0001-81",
      })

      expect(result.success).toBe(true)
      const confirmArgs = mockStripeConfirm.mock.calls[0][1]
      expect(confirmArgs.payment_method_data.billing_details.tax_id).toBe("11.222.333/0001-81")
      // Identity name must be the customer's, never the restaurant fallback.
      expect(confirmArgs.payment_method_data.billing_details.name).toBe("Restaurante Parceiro LTDA")
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

      expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
        "/store/payment-collections/pc_test_01/payment-sessions",
        {
          method: "POST",
          body: JSON.stringify({ provider_id: "pp_system_default" }),
        },
      )
    })
  })
})
