// OrderQueryService — read operations for order projections.
//
// All order reads (admin list, customer history, order detail) go through
// this service. The projection table is the source of truth for reads.

import { prisma } from "../client.js"
import type { OrderFulfillmentStatus as PrismaFulfillmentStatus, OrderProjection, OrderStatusHistory } from "../generated/prisma-client/client.js"

// ── Types ───────────────────────────────────────────────────────────────────

export interface OrderProjectionWithHistory extends OrderProjection {
  statusHistory: OrderStatusHistory[]
}

interface ListResult {
  orders: OrderProjection[]
  count: number
}

interface ListAllInput {
  fulfillmentStatus?: string
  paymentStatus?: string
  dateFrom?: Date
  dateTo?: Date
  limit?: number
  offset?: number
}

interface ListByCustomerInput {
  limit?: number
  offset?: number
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface OrderQueryService {
  /**
   * Get a single order projection with audit history.
   *
   * Owner-scoping (SDD §N P0-3, Inv 2/13): when `opts.customerId` is provided
   * the read is `customer_scoped` — the projection is returned ONLY if its
   * `customerId` matches; a non-owner OR an order with NULL owner attribution
   * resolves to `null` (Inv 2: "no owner" ≠ "any owner" → REFUSED, never
   * leaked). When `customerId` is omitted the read is unscoped — the legitimate
   * internal/staff/system path (admin, projection builders, subscribers, jobs).
   */
  getById(
    orderId: string,
    opts?: { historyLimit?: number; customerId?: string },
  ): Promise<OrderProjectionWithHistory | null>

  /** List orders for a customer, ordered by medusaCreatedAt desc. */
  listByCustomer(customerId: string, input?: ListByCustomerInput): Promise<ListResult>

  /** Admin: list all orders with optional filters, paginated. */
  listAll(input?: ListAllInput): Promise<ListResult>

  /** Get full status history for an order (paginated). */
  getStatusHistory(orderId: string, opts?: { limit?: number; offset?: number }): Promise<OrderStatusHistory[]>
}

export function createOrderQueryService(): OrderQueryService {
  return {
    async getById(orderId, opts) {
      const order = await prisma.orderProjection.findUnique({
        where: { id: orderId },
        include: {
          statusHistory: {
            orderBy: { createdAt: "asc" },
            take: opts?.historyLimit ?? 200,
          },
        },
      })

      // Owner-scoping (SDD §N P0-3, Inv 2/13). When a customerId is supplied the
      // read is customer_scoped: only the owner may see the projection. A NULL
      // owner never matches a supplied customerId, so an unattributed order is
      // REFUSED rather than leaked (Inv 2: "no owner" ≠ "any owner"). Returning
      // null keeps the existing not-found contract — callers already handle it.
      if (opts?.customerId !== undefined && order?.customerId !== opts.customerId) {
        return null
      }

      return order
    },

    async listByCustomer(customerId, input) {
      const limit = input?.limit ?? 20
      const offset = input?.offset ?? 0

      const [orders, count] = await prisma.$transaction([
        prisma.orderProjection.findMany({
          where: { customerId },
          orderBy: { medusaCreatedAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.orderProjection.count({
          where: { customerId },
        }),
      ])

      return { orders, count }
    },

    async listAll(input) {
      const limit = input?.limit ?? 20
      const offset = input?.offset ?? 0

      const where: Record<string, unknown> = {}
      if (input?.fulfillmentStatus) {
        where.fulfillmentStatus = input.fulfillmentStatus as PrismaFulfillmentStatus
      }
      if (input?.paymentStatus) {
        where.paymentStatus = input.paymentStatus
      }
      if (input?.dateFrom || input?.dateTo) {
        const dateFilter: Record<string, Date> = {}
        if (input.dateFrom) dateFilter.gte = input.dateFrom
        if (input.dateTo) dateFilter.lte = input.dateTo
        where.medusaCreatedAt = dateFilter
      }

      const [orders, count] = await prisma.$transaction([
        prisma.orderProjection.findMany({
          where,
          orderBy: { medusaCreatedAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.orderProjection.count({ where }),
      ])

      return { orders, count }
    },

    async getStatusHistory(orderId, opts) {
      return prisma.orderStatusHistory.findMany({
        where: { orderId },
        orderBy: { createdAt: "asc" },
        take: opts?.limit ?? 50,
        skip: opts?.offset ?? 0,
      })
    },
  }
}
