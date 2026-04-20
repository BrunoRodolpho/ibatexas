// OrderEventLogService — append-only event log for order domain events.
//
// Best-effort writes: failures are logged, never thrown.
// Idempotency: upsert on composite idempotencyKey (orderId:eventType:discriminator).
// This is a pure observability/replay layer — it does NOT replace OrderProjection
// or OrderStatusHistory.

import { prisma } from "../client.js"

// ── Types ───────────────────────────────────────────────────────────────────

export interface AppendEventInput {
  orderId: string
  eventType: string
  /** Discriminator for idempotency (version, chargeId, disputeId, etc.) */
  discriminator: string
  /** Full event payload — stored verbatim as JSON */
  payload: Record<string, unknown>
  /** Event timestamp (ISO string or Date). Falls back to now() if missing. */
  timestamp: string | Date
}

export interface OrderEventLogService {
  /** Append an event to the log. Fire-and-forget — never throws. */
  append(input: AppendEventInput): Promise<void>
  /** Query events for an order, ordered by timestamp asc. */
  getByOrderId(orderId: string, opts?: { limit?: number; offset?: number }): Promise<OrderEventLogRow[]>
  /** Query events by type across all orders, ordered by timestamp desc. */
  getByEventType(eventType: string, opts?: { limit?: number; offset?: number }): Promise<OrderEventLogRow[]>
}

export interface OrderEventLogRow {
  id: string
  orderId: string
  eventType: string
  idempotencyKey: string
  payload: unknown
  timestamp: Date
  createdAt: Date
}

type Logger = { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }

// ── Factory ─────────────────────────────────────────────────────────────────

export function createOrderEventLogService(log?: Logger): OrderEventLogService {
  return {
    async append(input) {
      const idempotencyKey = `${input.orderId}:${input.eventType}:${input.discriminator}`
      try {
        await prisma.orderEventLog.upsert({
          where: { idempotencyKey },
          create: {
            orderId: input.orderId,
            eventType: input.eventType,
            idempotencyKey,
            payload: input.payload as object,
            timestamp: new Date(input.timestamp),
          },
          update: {}, // no-op on duplicate — immutable
        })
      } catch (err) {
        // Fire-and-forget: log, never throw
        log?.error?.(
          { order_id: input.orderId, event_type: input.eventType, error: String(err) },
          "[order-event-log] append failed",
        )
      }
    },

    async getByOrderId(orderId, opts) {
      return prisma.orderEventLog.findMany({
        where: { orderId },
        orderBy: { timestamp: "asc" },
        take: opts?.limit ?? 100,
        skip: opts?.offset ?? 0,
      })
    },

    async getByEventType(eventType, opts) {
      return prisma.orderEventLog.findMany({
        where: { eventType },
        orderBy: { timestamp: "desc" },
        take: opts?.limit ?? 50,
        skip: opts?.offset ?? 0,
      })
    },
  }
}
