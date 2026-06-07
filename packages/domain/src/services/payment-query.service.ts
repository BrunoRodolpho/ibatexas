// PaymentQueryService — read operations for payment projections.
//
// Mirrors OrderQueryService pattern: all payment reads go through this
// service. The Payment table is the source of truth for billing reads.

import { prisma } from "../client.js"
import type {
  Payment,
  PaymentStatusHistory,
  PaymentStatus as PrismaPaymentStatus,
} from "../generated/prisma-client/client.js"
import { TERMINAL_PAYMENT_STATUSES } from "@ibatexas/types"

// ── Types ───────────────────────────────────────────────────────────────────

export interface PaymentWithHistory extends Payment {
  statusHistory: PaymentStatusHistory[]
}

interface ListByOrderResult {
  payments: Payment[]
  count: number
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface PaymentQueryService {
  /** Get a single payment with its audit history. */
  getById(paymentId: string, opts?: { historyLimit?: number }): Promise<PaymentWithHistory | null>

  /** Get the active (non-terminal) payment for an order, with history. */
  getActiveByOrderId(orderId: string, opts?: { historyLimit?: number }): Promise<PaymentWithHistory | null>

  /**
   * Batched active-payment lookup (N1PAY): the most-recent non-terminal payment
   * for each order id, resolved in ONE query instead of N. Mirrors
   * getActiveByOrderId's per-order semantics (createdAt-desc + terminal-status
   * exclusion); omits the statusHistory include since list callers don't read it.
   * Orders with no active payment are absent from the returned map.
   */
  getActiveByOrderIds(orderIds: ReadonlyArray<string>): Promise<Map<string, Payment>>

  /** List all payment attempts for an order (most recent first). */
  listByOrderId(orderId: string, opts?: { limit?: number; offset?: number }): Promise<ListByOrderResult>

  /** Get full status history for a payment (paginated, chronological). */
  getStatusHistory(paymentId: string, opts?: { limit?: number; offset?: number }): Promise<PaymentStatusHistory[]>

  /** Look up a payment by its Stripe PaymentIntent ID. */
  getByStripePaymentIntentId(stripePaymentIntentId: string): Promise<Payment | null>
}

export function createPaymentQueryService(): PaymentQueryService {
  const terminalValues = TERMINAL_PAYMENT_STATUSES as unknown as string[]

  return {
    async getById(paymentId, opts) {
      return prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          statusHistory: {
            orderBy: { createdAt: "asc" },
            take: opts?.historyLimit ?? 200,
          },
        },
      })
    },

    async getActiveByOrderId(orderId, opts) {
      return prisma.payment.findFirst({
        where: {
          orderId,
          status: { notIn: terminalValues as PrismaPaymentStatus[] },
        },
        orderBy: { createdAt: "desc" },
        include: {
          statusHistory: {
            orderBy: { createdAt: "asc" },
            take: opts?.historyLimit ?? 200,
          },
        },
      })
    },

    async getActiveByOrderIds(orderIds) {
      if (orderIds.length === 0) return new Map<string, Payment>()
      const rows = await prisma.payment.findMany({
        where: {
          orderId: { in: orderIds as string[] },
          status: { notIn: terminalValues as PrismaPaymentStatus[] },
        },
        orderBy: { createdAt: "desc" },
      })
      // Rows are createdAt-desc; the FIRST row seen per orderId is the
      // most-recent non-terminal payment — identical to getActiveByOrderId's
      // findFirst({ orderBy: createdAt desc }) applied per order.
      const byOrder = new Map<string, Payment>()
      for (const row of rows) {
        if (!byOrder.has(row.orderId)) byOrder.set(row.orderId, row)
      }
      return byOrder
    },

    async listByOrderId(orderId, opts) {
      const limit = opts?.limit ?? 20
      const offset = opts?.offset ?? 0

      const [payments, count] = await prisma.$transaction([
        prisma.payment.findMany({
          where: { orderId },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.payment.count({
          where: { orderId },
        }),
      ])

      return { payments, count }
    },

    async getStatusHistory(paymentId, opts) {
      return prisma.paymentStatusHistory.findMany({
        where: { paymentId },
        orderBy: { createdAt: "asc" },
        take: opts?.limit ?? 50,
        skip: opts?.offset ?? 0,
      })
    },

    async getByStripePaymentIntentId(stripePaymentIntentId) {
      return prisma.payment.findUnique({
        where: { stripePaymentIntentId },
      })
    },
  }
}
