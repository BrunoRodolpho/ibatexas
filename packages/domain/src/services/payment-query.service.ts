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

interface ListByCustomerInput {
  limit?: number
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface PaymentQueryService {
  /** Get a single payment with its audit history. */
  getById(paymentId: string, opts?: { historyLimit?: number }): Promise<PaymentWithHistory | null>

  /**
   * List a customer's payments across ALL their orders, most-recent first.
   *
   * Owner-scoping (SDD §N, Inv 2/13): a `Payment` carries no `customerId` — the
   * owner is the parent order's `customerId`, so the read is scoped by the
   * `where: { order: { customerId } }` join. This is billing HISTORY, so it
   * includes TERMINAL statuses (settled/refunded/failed) — it deliberately does
   * NOT reuse the terminal-EXCLUDING getActiveByOrder* path (that would drop
   * exactly the settled payments a history must show). Single indexed query,
   * `take` bounded (default 20). The caller is responsible for asserting an
   * authenticated `customerId` before calling — `customerId: undefined` in the
   * join is a NO-OP filter (Inv 2: "no owner" ≠ "any owner").
   */
  listByCustomer(customerId: string, opts?: ListByCustomerInput): Promise<Payment[]>

  /**
   * Count a customer's payments across ALL their orders — the honest total `N`
   * behind a bounded {@link listByCustomer} page (so a caller can say "showing
   * the most recent K of N"). Uses the IDENTICAL owner-scoping join
   * (`where: { order: { customerId } }`), so the same IDOR discipline applies:
   * `customerId: undefined` is a NO-OP filter (Inv 2) — the caller MUST assert an
   * authenticated customerId first.
   */
  countByCustomer(customerId: string): Promise<number>

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

  /**
   * BKL-159 falsifier probes: predicate-shaped findFirst existence reads for the
   * claims falsifier arm — no $transaction, no count, and complete by
   * construction (a where-clause sees EVERY row, unlike a page of listByOrderId).
   * Most-recent match returned for audit fields; null = no such signal.
   */
  findRefundBearingByOrderId(orderId: string): Promise<Payment | null>

  /** BKL-159: most-recent disputed (chargeback-signal) payment for an order, or null. */
  findDisputedByOrderId(orderId: string): Promise<Payment | null>

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

    async listByCustomer(customerId, opts) {
      const limit = opts?.limit ?? 20
      return prisma.payment.findMany({
        // Owner scope via the OrderProjection join — a Payment has no customerId.
        // ALL statuses: history must include terminal (settled/refunded/failed)
        // rows, so there is intentionally NO `status.notIn` terminal filter here.
        where: { order: { customerId } },
        orderBy: { createdAt: "desc" },
        take: limit,
      })
    },

    async countByCustomer(customerId) {
      // SAME owner-scoping join as listByCustomer — the honest total behind a page.
      return prisma.payment.count({
        where: { order: { customerId } },
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

    async findRefundBearingByOrderId(orderId) {
      return prisma.payment.findFirst({
        where: {
          orderId,
          OR: [
            { refundedAmountCentavos: { gt: 0 } },
            { status: { in: ["refunded", "partially_refunded"] as PrismaPaymentStatus[] } },
          ],
        },
        orderBy: { createdAt: "desc" },
      })
    },

    async findDisputedByOrderId(orderId) {
      return prisma.payment.findFirst({
        where: { orderId, status: "disputed" as PrismaPaymentStatus },
        orderBy: { createdAt: "desc" },
      })
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
