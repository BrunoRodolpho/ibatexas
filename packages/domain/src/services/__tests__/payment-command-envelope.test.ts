// PaymentCommandService — envelope-typed entry-point tests.
//
// Task 15 (M3): verifies the new `*FromEnvelope` surface added alongside
// the legacy bare-arg methods (Decision D8). Coverage parallels
// order-command-envelope.test.ts.
//
// Highlights:
//   - createFromEnvelope: SYSTEM-only — REFUSE on UNTRUSTED.
//   - transitionStatusFromEnvelope: terminal-state guard prevents
//     resurrection.
//   - reconcileFromWebhookFromEnvelope: idempotency + stale-event
//     semantics preserved inside the executor; kernel adds uniform audit.
//   - Audit emit best-effort.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope, type AuditSink } from "@adjudicate/core"
import { randomUUID } from "node:crypto"

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockPaymentCreate = vi.hoisted(() => vi.fn())
const mockPaymentFindUnique = vi.hoisted(() => vi.fn())
const mockPaymentFindFirst = vi.hoisted(() => vi.fn())
const mockPaymentUpdate = vi.hoisted(() => vi.fn())
const mockHistoryCreate = vi.hoisted(() => vi.fn())
const mockOrderProjectionUpdate = vi.hoisted(() => vi.fn())

const txClient = {
  payment: {
    create: mockPaymentCreate,
    findUnique: mockPaymentFindUnique,
    findFirst: mockPaymentFindFirst,
    update: mockPaymentUpdate,
  },
  paymentStatusHistory: { create: mockHistoryCreate },
  orderProjection: { update: mockOrderProjectionUpdate },
}

vi.mock("../../client.js", () => ({
  prisma: {
    $transaction: vi.fn((fn: (tx: typeof txClient) => Promise<unknown>) =>
      fn(txClient),
    ),
    payment: {
      create: mockPaymentCreate,
      findUnique: mockPaymentFindUnique,
      findFirst: mockPaymentFindFirst,
      update: mockPaymentUpdate,
    },
    paymentStatusHistory: { create: mockHistoryCreate },
    orderProjection: { update: mockOrderProjectionUpdate },
  },
}))

// ── Import after mocks ────────────────────────────────────────────────────

import {
  createPaymentCommandService,
} from "../payment-command.service.js"
import type {
  PaymentCreatePayload,
  PaymentStatusTransitionPayload,
  PaymentStatusReconcilePayload,
} from "../__shared__/payment-projection-policy.js"

// ── Helpers ───────────────────────────────────────────────────────────────

function makePaymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_01",
    orderId: "order_01",
    method: "pix",
    status: "awaiting_payment",
    version: 1,
    amountInCentavos: 8900,
    lastStripeEventTs: null,
    ...overrides,
  }
}

function systemActor() {
  return {
    principal: "system" as const,
    sessionId: "system:test-suite",
  }
}

function llmActor() {
  return {
    principal: "llm" as const,
    sessionId: "llm:test-suite",
  }
}

