// PaymentCommandService — write operations for payment projections.
//
// Mirrors OrderCommandService pattern: optimistic concurrency, validated
// transitions, append-only audit trail.
//
// INVARIANT: One active (non-terminal) payment per order at any time.
// Retry/regeneration creates a new Payment row; old one stays terminal.
//
// ── Task 15 (M3) — envelope-typed entry points ───────────────────────────
//
// New methods `*FromEnvelope` accept `IntentEnvelope<*>` inputs and run
// through `withAdjudicate` against `paymentProjectionPolicyBundle`. The
// legacy bare-arg methods remain (Decision D8 — backwards compatibility
// during incremental caller migration).

import { prisma } from "../client.js"
import type {
  PrismaClient,
  PaymentStatus as PrismaPaymentStatus,
  OrderActor as PrismaActor,
} from "../generated/prisma-client/client.js"
import {
  canTransitionPayment,
  isTerminalPaymentStatus,
  PaymentStatus,
  TERMINAL_PAYMENT_STATUSES,
} from "@ibatexas/types"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import type { Guard } from "@adjudicate/core/kernel"
import {
  withAdjudicate,
  type AdjudicatedResult,
} from "./__shared__/with-adjudicate.js"
import {
  paymentProjectionPolicyBundle,
  type PaymentCreatePayload,
  type PaymentRefundIssuePayload,
  type PaymentRegenerationCountIncrementPayload,
  type PaymentStatusTransitionPayload,
  type PaymentStatusReconcilePayload,
  type PaymentDisputeOpenPayload,
  type PaymentProjectionState,
} from "./__shared__/payment-projection-policy.js"

// Transaction client type
type TxClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">

// ── Error types ─────────────────────────────────────────────────────────────

export class PaymentConcurrencyError extends Error {
  constructor(paymentId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Concurrency conflict on payment ${paymentId}: expected version ${expectedVersion}, found ${actualVersion}`,
    )
    this.name = "PaymentConcurrencyError"
  }
}

export class PaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`Payment not found: ${paymentId}`)
    this.name = "PaymentNotFoundError"
  }
}

export class InvalidPaymentTransitionError extends Error {
  public readonly from: string
  public readonly to: string
  constructor(paymentId: string, from: string, to: string) {
    super(`Invalid payment transition on ${paymentId}: ${from} → ${to}`)
    this.name = "InvalidPaymentTransitionError"
    this.from = from
    this.to = to
  }
}

export class ActivePaymentExistsError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} already has an active (non-terminal) payment`)
    this.name = "ActivePaymentExistsError"
  }
}

// Name of the manually-managed partial unique index that enforces the
// "one active (non-terminal) payment per order" invariant at the DB level.
// Defined in prisma/migrations/20260412000000_add_payment_tables/migration.sql
// (CREATE UNIQUE INDEX ... ON payments(order_id) WHERE status NOT IN (<terminal>)).
const ACTIVE_PAYMENT_INDEX = "payment_active_per_order"

/**
 * Returns true when `err` is a Prisma P2002 (unique constraint) violation
 * raised by the active-payment partial unique index — i.e. a concurrent
 * create lost the race to insert the single active payment.
 *
 * Detection is duck-typed on `.code` so it works both with real
 * Prisma.PrismaClientKnownRequestError instances — which carry `.code` — and
 * the lightweight `{ code }` mocks used by the unit tests. The `meta.target`
 * check narrows it to the active-payment index so that P2002s from the
 * stripe_payment_intent_id / idempotency_key unique indexes are NOT misreported
 * as ActivePaymentExists.
 */
function isActivePaymentUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const code = (err as { code?: unknown }).code
  if (code !== "P2002") return false

  // meta.target may be the index name (string), a string[] of columns, or
  // undefined depending on the Prisma version / DB driver. Treat a missing
  // target conservatively as a match (the active-payment index is the only
  // multi-row, order_id-scoped unique constraint on this table; the other two
  // are single-column and surface their own column names).
  const target = (err as { meta?: { target?: unknown } }).meta?.target
  if (target === undefined || target === null) return true
  if (typeof target === "string") {
    return target.includes(ACTIVE_PAYMENT_INDEX) || target.includes("order_id")
  }
  if (Array.isArray(target)) {
    return target.some(
      (t) => typeof t === "string" && (t.includes(ACTIVE_PAYMENT_INDEX) || t.includes("order_id")),
    )
  }
  return false
}

