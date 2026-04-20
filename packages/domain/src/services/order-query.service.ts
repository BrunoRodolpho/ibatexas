// OrderQueryService — read operations for order projections.
//
// All order reads (admin list, customer history, order detail) go through
// this service. The projection table is the source of truth for reads.

import { prisma } from "../client.js"
import type { OrderFulfillmentStatus as PrismaFulfillmentStatus } from "../generated/prisma-client/client.js"
import type { OrderProjection, OrderStatusHistory } from "../generated/prisma-client/client.js"

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
  /** Get a single order projection with audit history. */
  getById(orderId: string, opts?: { historyLimit?: number }): Promise<OrderProjectionWithHistory | null>

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
      return prisma.orderProjection.findUnique({
        where: { id: orderId },
        include: {
          statusHistory: {
            orderBy: { createdAt: "asc" },
            take: opts?.historyLimit ?? 200,
          },
        },
      })
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
