// Tests for PaymentCommandService — envelope-typed surface only.
//
// R1-DELETE (W1 correctness remediation): the bare-arg @deprecated
// methods (`create`, `transitionStatus`, `reconcileFromWebhook`) were
// removed from the interface. Coverage shifted to the envelope-typed
// methods which internally invoke the same executors.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"

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

function buildCreateEnvelope(payload: {
  orderId: string;
  method: "pix" | "card" | "cash";
  amountInCentavos: number;
  stripePaymentIntentId?: string;
  pixExpiresAt?: string;
  idempotencyKey?: string;
}) {
  return buildEnvelope<
    "payment.create",
    {
      orderId: string;
      method: "pix" | "card" | "cash";
      amountInCentavos: number;
      stripePaymentIntentId?: string;
      pixExpiresAt?: string;
      idempotencyKey?: string;
    }
  >({
    kind: "payment.create",
    payload,
    nonce: "n-test",
    actor: { principal: "system", sessionId: "test" },
    taint: "SYSTEM",
  })
}

function buildTransitionEnvelope(paymentId: string, payload: {
  newStatus: string;
  actor: "admin" | "system" | "customer";
  actorId?: string;
  reason?: string;
  expectedVersion?: number;
}) {
  return buildEnvelope<
    "payment.status.transition",
    {
      paymentId: string;
      newStatus: string;
      actor: "admin" | "system" | "customer";
      actorId?: string;
      reason?: string;
      expectedVersion?: number;
    }
  >({
    kind: "payment.status.transition",
    payload: { paymentId, ...payload },
    nonce: "n-test",
    actor: { principal: payload.actor === "customer" ? "user" : "system", sessionId: payload.actorId ?? "test" },
    taint: "TRUSTED",
  })
}