// ── Input types ─────────────────────────────────────────────────────────────

export interface CreatePaymentInput {
  orderId: string
  method: "pix" | "card" | "cash"
  amountInCentavos: number
  stripePaymentIntentId?: string
  pixExpiresAt?: Date
  idempotencyKey?: string
}

interface TransitionPaymentStatusInput {
  newStatus: PaymentStatus
  actor: "admin" | "system" | "customer"
  actorId?: string
  reason?: string
  expectedVersion?: number
}

interface ReconcileFromWebhookInput {
  newStatus: PaymentStatus
  stripeEventId: string
  stripeEventTimestamp?: Date
  expectedOrderId?: string
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface PaymentCommandService {
  // ── R1-DELETE (W1 correctness remediation) ──────────────────────────
  //
  // The bare-arg @deprecated entry points (`create`, `transitionStatus`,
  // `reconcileFromWebhook`) have been DELETED from the interface. All
  // production callers were migrated to the `*FromEnvelope` path
  // (apps/api/src/routes/order-actions.ts, packages/tools/src/cart/).
  // The type system now structurally prevents reintroducing the bypass.

  /**
   * Envelope-typed entry point for `payment.create`. SYSTEM-only.
   */
  createFromEnvelope(
    envelope: IntentEnvelope<"payment.create", PaymentCreatePayload>,
  ): Promise<AdjudicatedResult<{ id: string; version: number }>>

  /**
   * Envelope-typed entry point for `payment.status.transition`.
   */
  transitionStatusFromEnvelope(
    envelope: IntentEnvelope<"payment.status.transition", PaymentStatusTransitionPayload>,
  ): Promise<
    AdjudicatedResult<{ version: number; previousStatus: string; newStatus: string }>
  >

  /**
   * Envelope-typed entry point for `payment.status.reconcile`. SYSTEM-only.
   * Webhook-driven reconciliation: idempotency, terminal-state guard,
   * out-of-order, ownership preserved inside the executor.
   */
  reconcileFromWebhookFromEnvelope(
    envelope: IntentEnvelope<"payment.status.reconcile", PaymentStatusReconcilePayload>,
  ): Promise<AdjudicatedResult<{ version: number } | null>>

  /**
   * BKL-178 — envelope-typed entry point for `payment.dispute.open`.
   * SYSTEM-only. ADJUDICATE-ONLY: a chargeback carries no state mutation of
   * its own — `escalateAlwaysOnDispute` ALWAYS ESCALATEs it for human
   * review, and the payment's DISPUTED status is written separately via
   * `payment.status.reconcile` (status truth). The executor is unreachable
   * by construction and fail-closed. Returns the kernel Decision so the
   * webhook can surface the ESCALATE as a support handoff — never a silent
   * audit-only record.
   */
  disputeOpenFromEnvelope(
    envelope: IntentEnvelope<"payment.dispute.open", PaymentDisputeOpenPayload>,
  ): Promise<AdjudicatedResult<never>>

  /**
   * W3 P0-1 — envelope-typed entry point for `payment.refund.issue`.
   *
   * The refund MAGNITUDE is in the payload and is adjudicated by the
   * payment-projection policy bundle's magnitude guard (REFUSE / EXECUTE
   * / REQUEST_CONFIRMATION / ESCALATE). On EXECUTE / REWRITE the executor
   * (a) updates `refundedAmountCentavos`, (b) transitions the payment
   * status to `partially_refunded` / `refunded` (based on whether the
   * cumulative refund covers the original amount), and (c) writes a
   * status-history row — all inside a single Prisma `$transaction`.
   *
   * The route layer still owns the two-step receipt UX (the kernel
   * decision is the structural gate; the receipt is the operator gate).
   */
  issueRefundFromEnvelope(
    envelope: IntentEnvelope<"payment.refund.issue", PaymentRefundIssuePayload>,
  ): Promise<
    AdjudicatedResult<{
      version: number
      previousStatus: string
      newStatus: string
      totalRefundedCentavos: number
      refundAmountCentavos: number
      orderId: string
      method: string
    }>
  >

  /**
   * BKL-085 — persist a `payment.refund.issue` the caller has ALREADY
   * adjudicated through the COMPOSED policy router (the ops-plane refunds-by-
   * message path). THE CALLER MUST HOLD A POSITIVE (EXECUTE/REWRITE) `Decision`
   * — this performs NO adjudication; it is the post-decision persistence body
   * extracted from `executeRefundIssue` and shared, exactly like
   * `writeAdjudicatedNote` / `writeAdjudicatedStatusTransition` on the order
   * command service.
   *
   * The ops path adjudicates through `composePolicyRouter` (carrying
   * `staffRoleGuard` + the staff-role matrix + the BKL-085 UNTRUSTED-taint
   * refund overlay). Re-running `issueRefundFromEnvelope` there would double-
   * adjudicate against the DOMAIN `paymentProjectionPolicyBundle` (which does
   * NOT carry those adopter guards), so a governed ops caller uses this method
   * to persist without a second, weaker adjudication. The refund WRITE is
   * ledger-only (status → partially_refunded/refunded + refundedAmountCentavos
   * + a status-history row, in one $transaction) — there is NO Stripe/PIX egress
   * in this path (the only Stripe refund code is the inbound `charge.refunded`
   * webhook reconcile). The `refundAmountCentavos`/`actor`/`actorId` come from
   * the (stamped) payload; balance is re-derived from the LIVE DB row inside the
   * tx (the over-balance / terminal / canTransition throws REMAIN the last
   * transactional line). The returned `orderId`/`method` let the caller emit the
   * SAME `payment.status_changed` event the admin route publishes.
   */
  writeAdjudicatedRefund(
    payload: PaymentRefundIssuePayload,
  ): Promise<{
    version: number
    previousStatus: string
    newStatus: string
    totalRefundedCentavos: number
    refundAmountCentavos: number
    orderId: string
    method: string
  }>

  /**
   * W3 P0-2 — envelope-typed entry point for
   * `payment.regeneration.count.increment`.
   *
   * Bumps `regenerationCount` on a Payment row via the kernel-adjudicated
   * path. SYSTEM-only kind; called after the new payment row has been
   * created during a regenerate-pix flow.
   */
  bumpRegenerationCountFromEnvelope(
    envelope: IntentEnvelope<
      "payment.regeneration.count.increment",
      PaymentRegenerationCountIncrementPayload
    >,
  ): Promise<AdjudicatedResult<{ regenerationCount: number }>>

  /**
   * Find the active (non-terminal) payment for an order.
   * Returns null if no active payment exists.
   */
  findActiveByOrderId(orderId: string): Promise<{ id: string; status: string; version: number } | null>
}

type Logger = {
  warn?: (...args: unknown[]) => void
  info?: (...args: unknown[]) => void
}

export interface PaymentCommandServiceOptions {
  readonly auditSink?: AuditSink
  readonly log?: Logger
  /**
   * WS7 / BKL-074 — adopter AUTH guards (e.g. `staffRoleGuard`) injected into
   * EVERY `withAdjudicate` call this service makes. The HTTP admin routes pass
   * `[staffRoleGuard]` so a mis-scoped staff role is REFUSED at the kernel on
   * the command-service adjudication path (which uses RAW pack bundles), not
   * only by the Fastify preHandler. Inert for non-`admin:` envelopes, so this
   * is a no-op for SYSTEM-actor create/reconcile/webhook paths. Threaded
   * through `adjudicateOptions` so per-method calls are unchanged.
   */
  readonly authGuards?: readonly Guard<string, unknown, unknown>[]
}

export function createPaymentCommandService(
  log?: Logger,
  options?: PaymentCommandServiceOptions,
): PaymentCommandService {
  // Terminal status values for Prisma queries
  const terminalValues = TERMINAL_PAYMENT_STATUSES as unknown as string[]

  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    ...(options?.authGuards ? { authGuards: options.authGuards } : {}),
    log: log ?? options?.log,
  } as const

