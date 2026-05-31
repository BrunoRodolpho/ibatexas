// Tests for PaymentCommandService
// Mock-based; no DB required.
//
// Scenarios:
// - create: happy path (pix → awaiting_payment, cash → cash_pending)
// - create: duplicate active payment → throws ActivePaymentExistsError
// - create: updates OrderProjection.currentPaymentId
// - transitionStatus: valid transition — version bumped, history recorded
// - transitionStatus: invalid transition — throws InvalidPaymentTransitionError
// - transitionStatus: version mismatch — throws PaymentConcurrencyError
// - transitionStatus: missing payment — throws PaymentNotFoundError
// - transitionStatus: no expectedVersion — skips concurrency check
// - reconcileFromWebhook: payment not found → null
// - reconcileFromWebhook: terminal state → null
// - reconcileFromWebhook: switching_method → null
// - reconcileFromWebhook: out-of-order event → null
// - reconcileFromWebhook: order ID mismatch → null
// - reconcileFromWebhook: already at target status → null
// - reconcileFromWebhook: invalid transition → null
// - reconcileFromWebhook: valid reconciliation — updates payment + history
// - findActiveByOrderId: returns active payment
// - findActiveByOrderId: no active payment → null

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockPaymentCreate = vi.hoisted(() => vi.fn())
const mockPaymentFindUnique = vi.hoisted(() => vi.fn())
const mockPaymentFindFirst = vi.hoisted(() => vi.fn())
const mockPaymentUpdate = vi.hoisted(() => vi.fn())
const mockHistoryCreate = vi.hoisted(() => vi.fn())
const mockProjectionUpdate = vi.hoisted(() => vi.fn())

const txClient = {
  payment: {
    create: mockPaymentCreate,
    findUnique: mockPaymentFindUnique,
    findFirst: mockPaymentFindFirst,
    update: mockPaymentUpdate,
  },
  paymentStatusHistory: { create: mockHistoryCreate },
  orderProjection: { update: mockProjectionUpdate },
}

vi.mock("../client.js", () => ({
  prisma: {
    $transaction: vi.fn((fn: (tx: typeof txClient) => Promise<unknown>) => fn(txClient)),
    payment: {
      create: mockPaymentCreate,
      findUnique: mockPaymentFindUnique,
      findFirst: mockPaymentFindFirst,
      update: mockPaymentUpdate,
    },
    paymentStatusHistory: { create: mockHistoryCreate },
    orderProjection: { update: mockProjectionUpdate },
  },
}))

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  createPaymentCommandService,
  PaymentConcurrencyError,
  PaymentNotFoundError,
  InvalidPaymentTransitionError,
  ActivePaymentExistsError,
} from "../services/payment-command.service.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_01",
    orderId: "order_01",
    method: "pix",
    status: "awaiting_payment",
    amountInCentavos: 8900,
    stripePaymentIntentId: "pi_test_123",
    pixExpiresAt: null,
    regenerationCount: 0,
    idempotencyKey: null,
    version: 1,
    lastStripeEventTs: null,
    createdAt: new Date("2026-04-12T10:00:00Z"),
    updatedAt: new Date("2026-04-12T10:00:00Z"),
    ...overrides,
  }
}