function buildReconcileEnvelope(paymentId: string, payload: {
  newStatus: string;
  stripeEventId: string;
  stripeEventTimestamp?: string;
  expectedOrderId?: string;
}) {
  return buildEnvelope<
    "payment.status.reconcile",
    {
      paymentId: string;
      newStatus: string;
      stripeEventId: string;
      stripeEventTimestamp?: string;
      expectedOrderId?: string;
    }
  >({
    kind: "payment.status.reconcile",
    payload: { paymentId, ...payload },
    nonce: "n-test",
    actor: { principal: "system", sessionId: "webhook-test" },
    taint: "SYSTEM",
  })
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PaymentCommandService — R1-DELETE envelope-typed surface", () => {
  let svc: ReturnType<typeof createPaymentCommandService>

  beforeEach(() => {
    vi.clearAllMocks()
    svc = createPaymentCommandService()
  })

  describe("createFromEnvelope", () => {
    it("creates pix payment with awaiting_payment status, returns id + version 1", async () => {
      mockPaymentFindFirst.mockResolvedValue(null)
      mockPaymentCreate.mockResolvedValue({ id: "pay_01", version: 1 })
      mockHistoryCreate.mockResolvedValue({})
      mockProjectionUpdate.mockResolvedValue({})

      const envelope = buildCreateEnvelope({ orderId: "order_01", method: "pix", amountInCentavos: 8900, stripePaymentIntentId: "pi_test_123" })
      const out = await svc.createFromEnvelope(envelope)

      expect(["EXECUTE", "REWRITE"]).toContain(out.decision.kind)
      expect(out.result).toEqual({ id: "pay_01", version: 1 })
      expect(mockPaymentCreate).toHaveBeenCalledOnce()
      const createCall = mockPaymentCreate.mock.calls[0]![0] as { data: Record<string, unknown> }
      expect(createCall.data.status).toBe("awaiting_payment")
      expect(createCall.data.method).toBe("pix")
      expect(createCall.data.orderId).toBe("order_01")
      expect(createCall.data.amountInCentavos).toBe(8900)
      expect(createCall.data.version).toBe(1)
    })

    it("creates cash payment with cash_pending initial status", async () => {
      mockPaymentFindFirst.mockResolvedValue(null)
      mockPaymentCreate.mockResolvedValue({ id: "pay_02", version: 1 })
      mockHistoryCreate.mockResolvedValue({})
      mockProjectionUpdate.mockResolvedValue({})

      const envelope = buildCreateEnvelope({ orderId: "order_01", method: "cash", amountInCentavos: 8900 })
      await svc.createFromEnvelope(envelope)

      const createCall = mockPaymentCreate.mock.calls[0]![0] as { data: Record<string, unknown> }
      expect(createCall.data.status).toBe("cash_pending")
    })

    it("updates OrderProjection.currentPaymentId", async () => {
      mockPaymentFindFirst.mockResolvedValue(null)
      mockPaymentCreate.mockResolvedValue({ id: "pay_01", version: 1 })
      mockHistoryCreate.mockResolvedValue({})
      mockProjectionUpdate.mockResolvedValue({})

      const envelope = buildCreateEnvelope({ orderId: "order_01", method: "pix", amountInCentavos: 8900 })
      await svc.createFromEnvelope(envelope)

      expect(mockProjectionUpdate).toHaveBeenCalledOnce()
      const updateCall = mockProjectionUpdate.mock.calls[0]![0] as { where: { id: string }; data: { currentPaymentId: string } }
      expect(updateCall.where.id).toBe("order_01")
      expect(updateCall.data.currentPaymentId).toBe("pay_01")
    })

    it("throws ActivePaymentExistsError if order already has non-terminal payment", async () => {
      mockPaymentFindFirst.mockResolvedValue({ id: "pay_existing" })

      const envelope = buildCreateEnvelope({ orderId: "order_01", method: "pix", amountInCentavos: 8900 })
      await expect(svc.createFromEnvelope(envelope)).rejects.toThrow(ActivePaymentExistsError)
      expect(mockPaymentCreate).not.toHaveBeenCalled()
    })
  })

  describe("transitionStatusFromEnvelope", () => {
    it("valid transition — bumps version and records history", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ status: "awaiting_payment", version: 1 }))
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildTransitionEnvelope("pay_01", {
        newStatus: "payment_pending",
        actor: "system",
        reason: "stripe_pi_created",
        expectedVersion: 1,
      })
      const out = await svc.transitionStatusFromEnvelope(envelope)

      expect(["EXECUTE", "REWRITE"]).toContain(out.decision.kind)
      expect(out.result).toEqual({ version: 2, previousStatus: "awaiting_payment", newStatus: "payment_pending" })
    })

    it("throws InvalidPaymentTransitionError for disallowed transition", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ status: "awaiting_payment" }))

      const envelope = buildTransitionEnvelope("pay_01", {
        newStatus: "paid",
        actor: "system",
        expectedVersion: 1,
      })
      await expect(svc.transitionStatusFromEnvelope(envelope)).rejects.toThrow(InvalidPaymentTransitionError)
    })

    it("throws PaymentConcurrencyError on version mismatch", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ version: 3 }))

      const envelope = buildTransitionEnvelope("pay_01", {
        newStatus: "payment_pending",
        actor: "system",
        expectedVersion: 1,
      })
      await expect(svc.transitionStatusFromEnvelope(envelope)).rejects.toThrow(PaymentConcurrencyError)
    })

    it("throws PaymentNotFoundError when payment missing", async () => {
      mockPaymentFindUnique.mockResolvedValue(null)

      const envelope = buildTransitionEnvelope("pay_nonexistent", {
        newStatus: "payment_pending",
        actor: "system",
      })
      await expect(svc.transitionStatusFromEnvelope(envelope)).rejects.toThrow(PaymentNotFoundError)
    })

    it("skips concurrency check when expectedVersion is undefined", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ status: "awaiting_payment", version: 5 }))
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildTransitionEnvelope("pay_01", {
        newStatus: "payment_pending",
        actor: "system",
      })
      const out = await svc.transitionStatusFromEnvelope(envelope)

      expect(out.result?.version).toBe(6)
    })

    it("records actorId when provided", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ status: "cash_pending" }))
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildTransitionEnvelope("pay_01", {
        newStatus: "paid",
        actor: "admin",
        actorId: "staff_01",
        reason: "cash_confirmed",
      })
      await svc.transitionStatusFromEnvelope(envelope)

      const historyCall = mockHistoryCreate.mock.calls[0]![0] as { data: { actorId: string } }
      expect(historyCall.data.actorId).toBe("staff_01")
    })
  })

  describe("reconcileFromWebhookFromEnvelope", () => {
    it("returns null when payment not found", async () => {
      mockPaymentFindUnique.mockResolvedValue(null)

      const envelope = buildReconcileEnvelope("pay_missing", { newStatus: "paid", stripeEventId: "evt_123" })
      const out = await svc.reconcileFromWebhookFromEnvelope(envelope)
      expect(out.result).toBeNull()
    })

    it("returns null when payment is terminal (no resurrection)", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ status: "canceled" }))

      const envelope = buildReconcileEnvelope("pay_01", { newStatus: "paid", stripeEventId: "evt_123" })
      const out = await svc.reconcileFromWebhookFromEnvelope(envelope)
      expect(out.result).toBeNull()
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })

    it("returns null when payment is in switching_method state", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ status: "switching_method" }))

      const envelope = buildReconcileEnvelope("pay_01", { newStatus: "paid", stripeEventId: "evt_123" })
      const out = await svc.reconcileFromWebhookFromEnvelope(envelope)
      expect(out.result).toBeNull()
    })

    it("returns null for out-of-order events (older timestamp)", async () => {
      mockPaymentFindUnique.mockResolvedValue(
        makePayment({ status: "payment_pending", lastStripeEventTs: new Date("2026-04-12T11:00:00Z") }),
      )

      const envelope = buildReconcileEnvelope("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_old",
        stripeEventTimestamp: "2026-04-12T10:00:00Z",
      })
      const out = await svc.reconcileFromWebhookFromEnvelope(envelope)
      expect(out.result).toBeNull()
    })

    it("returns null when expectedOrderId doesn't match", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ orderId: "order_01" }))

      const envelope = buildReconcileEnvelope("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_123",
        expectedOrderId: "order_WRONG",
      })
      const out = await svc.reconcileFromWebhookFromEnvelope(envelope)
      expect(out.result).toBeNull()
    })

    it("returns null when already at target status", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ status: "paid" }))

      const envelope = buildReconcileEnvelope("pay_01", { newStatus: "paid", stripeEventId: "evt_123" })
      const out = await svc.reconcileFromWebhookFromEnvelope(envelope)
      expect(out.result).toBeNull()
    })

    it("returns null for invalid transition (reordered events)", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ status: "awaiting_payment" }))

      const envelope = buildReconcileEnvelope("pay_01", { newStatus: "paid", stripeEventId: "evt_123" })
      const out = await svc.reconcileFromWebhookFromEnvelope(envelope)
      expect(out.result).toBeNull()
    })

    it("valid reconciliation — updates payment and records history", async () => {
      mockPaymentFindUnique.mockResolvedValue(makePayment({ status: "payment_pending", version: 2 }))
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildReconcileEnvelope("pay_01", {
        newStatus: "paid",
        stripeEventId: "evt_succeeded_123",
        stripeEventTimestamp: "2026-04-12T12:00:00Z",
        expectedOrderId: "order_01",
      })
      const out = await svc.reconcileFromWebhookFromEnvelope(envelope)
      expect(out.result).toEqual({ version: 3 })
    })
  })

  describe("findActiveByOrderId", () => {
    it("returns active payment when one exists", async () => {
      mockPaymentFindFirst.mockResolvedValue({ id: "pay_01", status: "payment_pending", version: 2 })

      const result = await svc.findActiveByOrderId("order_01")
      expect(result).toEqual({ id: "pay_01", status: "payment_pending", version: 2 })
    })

    it("returns null when no active payment exists", async () => {
      mockPaymentFindFirst.mockResolvedValue(null)
      const result = await svc.findActiveByOrderId("order_01")
      expect(result).toBeNull()
    })
  })
})
