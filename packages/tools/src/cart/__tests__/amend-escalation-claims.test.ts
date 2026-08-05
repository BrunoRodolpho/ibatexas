// F-48 — the amend-family "Um atendente foi notificado" claim census, pinned.
//
// Five sites tell an amend/cancel customer that an attendant has been notified.
// After F-48 each one is in exactly one of two classes, and this file pins BOTH
// so neither can drift silently:
//
//   NOW-TRUE (wired) — a `support.handoff_requested` publish reaches the staff
//   spine (handoff-subscriber → escalation store + staff WhatsApp):
//     • order.service.ts:282  cancelItem past PONR      → amend-order.ts handleRemoveItem
//     • order.service.ts:333  cancelItem edit failure   → amend-order.ts handleRemoveItem
//     • amend-order.ts:390    update_qty past PONR      → handleUpdateQty
//     (+ order.service.ts:233 cancel past PONR → cancel-order.ts, pinned in
//      cancel-order.test.ts)
//
//   STILL-FALSE (residual, OWNER decision pending) — the copy claims a
//   notification and NOTHING is published:
//     • order-action-validator.ts:77  the routine 'preparing'-state denial
//     • order-action-validator.ts:79  PONR-expired — additionally UNREACHABLE
//       from every amend caller (measured below)
//
// Changing customer-facing pt-BR copy is OWNER territory, so this slice pins
// the residual rather than editing the strings. If a later change wires :77,
// the residual test below goes RED and must be deleted deliberately — that is
// the point of naming a test after a FALSE claim.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { canPerformAction, type ActionContext, type OrderFulfillmentStatus } from "@ibatexas/types"
import { amendOrder } from "../amend-order.js"
import { makeCtx } from "./fixtures/medusa.js"

// ── Hoisted mocks (caller boundary only — amendOrder itself is REAL) ─────────

const mockMedusaAdjudicated = vi.hoisted(() => vi.fn())
const mockGetOrder = vi.hoisted(() => vi.fn())
const mockCancelItem = vi.hoisted(() => vi.fn())
const mockOrderQueryGetById = vi.hoisted(() => vi.fn())
const mockGetActiveByOrderId = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())
const mockGetEffectivePonr = vi.hoisted(() => vi.fn())
const mockIsWithinPonr = vi.hoisted(() => vi.fn())

vi.mock("../../medusa/client.js", () => ({ medusaAdmin: vi.fn() }))
vi.mock("../../medusa/adjudicated.js", () => ({ medusaAdjudicated: mockMedusaAdjudicated }))

vi.mock("@ibatexas/domain", () => ({
  createOrderService: vi.fn(() => ({ getOrder: mockGetOrder, cancelItem: mockCancelItem })),
  createOrderQueryService: vi.fn(() => ({ getById: mockOrderQueryGetById })),
  createPaymentQueryService: vi.fn(() => ({
    getActiveByOrderId: mockGetActiveByOrderId,
    getById: vi.fn(),
  })),
  createPaymentCommandService: vi.fn(() => ({
    transitionStatusFromEnvelope: vi.fn(),
    createFromEnvelope: vi.fn(),
  })),
  getEffectivePonr: mockGetEffectivePonr,
  isWithinPonr: mockIsWithinPonr,
}))

vi.mock("../_stripe-helpers.js", () => ({
  cancelStalePaymentIntent: vi.fn(),
  getStripe: vi.fn(),
}))
vi.mock("../../stripe/adjudicated.js", () => ({
  stripeAdjudicated: { paymentIntents: { create: vi.fn() } },
}))
vi.mock("../../redis/distributed-lock.js", () => ({
  withLock: vi.fn(async (_k: string, fn: () => Promise<unknown>) => fn()),
}))
vi.mock("@ibatexas/nats-client", () => ({ publishNatsEvent: mockPublishNatsEvent }))

// ── Fixtures ────────────────────────────────────────────────────────────────

const CTX = makeCtx({ customerId: "cust_01" })
const ITEM_TITLE = "Costela Bovina Defumada 500g"

