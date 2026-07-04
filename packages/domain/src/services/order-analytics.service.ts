// OrderAnalyticsService — read-only order analytics (NEW-013 + NEW-033).
//
// Three aggregations over a LOCAL-date range, computed from the EXISTING
// projections (OrderProjection + Payment) joined to recipe/BOM COGS — NO
// mutations, NO new tables, NO schema change:
//   • getTopItems        → most-ordered products (best-sellers) over the range
//   • getRefundAnalytics → refund count + total + per-day trend over the range
//   • getMargins         → per-product margin (revenue − COGS) over the range
//
// MARGINS (NEW-033): NEW-035 added the Recipe/BOM + per-ingredient
// `costCentavosPerUnit`, so per-dish COGS now EXISTS (`computeRecipeCogs`). The
// earlier scope note here — "deliberately does NOT compute margins because no
// cost field exists" — is therefore NO LONGER TRUE. Margins ARE now computed, by
// joining each product's in-window REVENUE (Σ quantity × priceInCentavos, the
// SAME per-product aggregation getTopItems uses — see aggregateRevenueByProduct)
// to its per-serving COGS. A product's margin is UNKNOWN — never guessed/partial
// — when it has NO recipe, OR a recipe with an INCOMPLETE COGS (`anyCostMissing`:
// some ingredient has a null unit cost); such rows carry null cost/margin and are
// EXCLUDED from the totals (a coverage signal). This mirrors the COGS null-cost
// discipline: a missing input degrades to UNKNOWN, never a confident wrong number.
// A loss (negative margin) is a REAL result and is never clamped to zero.
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
// Sibling domain services (value imports) — both are already eagerly loaded via
// @ibatexas/domain's index, so importing them here adds no new runtime surface.
// getMargins joins in-window revenue to per-dish COGS from the recipe/BOM (NEW-035).
import { createRecipeService, computeRecipeCogs, type RecipeCogs } from "./recipe.service.js"
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

/**
 * One margin row — a product's in-window revenue joined to its per-dish COGS.
 * MONEY = INTEGER CENTAVOS everywhere; `marginPermille` is an integer per-mille
 * (0.1% precision), never a stored float. When `cogsKnown` is false (no recipe OR
 * an incomplete cost-missing recipe) the margin is UNKNOWN: `cogsCentavos`,
 * `marginCentavos` and `marginPermille` are all `null` — never a guessed number.
 */
export interface MarginRow {
  /** Product id (OrderProjection line-item productId). */
  readonly productId: string
  /** Product title as stored on the line item (first non-empty seen). */
  readonly title: string
  /** Σ line-item quantity across the range (the COGS multiplier). */
  readonly quantity: number
  /** In-window revenue: Σ (quantity × priceInCentavos) (centavos). */
  readonly revenueCentavos: number
  /** True iff the product has a recipe AND its COGS is complete (anyCostMissing === false). */
  readonly cogsKnown: boolean
  /** perServingCogsCentavos × quantity (integer centavos); `null` when COGS is UNKNOWN. */
  readonly cogsCentavos: number | null
  /** revenueCentavos − cogsCentavos (integer centavos; MAY be negative — a loss); `null` when UNKNOWN. */
  readonly marginCentavos: number | null
  /** Integer per-mille of revenue = round(margin × 1000 / revenue); `null` when UNKNOWN or revenue is 0. */
  readonly marginPermille: number | null
}

/**
 * Totals over ONLY the `cogsKnown` rows — a coverage signal: how much of the
 * window's product revenue has margin data. UNKNOWN-COGS rows contribute to
 * `productsWithUnknownCogs` but NOT to the money sums (they'd corrupt them).
 */
export interface MarginTotals {
  /** Σ revenueCentavos over the known-COGS rows only (centavos). */
  readonly revenueCentavos: number
  /** Σ cogsCentavos over the known-COGS rows only (centavos). */
  readonly cogsCentavos: number
  /** Σ marginCentavos over the known-COGS rows only (centavos; may be negative). */
  readonly marginCentavos: number
  /** Number of in-window products with a KNOWN (complete) COGS. */
  readonly productsWithKnownCogs: number
  /** Number of in-window products with an UNKNOWN COGS (no recipe or cost-missing). */
  readonly productsWithUnknownCogs: number
}

/** Read-model of per-product margins over a local-date range. */
export interface MarginsReport {
  /** The requested range, echoed back. */
  readonly range: AnalyticsRange
  /** IANA timezone used to resolve the range boundaries. */
  readonly timezone: string
  /** Inclusive UTC start of the range (ISO string, `gte`). */
  readonly windowStart: string
  /** Exclusive UTC end of the range (ISO string, `lt`). */
  readonly windowEnd: string
  /** Per-product margin rows, sorted by marginCentavos desc with UNKNOWN rows last (productId asc tie-break). */
  readonly rows: readonly MarginRow[]
  /** Aggregates over the known-COGS rows only (a coverage signal). */
  readonly totals: MarginTotals
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

