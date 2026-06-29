// Tests for amend_order — top-level guards + add/remove/update_qty handlers.
// Mock-based; no network or DB required.
//
// Sibling files cover change_payment happy/error paths
// (amend-order-change-payment.test.ts) and the post-amendment payment sync
// (amend-order-payment-sync.test.ts). This file tops up the UNCOVERED branches:
//
// - amendOrder auth guard (missing customerId) + ownership 404
// - canPerformAction refusal routing (state-blocked add / escalating remove)
// - handleAddItem: missing variantId, no-PIX success, medusa error path
// - handleRemoveItem: missing itemTitle, PONR escalation event, legacy PIX
//   regen append, regeneratePixIfNeeded zero-total short-circuit
// - handleUpdateQty: missing args, item-not-found, PONR escalation, success,
//   medusa error path
// - handleChangePayment branches NOT in the sibling file: missing method,
//   kernel REFUSE routing, lock-not-acquired, cash→PIX success
// - syncPaymentAndPixAfterAmendment crash-on-create-REFUSE semantics

import { describe, it, expect, beforeEach, vi } from "vitest"
import { amendOrder } from "../amend-order.js"
import { makeCtx, makeGuestCtx } from "./fixtures/medusa.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockMedusaAdmin = vi.hoisted(() => vi.fn())
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn())
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn())
const mockGetById = vi.hoisted(() => vi.fn())
const mockTransitionStatusFromEnvelope = vi.hoisted(() => vi.fn())
const mockCreateFromEnvelope = vi.hoisted(() => vi.fn())
const mockGetOrder = vi.hoisted(() => vi.fn())
const mockCancelItem = vi.hoisted(() => vi.fn())
const mockOrderQueryGetById = vi.hoisted(() => vi.fn())
const mockCancelStalePaymentIntent = vi.hoisted(() => vi.fn())
const mockStripePaymentIntentsCreate = vi.hoisted(() => vi.fn())
const mockWithLock = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockGetEffectivePonr = vi.hoisted(() => vi.fn())
const mockIsWithinPonr = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}))

vi.mock("../../medusa/adjudicated.js", () => ({
  medusaAdjudicated: mockMedusaAdjudicated,
}))

vi.mock("@ibatexas/domain", () => ({
  createOrderService: vi.fn(() => ({
    getOrder: mockGetOrder,
    cancelItem: mockCancelItem,
  })),
  createOrderQueryService: vi.fn(() => ({
    getById: mockOrderQueryGetById,
  })),
  createPaymentQueryService: vi.fn(() => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    getById: mockGetById,
  })),
  createPaymentCommandService: vi.fn(() => ({
    transitionStatusFromEnvelope: mockTransitionStatusFromEnvelope,
    createFromEnvelope: mockCreateFromEnvelope,
  })),
  // handleUpdateQty resolves these via a dynamic import("@ibatexas/domain").
  getEffectivePonr: mockGetEffectivePonr,
  isWithinPonr: mockIsWithinPonr,
}))

vi.mock("../_stripe-helpers.js", () => ({
  cancelStalePaymentIntent: mockCancelStalePaymentIntent,
  getStripe: vi.fn(),
}))

vi.mock("../../stripe/adjudicated.js", () => ({
  stripeAdjudicated: {
    paymentIntents: { create: mockStripePaymentIntentsCreate },
  },
}))

vi.mock("../../redis/distributed-lock.js", () => ({
  withLock: mockWithLock,
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// ── Shared fixtures ────────────────────────────────────────────────────────────

const CTX = makeCtx({ customerId: "cust_01" })

const ITEM_TITLE = "Costela Bovina Defumada 500g"

/** Order shape returned by svc.getOrder(orderId, customerId). */
function makeOrderEnvelope(overrides?: {
  metadata?: Record<string, string>
  total?: number
  items?: Array<Record<string, unknown>>
  ownershipValid?: boolean
  created_at?: string
}) {
  return {
    order: {
      id: "order_01",
      status: "pending",
      customer_id: "cust_01",
      created_at: overrides?.created_at ?? "2026-06-28T12:00:00.000Z",
      items: overrides?.items ?? [
        { id: "item_99", title: ITEM_TITLE, quantity: 2 },
      ],
      total: overrides?.total ?? 26700,
      metadata: overrides?.metadata ?? {},
    },
    ownershipValid: overrides?.ownershipValid ?? true,
  }
}

function makeActivePayment(overrides?: Record<string, unknown>) {
  return {
    id: "pay_01",
    orderId: "order_01",
    method: "pix",
    status: "awaiting_payment",
    amountInCentavos: 26700,
    stripePaymentIntentId: "pi_test_pix_01",
    version: 1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()

  mockGetOrder.mockResolvedValue(makeOrderEnvelope())
  mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "pending" })
  mockMedusaAdjudicated.mockResolvedValue({ order_edit: { id: "edit_01" } })
  mockMedusaAdmin.mockResolvedValue({})
  mockGetActiveByOrderId.mockResolvedValue(null)
  mockCancelStalePaymentIntent.mockResolvedValue(undefined)
  mockPublishNatsEvent.mockResolvedValue(undefined)

  // withLock invokes the callback directly by default.
  mockWithLock.mockImplementation(
    async (_key: string, fn: () => Promise<unknown>) => fn(),
  )

  mockGetEffectivePonr.mockReturnValue({ amendMinutes: 30, cancelMinutes: 60 })
  mockIsWithinPonr.mockReturnValue(true)

  mockTransitionStatusFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE", basis: [] },
    result: { version: 2 },
  })
  mockCreateFromEnvelope.mockResolvedValue({
    decision: { kind: "EXECUTE", basis: [] },
    result: { id: "pay_02", version: 1 },
  })
})