  // ── Helper: find the active (non-terminal) payment for an order ───
  // Standalone so both the public method and the create-race catch below can
  // re-read the winning row without a `this`/`svc` reference.
  const findActiveByOrderId = async (
    orderId: string,
  ): Promise<{ id: string; status: string; version: number } | null> => {
    return prisma.payment.findFirst({
      where: {
        orderId,
        status: { notIn: terminalValues as PrismaPaymentStatus[] },
      },
      select: { id: true, status: true, version: true },
      orderBy: { createdAt: "desc" },
    })
  }

  // ── Legacy executor: create ────────────────────────────────────────
  const executeCreate = async (
    data: CreatePaymentInput,
  ): Promise<{ id: string; version: number }> => {
    try {
      return await prisma.$transaction(async (tx: TxClient) => {
        // Fast path: enforce single active payment per order in app code. This
        // catches the common (uncontended) case with a clear error and avoids a
        // wasted INSERT. It is NOT sufficient on its own under Read-Committed
        // concurrency — two simultaneous creates can both see "no active
        // payment" here. The partial unique index on payments is the
        // authoritative backstop; the catch below translates the resulting
        // P2002 into the same domain error (P1-CONC-ACTIVEPAY).
        const existing = await tx.payment.findFirst({
          where: {
            orderId: data.orderId,
            status: { notIn: terminalValues as PrismaPaymentStatus[] },
          },
          select: { id: true },
        })

        if (existing) {
          throw new ActivePaymentExistsError(data.orderId)
        }

        const initialStatus = data.method === "cash"
          ? "cash_pending" as PrismaPaymentStatus
          : "awaiting_payment" as PrismaPaymentStatus

        const payment = await tx.payment.create({
          data: {
            orderId: data.orderId,
            method: data.method,
            status: initialStatus,
            amountInCentavos: data.amountInCentavos,
            stripePaymentIntentId: data.stripePaymentIntentId,
            pixExpiresAt: data.pixExpiresAt,
            idempotencyKey: data.idempotencyKey,
            version: 1,
          },
        })

        await tx.paymentStatusHistory.create({
          data: {
            paymentId: payment.id,
            fromStatus: initialStatus,
            toStatus: initialStatus,
            actor: "system" as PrismaActor,
            version: 1,
          },
        })

        await tx.orderProjection.update({
          where: { id: data.orderId },
          data: { currentPaymentId: payment.id },
        })

        return { id: payment.id, version: 1 }
      })
    } catch (err) {
      // DB backstop: a concurrent create lost the race and the partial unique
      // index rejected the duplicate active payment. Treat it as the same
      // condition the fast path guards against — surface a clear domain error
      // (re-reading the winning active payment for the log) instead of leaking
      // a raw P2002 / 500. P2002s from other unique indexes are re-thrown.
      if (isActivePaymentUniqueViolation(err)) {
        const winner = await findActiveByOrderId(data.orderId)
        log?.warn?.(
          { orderId: data.orderId, existingPaymentId: winner?.id, existingStatus: winner?.status },
          "[payment-command] create: lost race to partial unique index — active payment already exists",
        )
        throw new ActivePaymentExistsError(data.orderId)
      }
      throw err
    }
  }