function makeCreateInput(overrides: Partial<{
  orderId: string
  method: "pix" | "card" | "cash"
  amountInCentavos: number
  stripePaymentIntentId?: string
  pixExpiresAt?: Date
  idempotencyKey?: string
}> = {}) {
  return {
    orderId: "order_01",
    method: "pix" as const,
    amountInCentavos: 8900,
    stripePaymentIntentId: "pi_test_123",
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PaymentCommandService", () => {
  let svc: ReturnType<typeof createPaymentCommandService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createPaymentCommandService()
  })

  // ── create ──────────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates pix payment with awaiting_payment status, returns id + version 1", async () => {
      const input = makeCreateInput()
      mockPaymentFindFirst.mockResolvedValue(null) // no existing active payment
      mockPaymentCreate.mockResolvedValue({ id: "pay_01", version: 1 })
      mockHistoryCreate.mockResolvedValue({})
      mockProjectionUpdate.mockResolvedValue({})

      const result = await svc.create(input)

      expect(result).toEqual({ id: "pay_01", version: 1 })
      expect(mockPaymentCreate).toHaveBeenCalledOnce()

      const createCall = mockPaymentCreate.mock.calls[0][0]
      expect(createCall.data.status).toBe("awaiting_payment")
      expect(createCall.data.method).toBe("pix")
      expect(createCall.data.orderId).toBe("order_01")
      expect(createCall.data.amountInCentavos).toBe(8900)
      expect(createCall.data.version).toBe(1)
    })

    it("creates cash payment with cash_pending initial status", async () => {
      const input = makeCreateInput({ method: "cash" })
      mockPaymentFindFirst.mockResolvedValue(null)
      mockPaymentCreate.mockResolvedValue({ id: "pay_02", version: 1 })
      mockHistoryCreate.mockResolvedValue({})
      mockProjectionUpdate.mockResolvedValue({})

      await svc.create(input)

      const createCall = mockPaymentCreate.mock.calls[0][0]
      expect(createCall.data.status).toBe("cash_pending")
    })

    it("records initial status in history with same from/to", async () => {
      const input = makeCreateInput()
      mockPaymentFindFirst.mockResolvedValue(null)
      mockPaymentCreate.mockResolvedValue({ id: "pay_01", version: 1 })
      mockHistoryCreate.mockResolvedValue({})
      mockProjectionUpdate.mockResolvedValue({})

      await svc.create(input)

      expect(mockHistoryCreate).toHaveBeenCalledOnce()
      const historyCall = mockHistoryCreate.mock.calls[0][0]
      expect(historyCall.data.fromStatus).toBe("awaiting_payment")
      expect(historyCall.data.toStatus).toBe("awaiting_payment")
      expect(historyCall.data.actor).toBe("system")
      expect(historyCall.data.version).toBe(1)
    })

    it("updates OrderProjection.currentPaymentId", async () => {
      mockPaymentFindFirst.mockResolvedValue(null)
      mockPaymentCreate.mockResolvedValue({ id: "pay_01", version: 1 })
      mockHistoryCreate.mockResolvedValue({})
      mockProjectionUpdate.mockResolvedValue({})

      await svc.create(makeCreateInput())

      expect(mockProjectionUpdate).toHaveBeenCalledOnce()
      const updateCall = mockProjectionUpdate.mock.calls[0][0]
      expect(updateCall.where.id).toBe("order_01")
      expect(updateCall.data.currentPaymentId).toBe("pay_01")
    })

    it("throws ActivePaymentExistsError if order already has non-terminal payment", async () => {
      mockPaymentFindFirst.mockResolvedValue({ id: "pay_existing" }) // active payment exists

      await expect(svc.create(makeCreateInput())).rejects.toThrow(ActivePaymentExistsError)
      expect(mockPaymentCreate).not.toHaveBeenCalled()
    })

    // ── DB backstop: partial unique index race (P1-CONC-ACTIVEPAY) ──────────
    //
    // The findFirst-then-create fast path cannot prevent two concurrent creates
    // from both passing the "no active payment" check under Read-Committed.
    // The partial unique index `payment_active_per_order` is the authoritative
    // backstop: the losing insert raises Prisma P2002. The service must catch
    // it and surface ActivePaymentExistsError rather than leaking a raw 500.
    //
    // NOTE: the index race itself requires a live Postgres and cannot be
    // exercised in this mock-based suite; here we assert ONLY that a P2002
    // raised by `create` is translated into the clean domain error and that the
    // winning active payment is re-read.
    it("translates P2002 from the active-payment index into ActivePaymentExistsError", async () => {
      // 1st findFirst (fast-path guard): no active payment seen → proceeds.
      // 2nd findFirst (catch-path re-read): the row the racing tx won.
      mockPaymentFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "pay_winner", status: "awaiting_payment", version: 1 })
      mockPaymentCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
          meta: { target: "payment_active_per_order" },
        }),
      )

      await expect(svc.create(makeCreateInput())).rejects.toThrow(ActivePaymentExistsError)

      // create was attempted (fast path passed) but the DB rejected the duplicate.
      expect(mockPaymentCreate).toHaveBeenCalledOnce()
      // catch path re-read the active payment (two findFirst calls total).
      expect(mockPaymentFindFirst).toHaveBeenCalledTimes(2)
    })

    it("re-throws a P2002 from a DIFFERENT unique index (e.g. idempotency_key) unchanged", async () => {
      mockPaymentFindFirst.mockResolvedValue(null)
      mockPaymentCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed on idempotency_key"), {
          code: "P2002",
          meta: { target: ["idempotency_key"] },
        }),
      )

      // Not the active-payment index → must NOT be relabeled as ActivePaymentExists.
      await expect(svc.create(makeCreateInput({ idempotencyKey: "dup-key" }))).rejects.toThrow(
        "Unique constraint failed on idempotency_key",
      )
      await expect(svc.create(makeCreateInput({ idempotencyKey: "dup-key" }))).rejects.not.toBeInstanceOf(
        ActivePaymentExistsError,
      )
    })
  })

  // ── transitionStatus ──────────────────────────────────────────────────

  describe("transitionStatus", () => {
    it("valid transition — bumps version and records history", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "awaiting_payment", version: 1 }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.transitionStatus("pay_01", {
        newStatus: "payment_pending",
        actor: "system",
        reason: "stripe_pi_created",
        expectedVersion: 1,
      })

      expect(result).toEqual({
        version: 2,
        previousStatus: "awaiting_payment",
        newStatus: "payment_pending",
      })

      // Payment updated with new status + version
      const updateCall = mockPaymentUpdate.mock.calls[0][0]
      expect(updateCall.data.status).toBe("payment_pending")
      expect(updateCall.data.version).toBe(2)

      // History recorded
      const historyCall = mockHistoryCreate.mock.calls[0][0]
      expect(historyCall.data.fromStatus).toBe("awaiting_payment")
      expect(historyCall.data.toStatus).toBe("payment_pending")
      expect(historyCall.data.actor).toBe("system")
      expect(historyCall.data.reason).toBe("stripe_pi_created")
      expect(historyCall.data.version).toBe(2)
    })

    it("throws InvalidPaymentTransitionError for disallowed transition", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "awaiting_payment" }),
      )

      // awaiting_payment → paid is not a valid transition (must go through payment_pending)
      await expect(
        svc.transitionStatus("pay_01", {
          newStatus: "paid",
          actor: "system",
          expectedVersion: 1,
        }),
      ).rejects.toThrow(InvalidPaymentTransitionError)
    })

    it("throws PaymentConcurrencyError on version mismatch", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ version: 3 }),
      )

      await expect(
        svc.transitionStatus("pay_01", {
          newStatus: "payment_pending",
          actor: "system",
          expectedVersion: 1, // stale
        }),
      ).rejects.toThrow(PaymentConcurrencyError)
    })

    it("throws PaymentNotFoundError when payment missing", async () => {
      mockPaymentFindUnique.mockResolvedValue(null)

      await expect(
        svc.transitionStatus("pay_nonexistent", {
          newStatus: "payment_pending",
          actor: "system",
        }),
      ).rejects.toThrow(PaymentNotFoundError)
    })

    it("skips concurrency check when expectedVersion is undefined", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "awaiting_payment", version: 5 }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      // No expectedVersion — should succeed regardless of current version
      const result = await svc.transitionStatus("pay_01", {
        newStatus: "payment_pending",
        actor: "system",
      })

      expect(result.version).toBe(6)
    })

    it("records actorId when provided", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "cash_pending" }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      await svc.transitionStatus("pay_01", {
        newStatus: "paid",
        actor: "admin",
        actorId: "staff_01",
        reason: "cash_confirmed",
      })

      const historyCall = mockHistoryCreate.mock.calls[0][0]
      expect(historyCall.data.actorId).toBe("staff_01")
    })

    // ── REFUNDSPLIT: status + refunded-amount single atomic write ───────────
    //
    // The refund path (admin/payments.ts doRefund) used to bump
    // refundedAmountCentavos in a SEPARATE prisma.payment.update before calling
    // transitionStatus — two writes with a fail-safe ordering but a real
    // partial-failure window. transitionStatus now accepts the refunded amount
    // and writes it INSIDE its existing $transaction, so status + version +
    // refundedAmountCentavos land in ONE atomic write (the window is gone;
    // P0-PAY-5's bump-before-flip safety is subsumed by atomicity).
    it("writes refundedAmountCentavos inside the same transaction when provided (REFUNDSPLIT atomicity)", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "paid", version: 4 }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.transitionStatus("pay_01", {
        newStatus: "refunded",
        actor: "admin",
        actorId: "staff_01",
        reason: "Reembolso emitido pelo admin",
        refundedAmountCentavos: 8900,
      })

      expect(result.newStatus).toBe("refunded")

      // ONE update carries status + version + refundedAmountCentavos.
      expect(mockPaymentUpdate).toHaveBeenCalledOnce()
      const updateCall = mockPaymentUpdate.mock.calls[0][0]
      expect(updateCall.data.status).toBe("refunded")
      expect(updateCall.data.version).toBe(5)
      expect(updateCall.data.refundedAmountCentavos).toBe(8900)
    })

    it("omits refundedAmountCentavos from the update when not provided (byte-equivalent for non-refund transitions)", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "payment_pending", version: 1 }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      await svc.transitionStatus("pay_01", {
        newStatus: "paid",
        actor: "system",
      })

      // Non-refund transitions must not touch refundedAmountCentavos at all
      // (an explicit `undefined` key would still be a behavioral change).
      const updateCall = mockPaymentUpdate.mock.calls[0][0]
      expect(updateCall.data).not.toHaveProperty("refundedAmountCentavos")
    })
  })

  // ── reconcileFromWebhook ──────────────────────────────────────────────

  describe("reconcileFromWebhook", () => {
    it("returns null when payment not found", async () => {
      mockPaymentFindUnique.mockResolvedValue(null)

      const result = await svc.reconcileFromWebhook("pay_missing", {
        newStatus: "paid",
        stripeEventId: "evt_123",
      })

      expect(result).toBeNull()
    })

    it("returns null when payment is terminal (no resurrection)", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "canceled" }),
      )

      const result = await svc.reconcileFromWebhook("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_123",
      })

      expect(result).toBeNull()
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })

    it("returns null when payment is in switching_method state", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "switching_method" }),
      )

      const result = await svc.reconcileFromWebhook("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_123",
      })

      expect(result).toBeNull()
    })

    it("returns null for out-of-order events (older timestamp)", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({
          status: "payment_pending",
          lastStripeEventTs: new Date("2026-04-12T11:00:00Z"),
        }),
      )

      const result = await svc.reconcileFromWebhook("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_old",
        stripeEventTimestamp: new Date("2026-04-12T10:00:00Z"), // earlier than last
      })

      expect(result).toBeNull()
    })

    it("returns null when expectedOrderId doesn't match", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ orderId: "order_01" }),
      )

      const result = await svc.reconcileFromWebhook("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_123",
        expectedOrderId: "order_WRONG",
      })

      expect(result).toBeNull()
    })

    it("returns null when already at target status", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "paid" }),
      )

      const result = await svc.reconcileFromWebhook("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_123",
      })

      expect(result).toBeNull()
    })

    it("returns null for invalid transition (reordered events)", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "awaiting_payment" }),
      )

      // awaiting_payment → paid is not valid (must go through payment_pending)
      const result = await svc.reconcileFromWebhook("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_123",
      })

      expect(result).toBeNull()
    })

    it("valid reconciliation — updates payment and records history", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "payment_pending", version: 2 }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.reconcileFromWebhook("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_succeeded_123",
        stripeEventTimestamp: new Date("2026-04-12T12:00:00Z"),
        expectedOrderId: "order_01",
      })

      expect(result).toEqual({ version: 3 })

      // Payment updated
      const updateCall = mockPaymentUpdate.mock.calls[0][0]
      expect(updateCall.data.status).toBe("paid")
      expect(updateCall.data.version).toBe(3)
      expect(updateCall.data.lastStripeEventTs).toEqual(new Date("2026-04-12T12:00:00Z"))

      // History recorded with stripe event reference
      const historyCall = mockHistoryCreate.mock.calls[0][0]
      expect(historyCall.data.fromStatus).toBe("payment_pending")
      expect(historyCall.data.toStatus).toBe("paid")
      expect(historyCall.data.reason).toBe("stripe:evt_succeeded_123")
      expect(historyCall.data.actor).toBe("system")
    })

    it("processes event when no lastStripeEventTs and no stripeEventTimestamp", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "payment_pending", version: 1, lastStripeEventTs: null }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.reconcileFromWebhook("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_123",
        // no stripeEventTimestamp — skips out-of-order check
      })

      expect(result).toEqual({ version: 2 })
    })
  })

  // ── findActiveByOrderId ─────────────────────────────────────────────

  describe("findActiveByOrderId", () => {
    it("returns active payment when one exists", async () => {
      mockPaymentFindFirst.mockResolvedValue({
        id: "pay_01",
        status: "payment_pending",
        version: 2,
      })

      const result = await svc.findActiveByOrderId("order_01")

      expect(result).toEqual({
        id: "pay_01",
        status: "payment_pending",
        version: 2,
      })
    })

    it("returns null when no active payment exists", async () => {
      mockPaymentFindFirst.mockResolvedValue(null)

      const result = await svc.findActiveByOrderId("order_01")
      expect(result).toBeNull()
    })
  })
})
