// Tests for regenerate_pix tool
// Mock-based; no DB, no network, no Redis required.
//
// Scenarios:
// - Happy path — expired PIX payment, within rate limits → new Payment + PIX QR data
// - Customer rate limit exceeded (3/hr) → error with rate limit message
// - Order regen limit exceeded (5 total via regenerationCount) → error
// - Payment not expired (status "payment_pending") → error
// - No active payment → error
// - Payment method not PIX → error

import { describe, it, expect, beforeEach, vi } from "vitest"
import { regeneratePix } from "../regenerate-pix.js"
import { makeCtx } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockGetActiveByOrderId = vi.hoisted(() => vi.fn())
const mockListByOrderId = vi.hoisted(() => vi.fn())
const mockGetById = vi.hoisted(() => vi.fn())
const mockTransitionStatus = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())

const mockWithLock = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

const mockRedisIncr = vi.hoisted(() => vi.fn())
const mockRedisExpire = vi.hoisted(() => vi.fn())

const mockStripePaymentIntentsCreate = vi.hoisted(() => vi.fn())
const mockCancelStalePaymentIntent = vi.hoisted(() => vi.fn())

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@ibatexas/domain", () => ({
  createPaymentQueryService: vi.fn(() => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    listByOrderId: mockListByOrderId,
    getById: mockGetById,
  })),
  createPaymentCommandService: vi.fn(() => ({
    transitionStatus: mockTransitionStatus,
    create: mockCreate,
  })),
}))