/** The exact pt-BR strings under audit. Written out, never derived. */
const CLAIM = "Um atendente foi notificado"
const VALIDATOR_PREPARING_COPY = "Cozinha já está preparando. Um atendente foi notificado."
const VALIDATOR_PONR_COPY = "Prazo para alteração expirou. Um atendente foi notificado."

function orderEnvelope() {
  return {
    order: {
      id: "order_01",
      status: "pending",
      customer_id: "cust_01",
      created_at: "2026-06-28T12:00:00.000Z",
      items: [{ id: "item_99", title: ITEM_TITLE, quantity: 2 }],
      total: 26700,
      metadata: {},
    },
    ownershipValid: true,
  }
}

function handoffSubjects(): string[] {
  return mockPublishNatsEvent.mock.calls
    .map((c: unknown[]) => c[0] as string)
    .filter((s) => s === "support.handoff_requested")
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetOrder.mockResolvedValue(orderEnvelope())
  mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "pending" })
  mockMedusaAdjudicated.mockResolvedValue({ order_edit: { id: "edit_01" } })
  mockGetActiveByOrderId.mockResolvedValue(null)
  mockPublishNatsEvent.mockResolvedValue(undefined)
  mockGetEffectivePonr.mockReturnValue({ amendMinutes: 30, cancelMinutes: 60 })
  mockIsWithinPonr.mockReturnValue(true)
})

// ── RESIDUAL: the 'preparing' denial (validator :77) ─────────────────────────

describe("F-48 residual — the 'preparing'-state denial claims a notification that never happens", () => {
  // The during-arm and the absence-arm live in the SAME test on purpose: an
  // "X is not published" assertion is vacuous unless the same driver is shown
  // to publish X under the treatment it is being contrasted with.
  it("remove during 'preparing': the customer is told an attendant was notified, and NOTHING is published (while the past-PONR arm DOES publish)", async () => {
    // ── during-arm: the wired path publishes, so the spy can observe one ────
    mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "pending" })
    mockCancelItem.mockResolvedValue({
      success: false,
      needsEscalation: true,
      message: `Prazo para remover "${ITEM_TITLE}" já passou. ${CLAIM}.`,
    })
    const wired = await amendOrder(
      { orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE },
      CTX,
    )
    expect(wired.message).toContain(CLAIM)
    expect(handoffSubjects()).toHaveLength(1) // ← the observable IS reachable here

    // ── absence-arm: same driver, 'preparing' state, no publish ────────────
    mockPublishNatsEvent.mockClear()
    mockCancelItem.mockClear()
    mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "preparing" })

    const residual = await amendOrder(
      { orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE },
      CTX,
    )

    expect(residual.success).toBe(false)
    expect(residual.needsEscalation).toBe(true)
    // The claim IS made to the customer…
    expect(residual.message).toBe(VALIDATOR_PREPARING_COPY)
    expect(residual.message).toContain(CLAIM)
    // …and no attendant is reached. STILL FALSE — see the file header.
    expect(handoffSubjects()).toHaveLength(0)
    // The denial short-circuits before the handler, so cancelItem never runs.
    expect(mockCancelItem).not.toHaveBeenCalled()
  })

  it("update_qty during 'preparing': same false claim, same silence", async () => {
    mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "preparing" })

    const result = await amendOrder(
      { orderId: "order_01", action: "update_qty", itemTitle: ITEM_TITLE, quantity: 5 },
      CTX,
    )

    expect(result.message).toBe(VALIDATOR_PREPARING_COPY)
    expect(result.needsEscalation).toBe(true)
    expect(handoffSubjects()).toHaveLength(0)
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled()
  })
})

// ── MEASUREMENT: validator arm :79 is unreachable from the amend callers ─────

