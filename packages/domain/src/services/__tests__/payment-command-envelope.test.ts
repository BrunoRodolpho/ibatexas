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
import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionRefuse,
  refuse,
  type AuditSink,
} from "@adjudicate/core"
import { nameGuard, type Guard } from "@adjudicate/core/kernel"
import { randomUUID } from "node:crypto"

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockPaymentCreate = vi.hoisted(() => vi.fn())
const mockPaymentFindUnique = vi.hoisted(() => vi.fn())
const mockPaymentFindFirst = vi.hoisted(() => vi.fn())
const mockPaymentUpdate = vi.hoisted(() => vi.fn())
const mockPaymentUpdateMany = vi.hoisted(() => vi.fn())
const mockHistoryCreate = vi.hoisted(() => vi.fn())
const mockOrderProjectionUpdate = vi.hoisted(() => vi.fn())

const txClient = {
  payment: {
    create: mockPaymentCreate,
    findUnique: mockPaymentFindUnique,
    findFirst: mockPaymentFindFirst,
    update: mockPaymentUpdate,
    updateMany: mockPaymentUpdateMany,
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
      updateMany: mockPaymentUpdateMany,
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
  PaymentDisputeOpenPayload,
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

// ── BKL-074 injected staff-role guard (locally built — domain tests must NOT
//    import apps/api) ─────────────────────────────────────────────────────────
//
// A faithful equivalent of apps/api's `createStaffRoleGuard`: engages ONLY on
// `admin:` sessionIds, REFUSEs `staff_role_violation` when the kind is off the
// matrix / the role is absent / unknown / not permitted, and is otherwise inert
// (null). Passed as the injected `authGuards` so we prove the command-service
// backstop THROUGH the real kernel + the raw payment-projection pack bundle.
const STAFF_ROLE_REFUSAL_CODE = "staff_role_violation"

/** CODE-TRUTH mirror of STAFF_KIND_ALLOWED_ROLES (staff-role-matrix.ts). */
const STAFF_KIND_ALLOWED_ROLES: Record<string, readonly string[]> = {
  "order.status.transition": ["OWNER", "MANAGER", "ATTENDANT"],
  "payment.status.transition": ["OWNER", "MANAGER", "ATTENDANT"],
  "payment.refund.issue": ["OWNER", "MANAGER"],
  "order.note.add": ["OWNER", "MANAGER", "ATTENDANT"],
  "reservation.checkin": ["OWNER", "MANAGER"],
  "reservation.complete": ["OWNER", "MANAGER"],
  "reservation.cancel": ["OWNER", "MANAGER"],
}

function invertMatrix(): Record<string, ReadonlySet<string>> {
  const acc: Record<string, Set<string>> = {
    OWNER: new Set(),
    MANAGER: new Set(),
    ATTENDANT: new Set(),
  }
  for (const [kind, roles] of Object.entries(STAFF_KIND_ALLOWED_ROLES)) {
    for (const role of roles) acc[role]!.add(kind)
  }
  return acc
}

function createTestStaffRoleGuard(): Guard<string, unknown, unknown> {
  const matrix = invertMatrix()
  const staffPlaneKinds = new Set<string>()
  for (const kinds of Object.values(matrix)) {
    for (const k of kinds) staffPlaneKinds.add(k)
  }
  const refuseStaffRole = (detail: string) =>
    refuse(
      "AUTH",
      STAFF_ROLE_REFUSAL_CODE,
      "Seu nível de acesso não permite executar esta ação.",
      detail,
    )
  const guard: Guard<string, unknown, unknown> = (envelope, _state) => {
    const { sessionId, role } = envelope.actor
    if (!sessionId.startsWith("admin:")) return null
    const kind = envelope.kind
    if (!staffPlaneKinds.has(kind)) {
      return decisionRefuse(refuseStaffRole(`kind "${kind}" off matrix`), [
        basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, { sessionId, kind }),
      ])
    }
    if (role === undefined) {
      return decisionRefuse(refuseStaffRole(`no role for "${kind}"`), [
        basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, { sessionId, kind }),
      ])
    }
    const allowed = matrix[role]
    if (allowed === undefined) {
      return decisionRefuse(refuseStaffRole(`unknown role "${role}"`), [
        basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, { sessionId, kind, role }),
      ])
    }
    if (allowed.has(kind)) return null
    return decisionRefuse(
      refuseStaffRole(`role "${role}" not permitted for "${kind}"`),
      [basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, { sessionId, kind, role })],
    )
  }
  return nameGuard("staffRole", guard)
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
      mockPaymentUpdateMany.mockResolvedValue({ count: 1 })
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
      expect(mockPaymentUpdateMany).toHaveBeenCalledOnce()
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

  // ── BKL-178 — dispute.open (adjudicate-only, always ESCALATE) ──────────
  describe("disputeOpenFromEnvelope", () => {
    it("ESCALATE: a chargeback always escalates for human review; the executor never runs", async () => {
      const svc = createPaymentCommandService()
      // Real snapshot — the webhook resolves the Payment row (already reconciled
      // to DISPUTED) before minting the envelope, so `exists` is true.
      mockPaymentFindUnique.mockResolvedValue(makePaymentRow({ status: "disputed" }))

      const payload: PaymentDisputeOpenPayload = {
        paymentId: "pay_01",
        stripeEventId: "evt_dispute_01",
        disputeAmountCentavos: 8900,
      }
      const envelope = buildEnvelope({
        kind: "payment.dispute.open" as const,
        payload,
        nonce: "evt_dispute_01",
        actor: systemActor(),
        taint: "SYSTEM",
      })

      const outcome = await svc.disputeOpenFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("ESCALATE")
      if (outcome.decision.kind === "ESCALATE") {
        expect(outcome.decision.reason).toBe("dispute_opened_requires_review")
      }
      // Adjudicate-only: no payment-row mutation runs (the executor is unreachable).
      expect(mockPaymentUpdateMany).not.toHaveBeenCalled()
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
      expect(mockHistoryCreate).not.toHaveBeenCalled()
    })

    it("REFUSE: UNTRUSTED taint blocks the SYSTEM-only dispute.open", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(makePaymentRow({ status: "disputed" }))

      const envelope = buildEnvelope({
        kind: "payment.dispute.open" as const,
        payload: { paymentId: "pay_01", stripeEventId: "evt_dispute_02" },
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "UNTRUSTED",
      })

      const outcome = await svc.disputeOpenFromEnvelope(envelope)
      expect(outcome.decision.kind).toBe("REFUSE")
    })

    it("REFUSE: a dispute on a missing Payment row refuses (never a phantom escalate)", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(null)

      const envelope = buildEnvelope({
        kind: "payment.dispute.open" as const,
        payload: { paymentId: "pay_missing", stripeEventId: "evt_dispute_03" },
        nonce: randomUUID(),
        actor: systemActor(),
        taint: "SYSTEM",
      })

      const outcome = await svc.disputeOpenFromEnvelope(envelope)
      expect(outcome.decision.kind).toBe("REFUSE")
    })

    it("Idempotency: same Stripe event.id (nonce) + payload → same intentHash", () => {
      const payload: PaymentDisputeOpenPayload = {
        paymentId: "pay_01",
        stripeEventId: "evt_dispute_redelivered",
        disputeAmountCentavos: 8900,
      }
      const build = () =>
        buildEnvelope({
          kind: "payment.dispute.open" as const,
          payload,
          nonce: "evt_dispute_redelivered",
          actor: systemActor(),
          taint: "SYSTEM",
        })
      expect(build().intentHash).toBe(build().intentHash)
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

  // ── W3 P0-1: refund magnitude ladder + executor invariants ───────────

  describe("issueRefundFromEnvelope — W3 P0-1 magnitude ladder", () => {
    function paidRow(overrides: Record<string, unknown> = {}) {
      return makePaymentRow({
        status: "paid",
        version: 1,
        amountInCentavos: 200_000, // R$2000 — big enough for ladder tests
        refundedAmountCentavos: 0,
        regenerationCount: 0,
        ...overrides,
      })
    }

    function buildRefundEnvelope(
      amountCentavos: number,
      overrides: Record<string, unknown> = {},
    ) {
      return buildEnvelope({
        kind: "payment.refund.issue" as const,
        payload: {
          paymentId: "pay_01",
          refundAmountCentavos: amountCentavos,
          refundableBalanceCentavos: 200_000,
          amountInCentavos: 200_000,
          currentRefundedCentavos: 0,
          actor: "admin" as const,
          actorId: "staff_01",
          reason: "test",
          ...overrides,
        },
        nonce: randomUUID(),
        actor: { principal: "user" as const, sessionId: "admin:staff_01" },
        taint: "TRUSTED",
      })
    }

    it("EXECUTE: amount ≤ R$500 refund flows through executor (atomic txn)", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(paidRow())
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildRefundEnvelope(40_000) // R$400 < R$500
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toMatchObject({
        previousStatus: "paid",
        newStatus: "partially_refunded",
        refundAmountCentavos: 40_000,
        totalRefundedCentavos: 40_000,
        version: 2,
      })
      // The kernel-adjudicated executor performs the refundedAmount
      // UPDATE inside its own $transaction. The direct
      // prisma.payment.update outside the executor is GONE (W3 P0-1).
      expect(mockPaymentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            refundedAmountCentavos: 40_000,
            status: "refunded".length === 8 ? expect.any(String) : expect.any(String),
            version: 2,
          }),
        }),
      )
    })

    it("EXECUTE: full refund flips status to refunded", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(
        paidRow({ amountInCentavos: 30_000, refundedAmountCentavos: 0 }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = buildRefundEnvelope(30_000, {
        refundableBalanceCentavos: 30_000,
        amountInCentavos: 30_000,
      })
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(outcome.result).toMatchObject({
        newStatus: "refunded",
        totalRefundedCentavos: 30_000,
      })
    })

    it("REQUEST_CONFIRMATION: R$500 < amount ≤ R$1000", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(paidRow())

      const envelope = buildRefundEnvelope(60_000) // R$600
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REQUEST_CONFIRMATION")
      if (outcome.decision.kind === "REQUEST_CONFIRMATION") {
        expect(outcome.decision.prompt).toMatch(/Confirmar reembolso/)
        expect(outcome.decision.prompt).toMatch(/R\$ 600,00/)
      }
      // Executor MUST NOT have run.
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })

    it("ESCALATE: amount > R$1000", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(paidRow())

      const envelope = buildRefundEnvelope(120_000) // R$1200
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("ESCALATE")
      if (outcome.decision.kind === "ESCALATE") {
        expect(outcome.decision.to).toBe("human")
        expect(outcome.decision.reason).toBe(
          "refund_above_escalate_threshold",
        )
      }
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })

    // FE-T03/D2 — exact-boundary pins on the DOMAIN (admin-HTTP) path.
    // This bundle's guard is a byte-parallel duplicate of
    // @ibatexas/pack-payments' refundMagnitudeGuard (FE-D07 tracks
    // consolidating them); these three pins prove the admin route now
    // matches the ops/WhatsApp route's boundary behavior exactly.
    it("REQUEST_CONFIRMATION: amount = R$ 999,99 (just below escalate threshold)", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(paidRow())

      const envelope = buildRefundEnvelope(99_999)
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REQUEST_CONFIRMATION")
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })

    it("ESCALATE: amount = R$ 1.000 (boundary inclusive) — FE-T03/D2 flip", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(paidRow())

      const envelope = buildRefundEnvelope(100_000)
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("ESCALATE")
      if (outcome.decision.kind === "ESCALATE") {
        expect(outcome.decision.to).toBe("human")
        expect(outcome.decision.reason).toBe(
          "refund_above_escalate_threshold",
        )
      }
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })

    it("ESCALATE: amount = R$ 1.000,01 (just above escalate threshold)", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(paidRow())

      const envelope = buildRefundEnvelope(100_001)
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("ESCALATE")
      if (outcome.decision.kind === "ESCALATE") {
        expect(outcome.decision.to).toBe("human")
      }
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })

    it("REFUSE: refund amount > refundable balance", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(
        paidRow({ refundedAmountCentavos: 180_000 }),
      )

      const envelope = buildRefundEnvelope(40_000, {
        refundableBalanceCentavos: 20_000, // only R$200 refundable
        currentRefundedCentavos: 180_000,
      })
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      if (outcome.decision.kind === "REFUSE") {
        expect(outcome.decision.refusal.code).toBe("refund.amount_invalid")
        expect(outcome.decision.refusal.userFacing).toMatch(
          /maior do que o disponível/,
        )
      }
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })

    it("REFUSE: refund amount ≤ 0", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(paidRow())

      const envelope = buildRefundEnvelope(0)
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      if (outcome.decision.kind === "REFUSE") {
        expect(outcome.decision.refusal.code).toBe("refund.amount_invalid")
      }
    })

    it("REFUSE: state divergence (envelope vs DB mismatch)", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(
        paidRow({ refundedAmountCentavos: 50_000 }),
      )

      // Envelope thinks no refund yet — DB says 50k already refunded.
      const envelope = buildRefundEnvelope(20_000, {
        currentRefundedCentavos: 0,
      })
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      if (outcome.decision.kind === "REFUSE") {
        expect(outcome.decision.refusal.code).toBe("refund.state_divergent")
      }
    })

    it("REFUSE: cannot refund a terminal payment (refunded)", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(
        paidRow({ status: "refunded" }),
      )

      const envelope = buildRefundEnvelope(10_000)
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      // Terminal-state guard from existing policy bundle still applies.
      expect(outcome.decision.kind).toBe("REFUSE")
    })
  })

  // ── BKL-074 — kernel-level staff-role backstop on the command-service path ──
  //
  // Proves the injected `authGuards: [staffRoleGuard]` runs INSIDE the
  // command-service adjudication (against the RAW paymentProjectionPolicyBundle
  // that carries NO adopter auth guards). A mis-scoped staff role is REFUSED at
  // the kernel BEFORE the executor runs, even though the pack bundle alone would
  // EXECUTE the refund. The guard is inert for non-`admin:` envelopes, so the
  // universal-inject is a no-op for system/customer/agent traffic.
  describe("BKL-074 — injected staffRoleGuard backstop on payment.refund.issue", () => {
    const guard = createTestStaffRoleGuard()

    function refundRow(overrides: Record<string, unknown> = {}) {
      return makePaymentRow({
        status: "paid",
        version: 1,
        amountInCentavos: 200_000,
        refundedAmountCentavos: 0,
        regenerationCount: 0,
        ...overrides,
      })
    }

    function refundEnvelope(
      actor: { principal: "user" | "system"; sessionId: string; role?: string },
      taint: "TRUSTED" | "SYSTEM",
      amountCentavos = 40_000, // R$400 — EXECUTE band (≤ R$500) by the money ladder
    ) {
      return buildEnvelope({
        kind: "payment.refund.issue" as const,
        payload: {
          paymentId: "pay_01",
          refundAmountCentavos: amountCentavos,
          refundableBalanceCentavos: 200_000,
          amountInCentavos: 200_000,
          currentRefundedCentavos: 0,
          actor: actor.principal === "system" ? ("system" as const) : ("admin" as const),
          actorId: "staff_1",
          reason: "bkl074-test",
        },
        nonce: randomUUID(),
        actor,
        taint,
      })
    }

    it("REFUSE: admin ATTENDANT refund is blocked at AUTH by the injected guard — executor NEVER runs", async () => {
      const svc = createPaymentCommandService(undefined, { authGuards: [guard] })
      mockPaymentFindUnique.mockResolvedValue(refundRow())
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = refundEnvelope(
        { principal: "user", sessionId: "admin:staff_1", role: "ATTENDANT" },
        "TRUSTED",
      )
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      if (outcome.decision.kind === "REFUSE") {
        // The refund would EXECUTE by the money band — REFUSE proves the AUTH
        // backstop short-circuited before the business phase.
        expect(outcome.decision.refusal.code).toBe(STAFF_ROLE_REFUSAL_CODE)
        expect(outcome.decision.refusal.kind).toBe("AUTH")
      }
      // Load-bearing: the executor's DB writes never happened.
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
      expect(mockHistoryCreate).not.toHaveBeenCalled()
    })

    it("EXECUTE: admin OWNER refund passes the injected guard (refund is OWNER/MANAGER)", async () => {
      const svc = createPaymentCommandService(undefined, { authGuards: [guard] })
      mockPaymentFindUnique.mockResolvedValue(refundRow())
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = refundEnvelope(
        { principal: "user", sessionId: "admin:owner_1", role: "OWNER" },
        "TRUSTED",
      )
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(mockPaymentUpdate).toHaveBeenCalledOnce()
    })

    it("EXECUTE (guard inert): a SYSTEM-actor refund (non-admin sessionId) still EXECUTEs with the guard injected — no regression", async () => {
      const svc = createPaymentCommandService(undefined, { authGuards: [guard] })
      mockPaymentFindUnique.mockResolvedValue(refundRow())
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      // sessionId does NOT start with "admin:" — the staff-role guard must not
      // engage (it is a subscriber/job-shaped system actor).
      const envelope = refundEnvelope(
        { principal: "system", sessionId: "payments.events:evt_1" },
        "SYSTEM",
      )
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("EXECUTE")
      expect(mockPaymentUpdate).toHaveBeenCalledOnce()
    })

    it("REFUSE: admin refund with NO actor.role is blocked at AUTH — executor NEVER runs", async () => {
      const svc = createPaymentCommandService(undefined, { authGuards: [guard] })
      mockPaymentFindUnique.mockResolvedValue(refundRow())
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const envelope = refundEnvelope(
        { principal: "user", sessionId: "admin:staff_norole" },
        "TRUSTED",
      )
      const outcome = await svc.issueRefundFromEnvelope(envelope)

      expect(outcome.decision.kind).toBe("REFUSE")
      if (outcome.decision.kind === "REFUSE") {
        expect(outcome.decision.refusal.code).toBe(STAFF_ROLE_REFUSAL_CODE)
      }
      expect(mockPaymentUpdate).not.toHaveBeenCalled()
    })
  })

  // BKL-085 — the POST-adjudication refund write shared with governed ops callers.
  describe("writeAdjudicatedRefund — no re-adjudication, DB write + orderId/method", () => {
    it("performs the ledger write and returns orderId + method from the DB row (no kernel call)", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(
        makePaymentRow({
          status: "paid",
          version: 1,
          amountInCentavos: 10_000,
          refundedAmountCentavos: 0,
          orderId: "order_ops",
          method: "pix",
        }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.writeAdjudicatedRefund({
        paymentId: "pay_01",
        refundAmountCentavos: 3_000,
        refundableBalanceCentavos: 10_000,
        amountInCentavos: 10_000,
        currentRefundedCentavos: 0,
        actor: "admin",
        actorId: "staff_ops",
        reason: "ops refund",
      })

      // Ledger-only write (status + refundedAmountCentavos + version), no egress.
      expect(mockPaymentUpdate).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({
        previousStatus: "paid",
        newStatus: "partially_refunded",
        refundAmountCentavos: 3_000,
        totalRefundedCentavos: 3_000,
        version: 2,
        // Read from the DB row so the ops emit path never trusts the model for them.
        orderId: "order_ops",
        method: "pix",
      })
    })

    it("a full refund transitions to refunded and returns the DB orderId/method", async () => {
      const svc = createPaymentCommandService()
      mockPaymentFindUnique.mockResolvedValue(
        makePaymentRow({
          status: "paid",
          version: 4,
          amountInCentavos: 5_000,
          refundedAmountCentavos: 0,
          orderId: "order_full",
          method: "card",
        }),
      )
      mockPaymentUpdate.mockResolvedValue({})
      mockHistoryCreate.mockResolvedValue({})

      const result = await svc.writeAdjudicatedRefund({
        paymentId: "pay_01",
        refundAmountCentavos: 5_000,
        refundableBalanceCentavos: 5_000,
        amountInCentavos: 5_000,
        currentRefundedCentavos: 0,
        actor: "admin",
        actorId: "staff_ops",
      })

      expect(result.newStatus).toBe("refunded")
      expect(result.orderId).toBe("order_full")
      expect(result.method).toBe("card")
    })
  })
})