  // ── Legacy executor: transitionStatus ────────────────────────────
  const executeTransition = async (
    paymentId: string,
    input: TransitionPaymentStatusInput,
  ): Promise<{ version: number; previousStatus: string; newStatus: string }> => {
    return prisma.$transaction(async (tx: TxClient) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
      })

      if (!payment) {
        throw new PaymentNotFoundError(paymentId)
      }

      if (input.expectedVersion !== undefined && payment.version !== input.expectedVersion) {
        throw new PaymentConcurrencyError(paymentId, input.expectedVersion, payment.version)
      }

      const from = payment.status as PaymentStatus
      const to = input.newStatus
      if (!canTransitionPayment(from, to)) {
        throw new InvalidPaymentTransitionError(paymentId, from, to)
      }

      const newVersion = payment.version + 1

      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: to as PrismaPaymentStatus,
          version: newVersion,
        },
      })

      await tx.paymentStatusHistory.create({
        data: {
          paymentId,
          fromStatus: from as PrismaPaymentStatus,
          toStatus: to as PrismaPaymentStatus,
          actor: input.actor as PrismaActor,
          actorId: input.actorId,
          reason: input.reason,
          version: newVersion,
        },
      })

      log?.info?.(
        { paymentId, orderId: payment.orderId, from, to, version: newVersion, actor: input.actor },
        "Payment status transitioned",
      )

      return { version: newVersion, previousStatus: from, newStatus: to }
    })
  }

  // ── Legacy executor: reconcileFromWebhook ────────────────────────
  const executeReconcile = async (
    paymentId: string,
    input: ReconcileFromWebhookInput,
  ): Promise<{ version: number } | null> => {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
    })

    if (!payment) return null

    if (isTerminalPaymentStatus(payment.status as PaymentStatus)) {
      log?.warn?.(
        { paymentId, currentStatus: payment.status, attemptedStatus: input.newStatus },
        "[payment-command] reconcile: payment is terminal — skipping",
      )
      return null
    }

    if (payment.status === "switching_method") {
      log?.warn?.(
        { paymentId, currentStatus: payment.status },
        "[payment-command] reconcile: payment is switching method — skipping",
      )
      return null
    }

    if (input.stripeEventTimestamp && payment.lastStripeEventTs) {
      if (input.stripeEventTimestamp <= payment.lastStripeEventTs) {
        log?.warn?.(
          { paymentId, eventTs: input.stripeEventTimestamp, lastTs: payment.lastStripeEventTs },
          "[payment-command] reconcile: out-of-order event — skipping",
        )
        return null
      }
    }

    if (input.expectedOrderId && payment.orderId !== input.expectedOrderId) {
      log?.warn?.(
        { paymentId, expectedOrderId: input.expectedOrderId, actualOrderId: payment.orderId },
        "[payment-command] reconcile: order ID mismatch — quarantining",
      )
      return null
    }

    if (payment.status === input.newStatus) return null

    const from = payment.status as PaymentStatus
    if (!canTransitionPayment(from, input.newStatus)) {
      log?.warn?.(
        { paymentId, from, to: input.newStatus, stripeEventId: input.stripeEventId },
        "[payment-command] reconcile: invalid transition — quarantining",
      )
      return null
    }

    const readVersion = payment.version
    const newVersion = readVersion + 1

    const applied = await prisma.$transaction(async (tx: TxClient) => {
      const { count } = await tx.payment.updateMany({
        where: { id: paymentId, version: readVersion },
        data: {
          status: input.newStatus as PrismaPaymentStatus,
          version: newVersion,
          lastStripeEventTs: input.stripeEventTimestamp ?? undefined,
        },
      })

      if (count === 0) return false

      await tx.paymentStatusHistory.create({
        data: {
          paymentId,
          fromStatus: from as PrismaPaymentStatus,
          toStatus: input.newStatus as PrismaPaymentStatus,
          actor: "system" as PrismaActor,
          reason: input.stripeEventId ? `stripe:${input.stripeEventId}` : undefined,
          version: newVersion,
        },
      })

      return true
    })

    if (!applied) return null

    log?.info?.(
      { paymentId, orderId: payment.orderId, from, to: input.newStatus, version: newVersion, stripeEventId: input.stripeEventId },
      "Payment status reconciled from webhook",
    )

    return { version: newVersion }
  }

  // ── Helper: snapshot payment state ───────────────────────────────
  const snapshotPayment = async (
    paymentId: string,
  ): Promise<PaymentProjectionState> => {
    const row = await prisma.payment.findUnique({ where: { id: paymentId } })
    if (!row) return { ctx: { exists: false } }
    return {
      ctx: {
        exists: true,
        currentStatus: row.status,
        currentMethod: row.method as "pix" | "card" | "cash",
        version: row.version,
        orderId: row.orderId,
        isTerminal: isTerminalPaymentStatus(row.status as PaymentStatus),
        refundedAmountCentavos: row.refundedAmountCentavos ?? 0,
        amountInCentavos: row.amountInCentavos,
        regenerationCount: row.regenerationCount ?? 0,
      },
    }
  }

  // ── W3 P0-1 executor: refund.issue ────────────────────────────────
  //
  // Atomic transaction: update refundedAmountCentavos + transition
  // status (PAID → PARTIALLY_REFUNDED, or PAID → REFUNDED on full
  // refund) + status-history row.
  const executeRefundIssue = async (
    payload: PaymentRefundIssuePayload,
  ): Promise<{
    version: number
    previousStatus: string
    newStatus: string
    totalRefundedCentavos: number
    refundAmountCentavos: number
    // BKL-085 — the order id + method read from the SAME DB row inside the tx,
    // so a governed ops caller can publish an accurate `payment.status_changed`
    // event (driving the auto-cancel-on-full-refund lifecycle subscriber) without
    // a second read or trusting the model payload for them. The admin-HTTP caller
    // already holds both from its own reads and simply ignores these.
    orderId: string
    method: string
  }> => {
    return prisma.$transaction(async (tx: TxClient) => {
      const payment = await tx.payment.findUnique({
        where: { id: payload.paymentId },
      })

      if (!payment) {
        throw new PaymentNotFoundError(payload.paymentId)
      }

      if (isTerminalPaymentStatus(payment.status as PaymentStatus)) {
        throw new InvalidPaymentTransitionError(
          payload.paymentId,
          payment.status,
          "refund.issue",
        )
      }

      const currentRefunded = payment.refundedAmountCentavos ?? 0
      const refundable = payment.amountInCentavos - currentRefunded
      if (payload.refundAmountCentavos > refundable) {
        // Defensive: the kernel guard already refuses this, but the
        // executor is a final source of truth on the DB invariant.
        throw new InvalidPaymentTransitionError(
          payload.paymentId,
          payment.status,
          "refund.over_balance",
        )
      }

      const newTotalRefunded = currentRefunded + payload.refundAmountCentavos
      const isFullRefund = newTotalRefunded >= payment.amountInCentavos
      const targetStatus = (
        isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED
      ) as PrismaPaymentStatus

      const from = payment.status as PaymentStatus
      if (!canTransitionPayment(from, targetStatus as PaymentStatus)) {
        throw new InvalidPaymentTransitionError(
          payload.paymentId,
          from,
          targetStatus,
        )
      }

      const newVersion = payment.version + 1

      await tx.payment.update({
        where: { id: payload.paymentId },
        data: {
          status: targetStatus,
          refundedAmountCentavos: newTotalRefunded,
          version: newVersion,
        },
      })

      await tx.paymentStatusHistory.create({
        data: {
          paymentId: payload.paymentId,
          fromStatus: from as PrismaPaymentStatus,
          toStatus: targetStatus,
          actor: payload.actor as PrismaActor,
          actorId: payload.actorId,
          reason:
            payload.reason ??
            `refund_issued:${payload.refundAmountCentavos}cent`,
          version: newVersion,
        },
      })

      log?.info?.(
        {
          paymentId: payload.paymentId,
          orderId: payment.orderId,
          from,
          to: targetStatus,
          version: newVersion,
          refundAmount: payload.refundAmountCentavos,
          totalRefunded: newTotalRefunded,
        },
        "Refund issued (kernel-adjudicated)",
      )

      return {
        version: newVersion,
        previousStatus: from,
        newStatus: targetStatus,
        totalRefundedCentavos: newTotalRefunded,
        refundAmountCentavos: payload.refundAmountCentavos,
        orderId: payment.orderId,
        method: payment.method,
      }
    })
  }

  // ── W3 P0-2 executor: regeneration count increment ────────────────
  const executeRegenerationCountIncrement = async (
    payload: PaymentRegenerationCountIncrementPayload,
  ): Promise<{ regenerationCount: number }> => {
    return prisma.$transaction(async (tx: TxClient) => {
      const payment = await tx.payment.findUnique({
        where: { id: payload.paymentId },
      })
      if (!payment) {
        throw new PaymentNotFoundError(payload.paymentId)
      }
      const current = payment.regenerationCount ?? 0
      const next = current + 1
      await tx.payment.update({
        where: { id: payload.paymentId },
        data: { regenerationCount: next },
      })
      return { regenerationCount: next }
    })
  }

  return {
    // ── R1-DELETE: bare-arg @deprecated methods removed ──────────────
    // executor helpers (executeCreate, executeTransition,
    // executeReconcile) remain — they're invoked from the envelope-
    // typed entry points below.

    async findActiveByOrderId(orderId) {
      return findActiveByOrderId(orderId)
    },

    // ── Envelope-typed entry points ─────────────────────────────────

    async createFromEnvelope(envelope) {
      // No payment row yet for the create path.
      const state: PaymentProjectionState = { ctx: { exists: false } }
      return withAdjudicate(
        envelope,
        state,
        paymentProjectionPolicyBundle,
        async (payload) => {
          const input: CreatePaymentInput = {
            orderId: payload.orderId,
            method: payload.method,
            amountInCentavos: payload.amountInCentavos,
            ...(payload.stripePaymentIntentId === undefined
              ? {}
              : { stripePaymentIntentId: payload.stripePaymentIntentId }),
            ...(payload.pixExpiresAt === undefined
              ? {}
              : { pixExpiresAt: new Date(payload.pixExpiresAt) }),
            ...(payload.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: payload.idempotencyKey }),
          }
          return executeCreate(input)
        },
        adjudicateOptions,
      )
    },

    async transitionStatusFromEnvelope(envelope) {
      const state = await snapshotPayment(envelope.payload.paymentId)
      return withAdjudicate(
        envelope,
        state,
        paymentProjectionPolicyBundle,
        async (payload) => {
          const input: TransitionPaymentStatusInput = {
            newStatus: payload.newStatus as PaymentStatus,
            actor: payload.actor,
            actorId: payload.actorId,
            reason: payload.reason,
            expectedVersion: payload.expectedVersion,
          }
          return executeTransition(payload.paymentId, input)
        },
        adjudicateOptions,
      )
    },

    async reconcileFromWebhookFromEnvelope(envelope) {
      const state = await snapshotPayment(envelope.payload.paymentId)
      return withAdjudicate(
        envelope,
        state,
        paymentProjectionPolicyBundle,
        async (payload) => {
          const input: ReconcileFromWebhookInput = {
            newStatus: payload.newStatus as PaymentStatus,
            stripeEventId: payload.stripeEventId,
            ...(payload.stripeEventTimestamp === undefined
              ? {}
              : { stripeEventTimestamp: new Date(payload.stripeEventTimestamp) }),
            ...(payload.expectedOrderId === undefined
              ? {}
              : { expectedOrderId: payload.expectedOrderId }),
          }
          return executeReconcile(payload.paymentId, input)
        },
        adjudicateOptions,
      )
    },

    async disputeOpenFromEnvelope(envelope) {
      // ADJUDICATE-ONLY. The snapshot is REAL (the webhook resolves the
      // Payment row before minting the envelope) so `requirePaymentExists`
      // passes and `escalateAlwaysOnDispute` yields a true ESCALATE — not a
      // REFUSE for a missing row. The DISPUTED status is written by the
      // sibling `payment.status.reconcile`, never here.
      const state = await snapshotPayment(envelope.payload.paymentId)
      return withAdjudicate(
        envelope,
        state,
        paymentProjectionPolicyBundle,
        async () => {
          // Unreachable by construction: `escalateAlwaysOnDispute` ESCALATEs
          // every `payment.dispute.open`, so the kernel never reaches
          // EXECUTE/REWRITE. Fail-closed — surface a policy contract change
          // loudly rather than silently mutate (dispute.open has no executor).
          throw new Error(
            "payment.dispute.open has no executor — dispute review is escalation-only; payment status is reconciled via payment.status.reconcile",
          )
        },
        adjudicateOptions,
      )
    },

    async issueRefundFromEnvelope(envelope) {
      const state = await snapshotPayment(envelope.payload.paymentId)
      return withAdjudicate(
        envelope,
        state,
        paymentProjectionPolicyBundle,
        async (payload) => executeRefundIssue(payload),
        adjudicateOptions,
      )
    },

    // BKL-085 — the raw post-decision refund write, shared with governed ops
    // callers that already hold a composed-router Decision (no re-adjudication).
    async writeAdjudicatedRefund(payload) {
      return executeRefundIssue(payload)
    },

    async bumpRegenerationCountFromEnvelope(envelope) {
      const state = await snapshotPayment(envelope.payload.paymentId)
      return withAdjudicate(
        envelope,
        state,
        paymentProjectionPolicyBundle,
        async (payload) => executeRegenerationCountIncrement(payload),
        adjudicateOptions,
      )
    },
  }
}
