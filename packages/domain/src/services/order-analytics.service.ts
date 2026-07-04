// OrderAnalyticsService — read-only order analytics (NEW-013, BUILDABLE SLICE).
//
// Two aggregations over a LOCAL-date range, computed from the EXISTING
// projections (OrderProjection + Payment) — NO mutations, NO new tables, NO
// schema change:
//   • getTopItems        → most-ordered products (best-sellers) over the range
//   • getRefundAnalytics → refund count + total + per-day trend over the range
//
// SCOPE BOUNDARY: this deliberately does NOT compute margins / COGS. There is
// no per-item cost field anywhere in the schema (the only `cost` column is the
// LLM-token `estimatedCostUsd` telemetry, ERDS-059 — unrelated to product COGS).
// Margins depend on NEW-003 (ingredient inventory + COGS), which does not
// exist; computing them would require inventing cost data. So this slice ships
// only the two aggregations that are derivable from existing order data.
//
// Range semantics mirror DayCloseService but over a multi-day window: the range
// is [from, to) — `from` INCLUSIVE, `to` EXCLUSIVE — resolved to the local-day
// boundaries in `timezone`. Everything is scoped to the orders CREATED in that
// window (OrderProjection.medusaCreatedAt — the real, indexed order-creation
// instant); refunds are the ones attached to those orders, owner-joined via
// `where: { order: { medusaCreatedAt: … } }`, the same idiom day-close uses.
//
// "Settled" (money captured) semantics are IDENTICAL to day-close.service.ts: a
// refund can only ride on a captured row, so refunds are counted over the
// captured status set (paid / partially_refunded / refunded, never disputed)
// with `refundedAmountCentavos > 0`, and the magnitude is `refundedAmountCentavos`.

import { prisma } from "../client.js"
import {
  SETTLED_PAYMENT_STATUSES_IN,
  assertYmd,
  localDateStr,
  localDayStartUtc,
  resolveTimezone,
} from "./__shared__/day-window.js"

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TOP_ITEMS_LIMIT = 10

// ── Types ─────────────────────────────────────────────────────────────────────

/** A local-date range: `from` inclusive, `to` exclusive (both YYYY-MM-DD). */
export interface AnalyticsRange {
  readonly from: string
  readonly to: string
}

/** One best-seller row — aggregated across all in-window orders. */
export interface TopItem {
  /** Product id (OrderEventItem.productId). */
  readonly productId: string
  /** Product title as stored on the line item (first non-empty seen). */
  readonly title: string
  /** Σ line-item quantity across the range. */
  readonly quantity: number
  /** Number of distinct orders that contained this product. */
  readonly orderCount: number
  /** Σ (quantity × priceInCentavos) across the range (centavos). */
  readonly grossCentavos: number
}

/** One point in the refund trend — a single local calendar day with refunds. */
export interface RefundTrendPoint {
  /** Local calendar day (YYYY-MM-DD) of the refunded order's creation. */
  readonly date: string
  /** Σ refundedAmountCentavos for that day (centavos). */
  readonly refundedCentavos: number
  /** Number of refunded payments on that day. */
  readonly count: number
}

/** Read-model of refund activity over a local-date range. */
export interface RefundAnalytics {
  /** The requested range, echoed back. */
  readonly range: AnalyticsRange
  /** IANA timezone used to resolve the range boundaries. */
  readonly timezone: string
  /** Inclusive UTC start of the range (ISO string, `gte`). */
  readonly windowStart: string
  /** Exclusive UTC end of the range (ISO string, `lt`). */
  readonly windowEnd: string
  /** Σ refundedAmountCentavos over the range (centavos). */
  readonly totalRefundedCentavos: number
  /** Number of payments carrying a refund (refundedAmountCentavos > 0). */
  readonly refundCount: number
  /** Per-day refund trend, days-with-refunds only, sorted ascending by date. */
  readonly trend: readonly RefundTrendPoint[]
}

export interface OrderAnalyticsService {
  /**
   * Best-sellers: the most-ordered products in the [from, to) local-date window,
   * sorted desc by total quantity (ties broken by grossCentavos desc, then
   * productId asc for determinism), capped at `limit` (default 10).
   * @param range { from, to } — YYYY-MM-DD, from inclusive / to exclusive
   * @param opts.limit max rows (default 10)
   * @param opts.timezone IANA zone; defaults to RESTAURANT_TIMEZONE then America/Sao_Paulo
   */
  getTopItems(range: AnalyticsRange, opts?: { limit?: number; timezone?: string }): Promise<TopItem[]>

  /**
   * Refund analytics over the [from, to) local-date window: total refunded
   * centavos, refund count, and a per-day trend.
   * @param range { from, to } — YYYY-MM-DD, from inclusive / to exclusive
   * @param opts.timezone IANA zone; defaults to RESTAURANT_TIMEZONE then America/Sao_Paulo
   */
  getRefundAnalytics(range: AnalyticsRange, opts?: { timezone?: string }): Promise<RefundAnalytics>
}