// ── amendOrder top-level guards ────────────────────────────────────────────────

describe("amendOrder — auth & ownership guards", () => {
  it("throws NonRetryableError when no customerId is present", async () => {
    await expect(
      amendOrder(
        { orderId: "order_01", action: "add", variantId: "variant_01" },
        makeGuestCtx(),
      ),
    ).rejects.toThrow("Autenticação necessária para modificar pedido.")
  })

  it("returns 'Pedido não encontrado.' when ownership is invalid", async () => {
    mockGetOrder.mockResolvedValue(makeOrderEnvelope({ ownershipValid: false }))

    const result = await amendOrder(
      { orderId: "order_01", action: "add", variantId: "variant_01" },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido não encontrado.")
    // No mutation attempted when ownership fails.
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled()
  })
})

describe("amendOrder — action allowed-state gating (canPerformAction)", () => {
  it("refuses add when the order fulfillment state blocks it (canceled)", async () => {
    mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "canceled" })

    const result = await amendOrder(
      { orderId: "order_01", action: "add", variantId: "variant_01" },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido cancelado.")
    expect(result.needsEscalation).toBeUndefined()
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled()
  })

  it("refuses remove with escalation when the kitchen is preparing", async () => {
    mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "preparing" })

    const result = await amendOrder(
      { orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain("Cozinha já está preparando")
    expect(result.needsEscalation).toBe(true)
    // Blocked before reaching the domain mutation.
    expect(mockCancelItem).not.toHaveBeenCalled()
  })
})

// ── handleAddItem ──────────────────────────────────────────────────────────────