describe("F-48 measurement — the validator's PONR-expired arm is UNREACHABLE from every amend caller", () => {
  // Hand-written roll call. NOT derived from the OrderFulfillmentStatus union:
  // deriving the iteration source from the thing under test means deleting a
  // status deletes its own coverage.
  const ALL_STATUSES: readonly OrderFulfillmentStatus[] = [
    "pending",
    "confirmed",
    "preparing",
    "ready",
    "in_delivery",
    "delivered",
    "canceled",
  ]

  it("roll call covers all seven fulfillment statuses", () => {
    expect(ALL_STATUSES).toHaveLength(7)
    expect(new Set(ALL_STATUSES).size).toBe(7)
  })

  // TREATMENT — every amend-family caller passes ONLY `fulfillmentStatus`:
  //   packages/tools/src/cart/amend-order.ts:714
  //   apps/api/src/routes/order-actions.ts:763
  //   apps/api/src/claustrum/amend-preference-correction.ts:162 (reads .allowed only)
  // `withinPonr` returns TRUE when orderCreatedAt or ponrMinutes is absent, so
  // the arm can never be reached on any of them.
  it("TREATMENT: called the way every caller calls it, no status can produce the PONR-expired copy", () => {
    const reasons = ALL_STATUSES.flatMap((fulfillmentStatus) =>
      (["amend_remove_item", "amend_update_qty"] as const).map((action) => {
        const r = canPerformAction(action, { fulfillmentStatus })
        return r.allowed ? "<allowed>" : r.reason
      }),
    )

    expect(reasons).not.toContain(VALIDATOR_PONR_COPY)
    // Non-trivially exercised: the 'preparing' copy IS produced by this same call shape.
    expect(reasons).toContain(VALIDATOR_PREPARING_COPY)
  })

  // The recommendation, pinned. For the SAME `preparing` state and the SAME
  // PONR-expiry condition, this validator's sibling arms tell the customer the
  // truth — "Entre em contato com o restaurante." — and only the
  // remove/update_qty arms claim a notification. That makes :77/:79 look like a
  // copy defect rather than a policy decision, and it means the honest wording
  // an OWNER would need already exists in the same file. If a sibling's copy
  // ever changes, this reds and the recommendation must be re-derived.
  it("sibling arms for the SAME states already use honest copy (the precedent for fixing :77/:79)", () => {
    const cancelPreparing = canPerformAction("cancel_order", { fulfillmentStatus: "preparing" })
    const addressPreparing = canPerformAction("change_delivery_address", {
      fulfillmentStatus: "preparing",
      orderType: "delivery",
    })
    const cancelPonr = canPerformAction("cancel_order", {
      fulfillmentStatus: "pending",
      orderCreatedAt: new Date(Date.now() - 120 * 60_000),
      ponrMinutes: 30,
    })

    for (const r of [cancelPreparing, addressPreparing, cancelPonr]) {
      expect(r.allowed).toBe(false)
      const reason = (r as { reason: string }).reason
      expect(reason).toContain("Entre em contato com o restaurante")
      expect(reason).not.toContain(CLAIM)
    }
  })

  // CONTROL — the arm is live code, not dead code. Without this the treatment
  // above would pass just as happily against a validator with the arm DELETED.
  it("CONTROL: the same validator DOES produce that copy once PONR context is supplied", () => {
    const ctx: ActionContext = {
      fulfillmentStatus: "pending",
      orderCreatedAt: new Date(Date.now() - 120 * 60_000),
      ponrMinutes: 30,
    }

    const result = canPerformAction("amend_remove_item", ctx)

    expect(result.allowed).toBe(false)
    expect((result as { reason: string }).reason).toBe(VALIDATOR_PONR_COPY)
  })

  // The behavioural consequence: a genuinely past-PONR amend is denied by the
  // HANDLER (which publishes), never by the validator arm (which would not).
  it("a past-PONR update_qty is denied by the handler's own check — and IS escalated", async () => {
    mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "confirmed" })
    mockIsWithinPonr.mockReturnValue(false)

    const result = await amendOrder(
      { orderId: "order_01", action: "update_qty", itemTitle: ITEM_TITLE, quantity: 5 },
      CTX,
    )

    // The handler's copy, NOT the validator's — proof the validator arm did not fire.
    expect(result.message).toBe(`Prazo para alterar "${ITEM_TITLE}" já passou. ${CLAIM}.`)
    expect(result.message).not.toBe(VALIDATOR_PONR_COPY)
    expect(handoffSubjects()).toHaveLength(1)
  })
})