// ── Line-item shape (the OrderProjection.itemsJson element) ────────────────────

/**
 * The narrow shape we read off each `itemsJson` element. Kept LOCAL (not a value
 * import of `@ibatexas/types`) — `itemsJson` is a Prisma `Json?` column, so it
 * arrives untyped and must be narrowed by hand regardless. Matches OrderEventItem
 * (packages/types/src/order-events.ts): { productId, variantId, title, quantity,
 * priceInCentavos }.
 */
interface LineItem {
  productId: string
  title: string
  quantity: number
  priceInCentavos: number
}

// The DST day-window + settled-status helpers live in ./__shared__/day-window.ts
// (shared with day-close.service.ts). Only the itemsJson-parse helper is local.

/** Narrow a raw `itemsJson` value to a LineItem[] (non-array → []). */
function parseLineItems(itemsJson: unknown): LineItem[] {
  if (!Array.isArray(itemsJson)) return []
  return itemsJson as LineItem[]
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createOrderAnalyticsService(): OrderAnalyticsService {
  return {
    async getTopItems(range, opts) {
      assertYmd("getTopItems: range.from", range.from)
      assertYmd("getTopItems: range.to", range.to)
      const timezone = resolveTimezone(opts)
      const limit = opts?.limit ?? DEFAULT_TOP_ITEMS_LIMIT
      const windowStart = localDayStartUtc(range.from, timezone)
      const windowEnd = localDayStartUtc(range.to, timezone)

      // Orders CREATED in-window; we only need their line items.
      const orders = await prisma.orderProjection.findMany({
        where: { medusaCreatedAt: { gte: windowStart, lt: windowEnd } },
        select: { itemsJson: true },
      })

      // Aggregate per productId. orderCount is distinct-orders-containing: a
      // product appearing on multiple line items of ONE order (e.g. two variants)
      // counts that order once (per-order Set), while quantity/gross sum all lines.
      const agg = new Map<
        string,
        { productId: string; title: string; quantity: number; orderCount: number; grossCentavos: number }
      >()

      for (const order of orders) {
        const items = parseLineItems(order.itemsJson)
        const seenInThisOrder = new Set<string>()
        for (const item of items) {
          const productId = item.productId
          if (!productId) continue // a line item with no product id can't be a "top item"
          const quantity = item.quantity ?? 0
          const priceInCentavos = item.priceInCentavos ?? 0
          let entry = agg.get(productId)
          if (!entry) {
            entry = { productId, title: item.title ?? "", quantity: 0, orderCount: 0, grossCentavos: 0 }
            agg.set(productId, entry)
          }
          entry.quantity += quantity
          entry.grossCentavos += quantity * priceInCentavos
          if (!entry.title && item.title) entry.title = item.title // keep first non-empty title
          if (!seenInThisOrder.has(productId)) {
            entry.orderCount += 1
            seenInThisOrder.add(productId)
          }
        }
      }

      return [...agg.values()]
        .sort(
          (a, b) =>
            b.quantity - a.quantity ||
            b.grossCentavos - a.grossCentavos ||
            (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
        )
        .slice(0, limit)
    },

    async getRefundAnalytics(range, opts) {
      assertYmd("getRefundAnalytics: range.from", range.from)
      assertYmd("getRefundAnalytics: range.to", range.to)
      const timezone = resolveTimezone(opts)
      const windowStart = localDayStartUtc(range.from, timezone)
      const windowEnd = localDayStartUtc(range.to, timezone)

      // Refunded payments attached to orders CREATED in-window — captured-status
      // set (same as day-close) AND refundedAmountCentavos > 0. We pull each
      // payment's order.medusaCreatedAt to bucket the trend by local day.
      const payments = await prisma.payment.findMany({
        where: {
          order: { medusaCreatedAt: { gte: windowStart, lt: windowEnd } },
          status: { in: SETTLED_PAYMENT_STATUSES_IN },
          refundedAmountCentavos: { gt: 0 },
        },
        select: {
          refundedAmountCentavos: true,
          order: { select: { medusaCreatedAt: true } },
        },
      })

      let totalRefundedCentavos = 0
      let refundCount = 0
      const byDay = new Map<string, { refundedCentavos: number; count: number }>()

      for (const p of payments) {
        const refunded = p.refundedAmountCentavos ?? 0
        if (refunded <= 0) continue // defensive; the where already filters gt: 0
        totalRefundedCentavos += refunded
        refundCount += 1
        const day = localDateStr(p.order.medusaCreatedAt, timezone)
        const bucket = byDay.get(day) ?? { refundedCentavos: 0, count: 0 }
        bucket.refundedCentavos += refunded
        bucket.count += 1
        byDay.set(day, bucket)
      }

      const trend: RefundTrendPoint[] = [...byDay.entries()]
        .map(([date, v]) => ({ date, refundedCentavos: v.refundedCentavos, count: v.count }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

      return {
        range: { from: range.from, to: range.to },
        timezone,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        totalRefundedCentavos,
        refundCount,
        trend,
      }
    },
  }
}