describe("amendOrder — add item", () => {
  it("rejects when variantId is missing", async () => {
    const result = await amendOrder({ orderId: "order_01", action: "add" }, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("ID da variante necessário para adicionar item.")
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled()
  })

  it("adds the item via 3 adjudicated order-edit calls and returns the no-PIX message", async () => {
    // No active payment + no metadata PI → nothing to regenerate.
    const result = await amendOrder(
      { orderId: "order_01", action: "add", variantId: "variant_42", quantity: 3 },
      CTX,
    )

    expect(result.success).toBe(true)
    expect(result.message).toBe("Item adicionado ao pedido.")
    expect(result.newPixQrCodeText).toBeUndefined()

    // create edit → add item → confirm
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(3)
    const addItemCall = mockMedusaAdjudicated.mock.calls[1][0]
    expect(addItemCall.path).toBe("/admin/orders/order_01/edits/edit_01/items")
    expect(addItemCall.payload).toEqual({ variant_id: "variant_42", quantity: 3 })
    // Legacy-order path: no Stripe PI regen.
    expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled()
  })

  it("returns an escalating error when an adjudicated edit call throws", async () => {
    mockMedusaAdjudicated.mockRejectedValueOnce(new Error("kernel refused edit"))

    const result = await amendOrder(
      { orderId: "order_01", action: "add", variantId: "variant_42" },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe("Erro ao adicionar item: kernel refused edit")
    expect(result.needsEscalation).toBe(true)
  })
})

// ── handleRemoveItem ────────────────────────────────────────────────────────────

describe("amendOrder — remove item", () => {
  it("rejects when itemTitle is missing", async () => {
    const result = await amendOrder({ orderId: "order_01", action: "remove" }, CTX)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Nome do item necessário para remover.")
    expect(mockCancelItem).not.toHaveBeenCalled()
  })

  it("publishes an escalation event when cancelItem needs escalation (past PONR)", async () => {
    mockCancelItem.mockResolvedValue({
      success: false,
      needsEscalation: true,
      message: "Prazo para remover já passou. Um atendente foi notificado.",
    })

    const result = await amendOrder(
      { orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.needsEscalation).toBe(true)
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "order.escalation_needed",
      expect.objectContaining({
        orderId: "order_01",
        customerId: "cust_01",
        reason: "amend_remove_past_ponr",
        itemTitle: ITEM_TITLE,
      }),
    )
    // No PIX regen since the removal did not succeed.
    expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled()
  })

  it("appends the new PIX code to the message when a successful removal regenerates PIX (legacy)", async () => {
    mockCancelItem.mockResolvedValue({ success: true, message: "Item removido do pedido." })
    mockGetOrder.mockResolvedValue(
      makeOrderEnvelope({ metadata: { stripePaymentIntentId: "pi_old" }, total: 30000 }),
    )
    mockStripePaymentIntentsCreate.mockResolvedValue({
      id: "pi_new",
      next_action: { pix_display_qr_code: { data: "qrtext", image_url_svg: "https://qr.svg" } },
    })

    const result = (await amendOrder(
      { orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE },
      CTX,
    )) as { success: boolean; message: string; newPixQrCodeText?: string }

    expect(result.success).toBe(true)
    expect(result.message).toBe(
      "Item removido do pedido. Novo código PIX gerado — use o código abaixo para pagar.",
    )
    expect(result.newPixQrCodeText).toBe("qrtext")
    // The stale PI was canceled and a new one minted with the amended total.
    expect(mockCancelStalePaymentIntent).toHaveBeenCalledWith("pi_old")
    expect(mockStripePaymentIntentsCreate.mock.calls[0][0]).toMatchObject({ amount: 30000 })
  })

  it("does NOT regenerate PIX when the amended total is zero (short-circuit)", async () => {
    mockCancelItem.mockResolvedValue({ success: true, message: "Item removido do pedido." })
    mockGetOrder.mockResolvedValue(
      makeOrderEnvelope({ metadata: { stripePaymentIntentId: "pi_old" }, total: 0 }),
    )

    const result = await amendOrder(
      { orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE },
      CTX,
    )

    expect(result.success).toBe(true)
    // Message unchanged — no PIX appended.
    expect(result.message).toBe("Item removido do pedido.")
    // The stale PI is still canceled, but no new PI is created on a zero total.
    expect(mockCancelStalePaymentIntent).toHaveBeenCalledWith("pi_old")
    expect(mockStripePaymentIntentsCreate).not.toHaveBeenCalled()
  })
})

// ── handleUpdateQty ─────────────────────────────────────────────────────────────

describe("amendOrder — update quantity", () => {
  it("rejects when itemTitle or quantity is missing", async () => {
    const result = await amendOrder(
      { orderId: "order_01", action: "update_qty", itemTitle: ITEM_TITLE },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe("Nome do item e quantidade necessários.")
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled()
  })

  it("returns item-not-found when the title is not on the order", async () => {
    const result = await amendOrder(
      { orderId: "order_01", action: "update_qty", itemTitle: "Picanha", quantity: 2 },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('Item "Picanha" não encontrado no pedido.')
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled()
  })

  it("escalates when the PONR window for a quantity change has passed", async () => {
    mockIsWithinPonr.mockReturnValue(false)

    const result = await amendOrder(
      { orderId: "order_01", action: "update_qty", itemTitle: ITEM_TITLE, quantity: 5 },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.needsEscalation).toBe(true)
    expect(result.message).toContain("Prazo para alterar")
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "order.escalation_needed",
      expect.objectContaining({ reason: "amend_qty_past_ponr", itemTitle: ITEM_TITLE }),
    )
    // No order-edit performed when past PONR.
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled()
  })

  it("updates the quantity via order edit when within PONR", async () => {
    const result = await amendOrder(
      { orderId: "order_01", action: "update_qty", itemTitle: ITEM_TITLE, quantity: 5 },
      CTX,
    )

    expect(result.success).toBe(true)
    expect(result.message).toBe(`Quantidade de "${ITEM_TITLE}" atualizada para 5.`)
    // create edit → update item → confirm
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(3)
    const updateCall = mockMedusaAdjudicated.mock.calls[1][0]
    expect(updateCall.path).toBe("/admin/orders/order_01/edits/edit_01/items/item_99")
    expect(updateCall.payload).toEqual({ quantity: 5 })
  })

  it("returns an escalating error when an adjudicated update call throws", async () => {
    mockMedusaAdjudicated.mockRejectedValueOnce(new Error("edit blew up"))

    const result = await amendOrder(
      { orderId: "order_01", action: "update_qty", itemTitle: ITEM_TITLE, quantity: 5 },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe("Erro ao atualizar quantidade: edit blew up")
    expect(result.needsEscalation).toBe(true)
  })
})

// ── handleChangePayment — branches not covered by the sibling file ──────────────

describe("amendOrder — change_payment additional branches", () => {
  it("rejects when paymentMethod is missing", async () => {
    const result = await amendOrder(
      { orderId: "order_01", action: "change_payment" },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe("Método de pagamento necessário.")
  })

  it("surfaces the kernel refusal message when the switching_method transition is REFUSED", async () => {
    mockGetActiveByOrderId.mockResolvedValue(makeActivePayment())
    mockTransitionStatusFromEnvelope.mockResolvedValue({
      decision: {
        kind: "REFUSE",
        refusal: { userFacing: "Troca de método não permitida agora." },
      },
    })

    const result = await amendOrder(
      { orderId: "order_01", action: "change_payment", paymentMethod: "card" },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe("Troca de método não permitida agora.")
    // We never proceeded to create a replacement payment.
    expect(mockCreateFromEnvelope).not.toHaveBeenCalled()
  })

  it("returns the in-progress message when the payment lock cannot be acquired", async () => {
    mockGetActiveByOrderId.mockResolvedValue(makeActivePayment())
    mockWithLock.mockResolvedValue(null) // lock held by a concurrent switch

    const result = await amendOrder(
      { orderId: "order_01", action: "change_payment", paymentMethod: "card" },
      CTX,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe("Operação em andamento. Tente novamente em instantes.")
  })

  it("switches cash → PIX, minting a new PIX PI and returning the QR code", async () => {
    mockGetActiveByOrderId.mockResolvedValue(
      makeActivePayment({ method: "cash", stripePaymentIntentId: undefined }),
    )
    mockGetById.mockResolvedValue(makeActivePayment({ method: "cash", version: 2 }))
    mockStripePaymentIntentsCreate.mockResolvedValue({
      id: "pi_pix_new",
      next_action: {
        pix_display_qr_code: {
          data: "pix-copia-cola",
          image_url_svg: "https://stripe.test/pix.svg",
          expires_at: 1_750_000_000,
        },
      },
    })
    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { id: "pay_pix", version: 1 },
    })

    const result = (await amendOrder(
      { orderId: "order_01", action: "change_payment", paymentMethod: "pix" },
      CTX,
    )) as { success: boolean; message: string; newPixQrCodeText?: string; newPixQrCodeUrl?: string }

    expect(result.success).toBe(true)
    expect(result.message).toBe("Pagamento alterado para PIX. Novo código gerado.")
    expect(result.newPixQrCodeText).toBe("pix-copia-cola")
    expect(result.newPixQrCodeUrl).toBe("https://stripe.test/pix.svg")

    // New PI created for pix with the existing amount.
    expect(mockStripePaymentIntentsCreate.mock.calls[0][0]).toMatchObject({
      amount: 26700,
      payment_method_types: ["pix"],
    })
    // The created payment carries the pix expiry derived from the PI.
    const createEnv = mockCreateFromEnvelope.mock.calls[0][0]
    expect(createEnv.payload.method).toBe("pix")
    expect(createEnv.payload.pixExpiresAt).toBe(new Date(1_750_000_000 * 1000).toISOString())
    // No stale PI to cancel — the previous method was cash.
    expect(mockCancelStalePaymentIntent).not.toHaveBeenCalled()
  })
})

// ── syncPaymentAndPixAfterAmendment crash-on-create-REFUSE ──────────────────────

describe("amendOrder — payment sync fails closed on create REFUSE", () => {
  it("throws (legacy crash semantics) when the replacement payment.create is REFUSED", async () => {
    mockCancelItem.mockResolvedValue({ success: true, message: "Item removido do pedido." })
    // Active, non-terminal payment → enters the locked swap path.
    mockGetActiveByOrderId.mockResolvedValue(makeActivePayment())
    mockGetById.mockResolvedValue(makeActivePayment())
    mockGetOrder.mockResolvedValue(
      makeOrderEnvelope({ metadata: { stripePaymentIntentId: "pi_old" }, total: 30000 }),
    )
    mockStripePaymentIntentsCreate.mockResolvedValue({
      id: "pi_new",
      next_action: { pix_display_qr_code: { data: "qr", image_url_svg: "u" } },
    })
    // Cancel of the old row is tolerated; the create is REFUSED → must throw.
    mockCreateFromEnvelope.mockResolvedValue({
      decision: { kind: "REFUSE", refusal: { userFacing: "Não foi possível criar pagamento." } },
    })

    await expect(
      amendOrder({ orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE }, CTX),
    ).rejects.toThrow("Não foi possível criar pagamento.")
  })
})