  /**
   * Per-product margins over the [from, to) local-date window: each product's
   * in-window revenue (Σ quantity × priceInCentavos) joined to its per-serving
   * COGS (from the recipe/BOM, NEW-035). Margin = revenue − COGS (may be a loss).
   * A product with no recipe, or a recipe with an incomplete (cost-missing) COGS,
   * is UNKNOWN — null cost/margin, excluded from totals. Rows sort by marginCentavos
   * desc with UNKNOWN last (productId asc tie-break); totals cover only known rows.
   * @param range { from, to } — YYYY-MM-DD, from inclusive / to exclusive
   * @param opts.timezone IANA zone; defaults to RESTAURANT_TIMEZONE then America/Sao_Paulo
   */
  getMargins(range: AnalyticsRange, opts?: { timezone?: string }): Promise<MarginsReport>
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

/** Per-product revenue aggregate over a set of in-window orders (the shared row). */
interface ProductRevenueAgg {
  productId: string
  title: string
  quantity: number
  orderCount: number
  grossCentavos: number
}

/**
 * Aggregate the in-window orders' line items per productId — the ONE revenue loop,
 * shared by getTopItems (best-sellers) and getMargins (revenue side of the margin).
 * Per product: `quantity` = Σ line quantity, `grossCentavos` = Σ (quantity × price),
 * `orderCount` = distinct orders containing the product (a product on two lines of
 * ONE order counts that order once, via the per-order Set), `title` = first non-empty.
 * A line item with no productId can't be attributed and is skipped.
 */
function aggregateRevenueByProduct(orders: readonly { itemsJson: unknown }[]): Map<string, ProductRevenueAgg> {
  const agg = new Map<string, ProductRevenueAgg>()
  for (const order of orders) {
    const items = parseLineItems(order.itemsJson)
    const seenInThisOrder = new Set<string>()
    for (const item of items) {
      const productId = item.productId
      if (!productId) continue // a line item with no product id can't be attributed
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
  return agg
}

/** Load the in-window orders' line items and aggregate revenue per productId (DRY). */
async function loadRevenueByProduct(windowStart: Date, windowEnd: Date): Promise<Map<string, ProductRevenueAgg>> {
  // Orders CREATED in-window; we only need their line items.
  const orders = await prisma.orderProjection.findMany({
    where: { medusaCreatedAt: { gte: windowStart, lt: windowEnd } },
    select: { itemsJson: true },
  })
  return aggregateRevenueByProduct(orders)
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

      // Shared per-product revenue aggregation (same loop getMargins uses).
      const agg = await loadRevenueByProduct(windowStart, windowEnd)

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

    async getMargins(range, opts) {
      assertYmd("getMargins: range.from", range.from)
      assertYmd("getMargins: range.to", range.to)
      const timezone = resolveTimezone(opts)
      const windowStart = localDayStartUtc(range.from, timezone)
      const windowEnd = localDayStartUtc(range.to, timezone)

      // Revenue side: the SAME per-product aggregation getTopItems uses (DRY).
      const revenueByProduct = await loadRevenueByProduct(windowStart, windowEnd)

      // COGS side: build the per-product COGS map ONCE (NO N+1). One list() query
      // pulls every recipe-with-lines; computeRecipeCogs is a pure per-recipe fold.
      // A product's COGS is KNOWN only if it has a recipe AND anyCostMissing === false.
      const recipes = await createRecipeService().list()
      const cogsByProduct = new Map<string, RecipeCogs>()
      for (const recipe of recipes) {
        cogsByProduct.set(recipe.medusaProductId, computeRecipeCogs(recipe))
      }

      const rows: MarginRow[] = []
      const totals = {
        revenueCentavos: 0,
        cogsCentavos: 0,
        marginCentavos: 0,
        productsWithKnownCogs: 0,
        productsWithUnknownCogs: 0,
      }

      for (const entry of revenueByProduct.values()) {
        const { productId, title, quantity, grossCentavos: revenueCentavos } = entry
        const cogs = cogsByProduct.get(productId)

        // KNOWN only with a recipe whose COGS is complete (no null-cost ingredient).
        // Inlined so TS narrows `cogs` to non-undefined inside the branch.
        if (cogs !== undefined && cogs.anyCostMissing === false) {
          // COGS scales with quantity sold; integer centavos (perServing already integer).
          const cogsCentavos = cogs.perServingCogsCentavos * quantity
          // Margin MAY be negative — a loss is real, never clamped.
          const marginCentavos = revenueCentavos - cogsCentavos
          // Integer per-mille (0.1% precision); null when revenue is 0 (undefined ratio).
          const marginPermille =
            revenueCentavos > 0 ? Math.round((marginCentavos * 1000) / revenueCentavos) : null
          rows.push({ productId, title, quantity, revenueCentavos, cogsKnown: true, cogsCentavos, marginCentavos, marginPermille })
          // Totals aggregate ONLY the known rows (a revenue-coverage signal).
          totals.revenueCentavos += revenueCentavos
          totals.cogsCentavos += cogsCentavos
          totals.marginCentavos += marginCentavos
          totals.productsWithKnownCogs += 1
        } else {
          // UNKNOWN: no recipe OR a cost-missing recipe → null cost/margin, never guessed.
          rows.push({ productId, title, quantity, revenueCentavos, cogsKnown: false, cogsCentavos: null, marginCentavos: null, marginPermille: null })
          totals.productsWithUnknownCogs += 1
        }
      }

      // Sort by marginCentavos DESC with UNKNOWN (null) rows LAST; productId asc tie-break.
      rows.sort((a, b) => {
        if (a.marginCentavos === null && b.marginCentavos === null) {
          return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0
        }
        if (a.marginCentavos === null) return 1 // a (unknown) sorts after b
        if (b.marginCentavos === null) return -1 // b (unknown) sorts after a
        return (
          b.marginCentavos - a.marginCentavos ||
          (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)
        )
      })

      return {
        range: { from: range.from, to: range.to },
        timezone,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        rows,
        totals,
      }
    },
  }
}
