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
import type { PrismaClient } from "../generated/prisma-client/client.js"
import type { PaymentStatus as PrismaPaymentStatus, OrderActor as PrismaActor } from "../generated/prisma-client/client.js"
import {
  canTransitionPayment,
  isTerminalPaymentStatus,
  TERMINAL_PAYMENT_STATUSES,
  type PaymentStatus,
} from "@ibatexas/types"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import {
  withAdjudicate,
  type AdjudicatedResult,
} from "./__shared__/with-adjudicate.js"
import {
  paymentProjectionPolicyBundle,
  type PaymentCreatePayload,
  type PaymentStatusTransitionPayload,
  type PaymentStatusReconcilePayload,
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
  /**
   * @deprecated Use `createFromEnvelope(envelope)` instead.
   * Create a new payment for an order. Enforces single-active-payment.
   *
   * @throws ActivePaymentExistsError if order already has a non-terminal payment
   */
  create(data: CreatePaymentInput): Promise<{ id: string; version: number }>

  /**
   * Envelope-typed entry point for `payment.create`. SYSTEM-only.
   */
  createFromEnvelope(
    envelope: IntentEnvelope<"payment.create", PaymentCreatePayload>,
  ): Promise<AdjudicatedResult<{ id: string; version: number }>>

  /**
   * @deprecated Use `transitionStatusFromEnvelope(envelope)` instead.
   * Transition payment status with validation and optimistic concurrency.
   *
   * @throws PaymentConcurrencyError if expectedVersion doesn't match
   * @throws PaymentNotFoundError if payment not found
   * @throws InvalidPaymentTransitionError if transition not allowed
   */
  transitionStatus(
    paymentId: string,
    input: TransitionPaymentStatusInput,
  ): Promise<{ version: number; previousStatus: string; newStatus: string }>

  /**
   * Envelope-typed entry point for `payment.status.transition`.
   */
  transitionStatusFromEnvelope(
    envelope: IntentEnvelope<"payment.status.transition", PaymentStatusTransitionPayload>,
  ): Promise<
    AdjudicatedResult<{ version: number; previousStatus: string; newStatus: string }>
  >

  /**
   * @deprecated Use `reconcileFromWebhookFromEnvelope(envelope)` instead.
   * Reconcile payment status from a Stripe webhook event.
   */
  reconcileFromWebhook(
    paymentId: string,
    input: ReconcileFromWebhookInput,
  ): Promise<{ version: number } | null>

  /**
   * Envelope-typed entry point for `payment.status.reconcile`. SYSTEM-only.
   * Webhook-driven reconciliation: idempotency, terminal-state guard,
   * out-of-order, ownership preserved inside the executor.
   */
  reconcileFromWebhookFromEnvelope(
    envelope: IntentEnvelope<"payment.status.reconcile", PaymentStatusReconcilePayload>,
  ): Promise<AdjudicatedResult<{ version: number } | null>>

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
}

export function createPaymentCommandService(
  log?: Logger,
  options?: PaymentCommandServiceOptions,
): PaymentCommandService {
  // Terminal status values for Prisma queries
  const terminalValues = TERMINAL_PAYMENT_STATUSES as unknown as string[]

  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    log: log ?? options?.log,
  } as const

  // ── Legacy executor: create ────────────────────────────────────────
  const executeCreate = async (
    data: CreatePaymentInput,
  ): Promise<{ id: string; version: number }> => {
    return prisma.$transaction(async (tx: TxClient) => {
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

    const newVersion = payment.version + 1

    await prisma.$transaction(async (tx: TxClient) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: input.newStatus as PrismaPaymentStatus,
          version: newVersion,
          lastStripeEventTs: input.stripeEventTimestamp ?? undefined,
        },
      })

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
    })

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
      },
    }
  }

  return {
    // ── Legacy bare-arg methods ─────────────────────────────────────

    async create(data) {
      return executeCreate(data)
    },

    async transitionStatus(paymentId, input) {
      return executeTransition(paymentId, input)
    },

    async reconcileFromWebhook(paymentId, input) {
      return executeReconcile(paymentId, input)
    },

    async findActiveByOrderId(orderId) {
      const payment = await prisma.payment.findFirst({
        where: {
          orderId,
          status: { notIn: terminalValues as PrismaPaymentStatus[] },
        },
        select: { id: true, status: true, version: true },
        orderBy: { createdAt: "desc" },
      })
      return payment
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
            ...(payload.stripePaymentIntentId !== undefined
              ? { stripePaymentIntentId: payload.stripePaymentIntentId }
              : {}),
            ...(payload.pixExpiresAt !== undefined
              ? { pixExpiresAt: new Date(payload.pixExpiresAt) }
              : {}),
            ...(payload.idempotencyKey !== undefined
              ? { idempotencyKey: payload.idempotencyKey }
              : {}),
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
            ...(payload.stripeEventTimestamp !== undefined
              ? { stripeEventTimestamp: new Date(payload.stripeEventTimestamp) }
              : {}),
            ...(payload.expectedOrderId !== undefined
              ? { expectedOrderId: payload.expectedOrderId }
              : {}),
          }
          return executeReconcile(payload.paymentId, input)
        },
        adjudicateOptions,
      )
    },
  }
}
