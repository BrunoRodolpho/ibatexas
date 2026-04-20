// PaymentCommandService — write operations for payment projections.
//
// Mirrors OrderCommandService pattern: optimistic concurrency, validated
// transitions, append-only audit trail.
//
// INVARIANT: One active (non-terminal) payment per order at any time.
// Retry/regeneration creates a new Payment row; old one stays terminal.

import { prisma } from "../client.js"
import type { PrismaClient } from "../generated/prisma-client/client.js"
import type { PaymentStatus as PrismaPaymentStatus, OrderActor as PrismaActor } from "../generated/prisma-client/client.js"
import {
  canTransitionPayment,
  isTerminalPaymentStatus,
  TERMINAL_PAYMENT_STATUSES,
  type PaymentStatus,
} from "@ibatexas/types"

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
   * Create a new payment for an order.
   * Enforces single active payment constraint.
   *
   * @throws ActivePaymentExistsError if order already has a non-terminal payment
   */
  create(data: CreatePaymentInput): Promise<{ id: string; version: number }>

  /**
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
   * Reconcile payment status from a Stripe webhook event.
   * Guards: idempotency, terminal state, switching_method, out-of-order, ownership.
   * Returns null if skipped.
   */
  reconcileFromWebhook(
    paymentId: string,
    input: ReconcileFromWebhookInput,
  ): Promise<{ version: number } | null>

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

export function createPaymentCommandService(log?: Logger): PaymentCommandService {
  // Terminal status values for Prisma queries
  const terminalValues = TERMINAL_PAYMENT_STATUSES as unknown as string[]

  return {
    async create(data) {
      return prisma.$transaction(async (tx: TxClient) => {
        // Enforce single active payment per order
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

        // Record initial status in history
        await tx.paymentStatusHistory.create({
          data: {
            paymentId: payment.id,
            fromStatus: initialStatus,
            toStatus: initialStatus,
            actor: "system" as PrismaActor,
            version: 1,
          },
        })

        // Update OrderProjection.currentPaymentId
        await tx.orderProjection.update({
          where: { id: data.orderId },
          data: { currentPaymentId: payment.id },
        })

        return { id: payment.id, version: 1 }
      })
    },

    async transitionStatus(paymentId, input) {
      return prisma.$transaction(async (tx: TxClient) => {
        const payment = await tx.payment.findUnique({
          where: { id: paymentId },
        })

        if (!payment) {
          throw new PaymentNotFoundError(paymentId)
        }

        // Optimistic concurrency check
        if (input.expectedVersion !== undefined && payment.version !== input.expectedVersion) {
          throw new PaymentConcurrencyError(paymentId, input.expectedVersion, payment.version)
        }

        // Validate transition
        const from = payment.status as PaymentStatus
        const to = input.newStatus
        if (!canTransitionPayment(from, to)) {
          throw new InvalidPaymentTransitionError(paymentId, from, to)
        }

        const newVersion = payment.version + 1

        // Update payment
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: to as PrismaPaymentStatus,
            version: newVersion,
          },
        })

        // Record in audit history
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

        return {
          version: newVersion,
          previousStatus: from,
          newStatus: to,
        }
      })
    },

    async reconcileFromWebhook(paymentId, input) {
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
      })

      if (!payment) return null

      // Terminal state — no resurrection
      if (isTerminalPaymentStatus(payment.status as PaymentStatus)) {
        log?.warn?.(
          { paymentId, currentStatus: payment.status, attemptedStatus: input.newStatus },
          "[payment-command] reconcile: payment is terminal — skipping",
        )
        return null
      }

      // Switching method — don't interfere
      if (payment.status === "switching_method") {
        log?.warn?.(
          { paymentId, currentStatus: payment.status },
          "[payment-command] reconcile: payment is switching method — skipping",
        )
        return null
      }

      // Out-of-order event check
      if (input.stripeEventTimestamp && payment.lastStripeEventTs) {
        if (input.stripeEventTimestamp <= payment.lastStripeEventTs) {
          log?.warn?.(
            { paymentId, eventTs: input.stripeEventTimestamp, lastTs: payment.lastStripeEventTs },
            "[payment-command] reconcile: out-of-order event — skipping",
          )
          return null
        }
      }

      // Ownership validation
      if (input.expectedOrderId && payment.orderId !== input.expectedOrderId) {
        log?.warn?.(
          { paymentId, expectedOrderId: input.expectedOrderId, actualOrderId: payment.orderId },
          "[payment-command] reconcile: order ID mismatch — quarantining",
        )
        return null
      }

      // Already at target status
      if (payment.status === input.newStatus) return null

      // Validate transition
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
  }
}