vi.mock("../redis/distributed-lock.js", () => ({
  withLock: mockWithLock,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

vi.mock("../redis/client.js", () => ({
  getRedisClient: vi.fn().mockResolvedValue({
    incr: mockRedisIncr,
    expire: mockRedisExpire,
  }),
  rk: vi.fn((key: string) => `ibx:${key}`),
}))

vi.mock("./_stripe-helpers.js", () => ({
  cancelStalePaymentIntent: mockCancelStalePaymentIntent,
  getStripe: vi.fn(() => ({
    paymentIntents: {
      create: mockStripePaymentIntentsCreate,
    },
  })),
}))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INPUT = { orderId: "order_01" }
const CTX = makeCtx({ customerId: "cust_01" })

function makeActivePayment(overrides?: Record<string, unknown>) {
  return {
    id: "pay_01",
    orderId: "order_01",
    method: "pix",
    status: "payment_expired",
    amountInCentavos: 8900,
    stripePaymentIntentId: "pi_test_old",
    regenerationCount: 0,
    version: 1,
    ...overrides,
  }
}

function makeNewPayment(overrides?: Record<string, unknown>) {
  return {
    id: "pay_02",
    orderId: "order_01",
    method: "pix",
    status: "payment_pending",
    amountInCentavos: 8900,
    stripePaymentIntentId: "pi_test_new",
    regenerationCount: 1,
    version: 1,
    ...overrides,
  }
}

function makeStripePaymentIntent(overrides?: Record<string, unknown>) {
  return {
    id: "pi_test_new",
    amount: 8900,
    currency: "brl",
    status: "requires_action",
    next_action: {
      pix_display_qr_code: {
        data: "00020101021226890014br.gov.bcb.pix",
        image_url_svg: "https://qr.stripe.com/test.svg",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("regeneratePix", () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: within rate limits (first call)
    mockRedisIncr.mockResolvedValue(1)
    mockRedisExpire.mockResolvedValue(1)

    // Default: active expired PIX payment
    mockGetActiveByOrderId.mockResolvedValue(makeActivePayment())

    // Default: no prior regenerations
    mockListByOrderId.mockResolvedValue({ payments: [makeActivePayment()] })

    // Default: re-read inside lock still expired
    mockGetById.mockResolvedValue(makeActivePayment())

    // Default: services succeed
    mockCancelStalePaymentIntent.mockResolvedValue(undefined)
    mockTransitionStatus.mockResolvedValue(undefined)
    mockCreate.mockResolvedValue(makeNewPayment())
    mockPublishNatsEvent.mockResolvedValue(undefined)

    // Default Stripe PI with valid PIX QR
    mockStripePaymentIntentsCreate.mockResolvedValue(makeStripePaymentIntent())

    // Default: withLock executes the callback transparently
    mockWithLock.mockImplementation(
      async (_resource: string, fn: () => Promise<unknown>) => fn(),
    )
  })

  it("happy path — expired PIX payment within rate limits returns new PIX QR data", async () => {
    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(true)
    expect(result.pixCopyPaste).toBe("00020101021226890014br.gov.bcb.pix")
    expect(result.pixQrCode).toBe("https://qr.stripe.com/test.svg")
    expect(result.pixExpiresAt).toBeDefined()
    expect(result.message).toBe("Novo PIX gerado! Use o código abaixo para pagar.")
  })

  it("happy path — cancels old Stripe PI and creates new Payment row", async () => {
    await regeneratePix(INPUT, CTX)

    expect(mockCancelStalePaymentIntent).toHaveBeenCalledWith("pi_test_old")
    expect(mockTransitionStatus).toHaveBeenCalledWith(
      "pay_01",
      expect.objectContaining({
        newStatus: "canceled",
        actor: "customer",
        actorId: "cust_01",
        reason: "pix_regeneration",
      }),
    )
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_01",
        method: "pix",
        amountInCentavos: 8900,
        stripePaymentIntentId: "pi_test_new",
        regenerationCount: 1,
      }),
    )
  })

  it("happy path — publishes payment.status_changed NATS event", async () => {
    await regeneratePix(INPUT, CTX)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "payment.status_changed",
      expect.objectContaining({
        orderId: "order_01",
        paymentId: "pay_02",
        previousStatus: "awaiting_payment",
        newStatus: "payment_pending",
        method: "pix",
      }),
    )
  })

  it("customer rate limit exceeded (3/hr) → returns error with rate limit message", async () => {
    // 4th call this hour
    mockRedisIncr.mockResolvedValue(4)

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Limite de gerações atingido. Tente novamente em 1 hora.")
    expect(mockWithLock).not.toHaveBeenCalled()
  })

  it("customer rate limit at exactly 3 succeeds (boundary check)", async () => {
    mockRedisIncr.mockResolvedValue(3)

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(true)
  })

  it("order regen limit exceeded (5 total via regenerationCount) → returns error", async () => {
    // Spread across two payments summing to 5
    mockListByOrderId.mockResolvedValue({
      payments: [
        makeActivePayment({ regenerationCount: 3 }),
        makeActivePayment({ id: "pay_prev", regenerationCount: 2 }),
      ],
    })

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe(
      "Limite de gerações para este pedido atingido. Entre em contato pelo WhatsApp.",
    )
    expect(mockWithLock).not.toHaveBeenCalled()
  })

  it("payment not expired (status payment_pending) → returns error", async () => {
    mockGetActiveByOrderId.mockResolvedValue(makeActivePayment({ status: "payment_pending" }))

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("O pagamento atual não está expirado.")
    expect(mockWithLock).not.toHaveBeenCalled()
  })

  it("no active payment → returns error", async () => {
    mockGetActiveByOrderId.mockResolvedValue(null)

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Nenhum pagamento ativo encontrado para este pedido.")
    expect(mockWithLock).not.toHaveBeenCalled()
  })

  it("no active payment (query throws) → returns error", async () => {
    mockGetActiveByOrderId.mockRejectedValue(new Error("DB unavailable"))

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Nenhum pagamento ativo encontrado para este pedido.")
  })

  it("payment method not PIX → returns error", async () => {
    mockGetActiveByOrderId.mockResolvedValue(makeActivePayment({ method: "credit_card" }))

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Regeneração de PIX só é possível para pagamentos PIX.")
    expect(mockWithLock).not.toHaveBeenCalled()
  })

  it("lock not acquired (withLock returns null) → returns fallback error", async () => {
    mockWithLock.mockResolvedValue(null)

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Operação em andamento. Tente novamente em instantes.")
  })

  it("payment status changed while acquiring lock → returns stale status error", async () => {
    // Inside the lock, re-read shows status is no longer expired
    mockGetById.mockResolvedValue(makeActivePayment({ status: "payment_pending" }))

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("O status do pagamento mudou. Atualize a página.")
    expect(mockTransitionStatus).not.toHaveBeenCalled()
  })

  it("Stripe PI missing PIX data → returns error", async () => {
    mockStripePaymentIntentsCreate.mockResolvedValue({
      id: "pi_test_new",
      // no next_action / pix_display_qr_code
    })

    const result = await regeneratePix(INPUT, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe(
      "Erro ao gerar novo PIX. Tente novamente ou escolha outro método de pagamento.",
    )
  })

  it("no Stripe PI ID on active payment — skips cancelStalePaymentIntent", async () => {
    mockGetActiveByOrderId.mockResolvedValue(
      makeActivePayment({ stripePaymentIntentId: null }),
    )
    mockGetById.mockResolvedValue(makeActivePayment({ stripePaymentIntentId: null }))

    await regeneratePix(INPUT, CTX)

    expect(mockCancelStalePaymentIntent).not.toHaveBeenCalled()
  })

  it("missing customerId → throws NonRetryableError", async () => {
    const unauthCtx = makeCtx({ customerId: undefined })

    await expect(regeneratePix(INPUT, unauthCtx)).rejects.toThrow("Autenticação necessária.")
  })

  it("first incr call sets TTL on rate limit key", async () => {
    mockRedisIncr.mockResolvedValue(1)

    await regeneratePix(INPUT, CTX)

    expect(mockRedisExpire).toHaveBeenCalledWith(expect.stringContaining("cust_01"), 3600)
  })

  it("subsequent incr (count > 1) does not re-set TTL on rate limit key", async () => {
    mockRedisIncr.mockResolvedValue(2)

    await regeneratePix(INPUT, CTX)

    expect(mockRedisExpire).not.toHaveBeenCalled()
  })
})
