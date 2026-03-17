// Tests for create_checkout tool
// Mock-based; no network required.
//
// Scenarios:
// - Cash payment → completes cart, publishes NATS order.placed
// - Card payment → returns stripeClientSecret
// - PIX payment → calls Stripe to retrieve QR code
// - Missing Stripe session → {success: false}
// - Metadata (tip, CEP, customerId) passed to cart update
// - Unsupported payment method → {success: false}
// - PIX retrieval error → graceful fallback

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaStoreFetch = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockStripeRetrieve = vi.hoisted(() => vi.fn())

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
        retrieve: mockStripeRetrieve,
      },
    })),
  }
})

// ── Imports ──────────────────────────────────────────────────────────────────

import { createCheckout } from "../create-checkout.js"
import { makeCtx, makePaymentSession } from "./fixtures/medusa.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CTX = makeCtx()

const BASE_INPUT = {
  cartId: "cart_01",
  paymentMethod: "cash" as const,
}

const PAYMENT_SESSION_RESPONSE = {
  cart: {
    payment_sessions: [makePaymentSession()],
  },
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createCheckout", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: cart update, payment session init, and complete all succeed
    mockMedusaStoreFetch.mockResolvedValue({})
    mockPublishNatsEvent.mockResolvedValue(undefined)
    // Set STRIPE_SECRET_KEY for Stripe constructor
    process.env.STRIPE_SECRET_KEY = "sk_test_123"
  })

  describe("metadata update", () => {
    it("updates cart with customerId in metadata", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({}) // cart metadata update
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE) // payment sessions
        .mockResolvedValueOnce({ order: { id: "order_01" } }) // complete

      await createCheckout(BASE_INPUT, CTX)

      expect(mockMedusaStoreFetch).toHaveBeenNthCalledWith(
        1,
        "/store/carts/cart_01",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("customerId"),
        }),
      )
    })

    it("includes tipInCentavos in metadata when provided", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({}) // cart metadata update
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE) // payment sessions
        .mockResolvedValueOnce({ order: { id: "order_01" } }) // complete

      await createCheckout({ ...BASE_INPUT, tipInCentavos: 1000 }, CTX)

      const [, opts] = mockMedusaStoreFetch.mock.calls[0]
      const body = JSON.parse(opts.body)
      expect(body.metadata.tipInCentavos).toBe("1000")
    })

    it("includes deliveryCep in metadata when provided", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({}) // cart metadata update
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE) // payment sessions
        .mockResolvedValueOnce({ order: { id: "order_01" } }) // complete

      await createCheckout({ ...BASE_INPUT, deliveryCep: "12345-678" }, CTX)

      const [, opts] = mockMedusaStoreFetch.mock.calls[0]
      const body = JSON.parse(opts.body)
      expect(body.metadata.deliveryCep).toBe("12345-678")
    })
  })

  describe("cash payment", () => {
    it("completes cart directly for cash payment", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({}) // cart metadata
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE) // payment sessions
        .mockResolvedValueOnce({ order: { id: "order_01" } }) // complete

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.paymentMethod).toBe("cash")
      expect(result.orderId).toBe("order_01")
    })

    it("calls cart complete endpoint with cash provider", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({}) // cart metadata
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE) // payment sessions
        .mockResolvedValueOnce({ order: { id: "order_01" } }) // complete

      await createCheckout(BASE_INPUT, CTX)

      expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
        "/store/carts/cart_01/complete",
        {
          method: "POST",
          body: JSON.stringify({ payment_provider_id: "cash" }),
        },
      )
    })

    it("publishes order.placed NATS event on cash success", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE)
        .mockResolvedValueOnce({ order: { id: "order_01" } })

      await createCheckout(BASE_INPUT, CTX)

      expect(mockPublishNatsEvent).toHaveBeenCalledWith(
        "ibatexas.order.placed",
        expect.objectContaining({
          eventType: "order.placed",
          orderId: "order_01",
          paymentMethod: "cash",
          customerId: CTX.customerId,
        }),
      )
    })

    it("returns success message with order ID", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE)
        .mockResolvedValueOnce({ order: { id: "order_42" } })

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.message).toContain("order_42")
      expect(result.message).toContain("dinheiro")
    })

    it("returns success even when order.id is missing from complete response", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE)
        .mockResolvedValueOnce({ order: undefined })

      const result = await createCheckout(BASE_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.orderId).toBeUndefined()
      expect(result.message).toContain("dinheiro")
    })

    it("does not publish NATS when order.id is missing", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE)
        .mockResolvedValueOnce({ order: undefined })

      await createCheckout(BASE_INPUT, CTX)

      expect(mockPublishNatsEvent).not.toHaveBeenCalled()
    })
  })

  describe("card payment", () => {
    const CARD_INPUT = { ...BASE_INPUT, paymentMethod: "card" as const }

    it("returns stripeClientSecret on success", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({}) // cart metadata
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE) // payment sessions with stripe

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.paymentMethod).toBe("card")
      expect(result.stripeClientSecret).toBe("pi_secret_test123")
    })

    it("returns message about using client_secret in frontend", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE)

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.message).toContain("client_secret")
    })

    it("returns success:false when no Stripe session found", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ cart: { payment_sessions: [] } })

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.success).toBe(false)
      expect(result.message).toContain("N\u00e3o foi poss\u00edvel inicializar o pagamento")
    })

    it("returns success:false when payment_sessions is null", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ cart: { payment_sessions: null } })

      const result = await createCheckout(CARD_INPUT, CTX)

      expect(result.success).toBe(false)
    })
  })

  describe("PIX payment", () => {
    const PIX_INPUT = { ...BASE_INPUT, paymentMethod: "pix" as const }

    it("retrieves PIX QR code from Stripe", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({}) // cart metadata
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE) // payment sessions

      mockStripeRetrieve.mockResolvedValue({
        next_action: {
          pix_display_qr_code: {
            data: "00020126580014br.gov.bcb.pix...",
            image_url_svg: "https://stripe.com/pix-qr.svg",
            expires_at: 1711987200,
          },
        },
      })

      const result = await createCheckout(PIX_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.paymentMethod).toBe("pix")
      expect(result.pixQrCodeUrl).toBe("https://stripe.com/pix-qr.svg")
      expect(result.pixQrCodeText).toContain("00020126")
      expect(result.pixExpiresAt).toBeDefined()
    })

    it("returns success message about scanning QR code", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE)

      mockStripeRetrieve.mockResolvedValue({
        next_action: {
          pix_display_qr_code: {
            data: "pix-code-data",
            image_url_svg: "https://stripe.com/qr.svg",
          },
        },
      })

      const result = await createCheckout(PIX_INPUT, CTX)

      expect(result.message).toContain("PIX gerado com sucesso")
    })

    it("returns fallback message when PIX data is missing", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE)

      mockStripeRetrieve.mockResolvedValue({
        next_action: {
          pix_display_qr_code: {},
        },
      })

      const result = await createCheckout(PIX_INPUT, CTX)

      expect(result.success).toBe(true)
      expect(result.message).toContain("Finalize o pagamento")
    })

    it("returns success:false when Stripe PIX retrieval throws", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE)

      mockStripeRetrieve.mockRejectedValue(new Error("Stripe error"))

      const result = await createCheckout(PIX_INPUT, CTX)

      expect(result.success).toBe(false)
      expect(result.paymentMethod).toBe("pix")
      expect(result.message).toContain("Erro ao gerar QR Code PIX")
    })

    it("returns success:false when no Stripe session found for PIX", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ cart: { payment_sessions: [] } })

      const result = await createCheckout(PIX_INPUT, CTX)

      expect(result.success).toBe(false)
      expect(result.message).toContain("N\u00e3o foi poss\u00edvel inicializar o pagamento")
    })

    it("converts expires_at timestamp to ISO string", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE)

      const expiresAtUnix = 1711987200
      mockStripeRetrieve.mockResolvedValue({
        next_action: {
          pix_display_qr_code: {
            data: "pix-code",
            image_url_svg: "https://stripe.com/qr.svg",
            expires_at: expiresAtUnix,
          },
        },
      })

      const result = await createCheckout(PIX_INPUT, CTX)

      expect(result.pixExpiresAt).toBe(new Date(expiresAtUnix * 1000).toISOString())
    })
  })

  describe("unsupported payment method", () => {
    it("returns success:false for unknown payment method without Stripe session", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ cart: { payment_sessions: [] } })

      // Force an unknown type by casting
      const input = { ...BASE_INPUT, paymentMethod: "bitcoin" as "pix" }

      const result = await createCheckout(input, CTX)

      expect(result.success).toBe(false)
    })
  })

  describe("payment sessions initialization", () => {
    it("initializes payment sessions on the cart", async () => {
      mockMedusaStoreFetch
        .mockResolvedValueOnce({}) // cart metadata
        .mockResolvedValueOnce(PAYMENT_SESSION_RESPONSE) // payment sessions
        .mockResolvedValueOnce({ order: { id: "order_01" } }) // complete (for cash)

      await createCheckout(BASE_INPUT, CTX)

      expect(mockMedusaStoreFetch).toHaveBeenCalledWith(
        "/store/carts/cart_01/payment-sessions",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      )
    })
  })
})