function makeAuditSink(): AuditSink & { emit: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn().mockResolvedValue(undefined),
  } as never
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("PaymentCommandService — envelope-typed entry points", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── createFromEnvelope ────────────────────────────────────────────────

  describe("createFromEnvelope", () => {
    it("EXECUTE: creates payment + initial history + updates orderProjection.currentPaymentId", async () => {
      const sink = makeAuditSink()
      const svc = createPaymentCommandService(undefined, { auditSink: sink })
      mockPaymentFindFirst.mockResolvedValue(null) // no active payment
      mockPaymentCreate.mockResolvedValue({ id: "pay_01", version: 1 })
      mockHistoryCreate.mockResolvedValue({})
      mockOrderProjectionUpdate.mockResolvedValue({})

      const payload: PaymentCreatePayload = {
        orderId: "order_01",
        method: "pix",
        amountInCentavos: 8900,
        idempotencyKey: "idk_01",
      }
      const envelope = buildEnvelope({
        kind: "payment.create" as const,
        payload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "SYSTEM",
      })

      const outcome = await svc.createFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toEqual({ id: "pay_01", version: 1 })
      // Idempotency key plumbed through.
      expect(mockPaymentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ idempotencyKey: "idk_01" }),
        }),
      )
      await new Promise((r) => setImmediate(r))
      expect(sink.emit).toHaveBeenCalledOnce()
    })

    it("REFUSE: UNTRUSTED taint blocks SYSTEM-only create", async () => {
      const svc = createPaymentCommandService()
      const untrustedPayload: PaymentCreatePayload = {
        orderId: "order_01",
        method: "pix",
        amountInCentavos: 8900,
      }
      const envelope = buildEnvelope({
        kind: "payment.create" as const,
        payload: untrustedPayload,
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.createFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      expect(mockPaymentCreate).not.toHaveBeenCalled()
    })
  })

  // ── transitionStatusFromEnvelope ──────────────────────────────────────

  describe("transitionStatusFromEnvelope", () => {
    it("EXECUTE: pix awaiting_payment → payment_pending, version bumped", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(makePaymentRow())
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const payload: PaymentStatusTransitionPayload = {
        paymentId: "pay_01",
        newStatus: "payment_pending",
        actor: "admin",
      }
      const envelope = buildEnvelope({
        kind: "payment.status.transition" as const,
        payload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "TRUSTED",
      })

      const outcome = await svc.transitionStatusFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toEqual({
        version: 2,
        previousStatus: "awaiting_payment",
        newStatus: "payment_pending",
      })
      expect(mockPaymentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: 2 }),
        }),
      )
    })

    it("REFUSE: terminal payment cannot transition", async () => {
      const svc = createPaymentCommandService()
      // refunded is a terminal status — kernel state guard refuses.
      mockPaymentFindUnique.mockResolvedValue(
        makePaymentRow({ status: "refunded" }),
      )

      const terminalPayload: PaymentStatusTransitionPayload = {
        paymentId: "pay_01",
        newStatus: "paid",
        actor: "admin",
      }
      const envelope = buildEnvelope({
        kind: "payment.status.transition" as const,
        payload: terminalPayload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "TRUSTED",
      })

      const outcome = await svc.transitionStatusFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      if (outcome.decision.kind === "REFUSE") {
        expect(outcome.decision.refusal.code).toBe("payment.terminal_state")
      }
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })

    it("REFUSE: missing payment returns 'payment.not_found'", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(null)

      const missingPaymentPayload: PaymentStatusTransitionPayload = {
        paymentId: "missing",
        newStatus: "captured",
        actor: "admin",
      }
      const envelope = buildEnvelope({
        kind: "payment.status.transition" as const,
        payload: missingPaymentPayload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "TRUSTED",
      })

      const outcome = await svc.transitionStatusFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      if (outcome.decision.kind === "REFUSE") {
        expect(outcome.decision.refusal.code).toBe("payment.not_found")
      }
    })
  })

  // ── reconcileFromWebhookFromEnvelope ──────────────────────────────────

  describe("reconcileFromWebhookFromEnvelope", () => {
    it("EXECUTE: applies the new status from a webhook event (version bumped)", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique
        // State snapshot
        .mockResolvedValueOnce(makePaymentRow({ status: "payment_pending" }))
        // Executor's own fetch
        .mockResolvedValueOnce(makePaymentRow({ status: "payment_pending" }))
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const payload: PaymentStatusReconcilePayload = {
        paymentId: "pay_01",
        newStatus: "paid",
        stripeEventId: "evt_test_01",
      }
      const envelope = buildEnvelope({
        kind: "payment.status.reconcile" as const,
        payload,
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "SYSTEM",
      })

      const outcome = await svc.reconcileFromWebhookFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toEqual({ version: 2 })
      expect(mockPaymentUpdate).toHaveBeenCalledOnce()
    })

    it("REFUSE: UNTRUSTED taint blocks the SYSTEM-only reconcile", async () => {
      const svc = createPaymentCommandService()
      const envelope = buildEnvelope({
        kind: "payment.status.reconcile" as const,
        payload: {
          paymentId: "pay_01",
          newStatus: "captured",
          stripeEventId: "evt_test_01",
        },
        nonce: randomUUID(),
        actor: llmActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.reconcileFromWebhookFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
    })

    it("EXECUTE (no-op): terminal payment — executor returns null without write", async () => {
      const svc = createPaymentCommandService()
      // Snapshot says terminal — but the kernel state guard runs only when
      // the kind is `payment.status.transition`. The reconcile path runs
      // EXECUTE and the executor's own terminal-state check kicks in.
      mockPaymentFindUnique
        .mockResolvedValueOnce(makePaymentRow({ status: "refunded" })) // snapshot
        .mockResolvedValueOnce(makePaymentRow({ status: "refunded" })) // executor

      const envelope = buildEnvelope({
        kind: "payment.status.reconcile" as const,
        payload: {
          paymentId: "pay_01",
          newStatus: "paid",
          stripeEventId: "evt_test_02",
        },
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "SYSTEM",
      })

      const outcome = await svc.reconcileFromWebhookFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      // Executor returns null for terminal payments per legacy semantics.
      expect(outcome.result).toBeNull()
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })
  })

  // ── Idempotency ───────────────────────────────────────────────────────

  describe("Idempotency: nonce stability", () => {
    it("same nonce + payload → same intentHash (ledger-dedup-ready)", () => {
      const payload: PaymentCreatePayload = {
        orderId: "order_01",
        method: "pix",
        amountInCentavos: 8900,
      }
      const nonce = randomUUID()
      const env1 = buildEnvelope({
        kind: "payment.create" as const,
        payload,
        nonce,
        actor: systemActor(),
        taint: "SYSTEM",
      })
      const env2 = buildEnvelope({
        kind: "payment.create" as const,
        payload,
        nonce,
        actor: systemActor(),
        taint: "SYSTEM",
      })
      expect(env1.intentHash).toBe(env2.intentHash)
    })
  })
})
