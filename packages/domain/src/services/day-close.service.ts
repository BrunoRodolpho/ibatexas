// DayCloseService — read-only "caixa" / day-close reconciliation (NEW-011).
//
// Aggregates, for one LOCAL calendar day, over the EXISTING projections
// (OrderProjection + Payment) — NO mutations, NO new tables, NO schema change:
//   • orders CREATED that day        → count + gross total (centavos)
//   • settled (captured) payments    → total + per-method (pix/card/cash) breakdown
//   • refunds                        → count + total refunded (centavos) + per-method
//   • net                            → settled − refunds
//
// Day cohort: everything is scoped to the orders CREATED in the local-day window
// (OrderProjection.medusaCreatedAt — the real order-creation instant, and the
// indexed one). Payments/refunds are the ones attached to those orders, joined
// via `where: { order: { medusaCreatedAt: … } }` — the same owner-join idiom the
// PaymentQueryService uses (`where: { order: { customerId } }`). This gives ONE
// unambiguous day boundary on a real business timestamp and makes the summary
// reconcile as a coherent statement about a single order cohort:
//   "today we took N orders grossing R$X; R$Y settled (pix/card/cash); R$Z
//    refunded; net R$(Y−Z)". Every centavo is attributable to an order in-window.
//
// "Settled" (money captured) semantics mirror the repo's own PaymentStatus
// lifecycle (packages/types/src/payment-status.ts): a payment is captured once
// it reaches `paid`; `partially_refunded` and `refunded` both descend from
// `paid` in the forward-only transition matrix, so the original amount WAS
// captured on those rows too. Refund magnitude rides on `refundedAmountCentavos`
// (set by PaymentCommandService.refund.issue) and is netted out. `disputed` is
// deliberately EXCLUDED — it is contested/held, not recognized-collected; it
// carries no refund, so omitting it keeps `net = settled − refunds` sound.

import { prisma } from "../client.js"
import {
  SETTLED_PAYMENT_STATUSES_IN,
  localDayStartUtc,
  nextDayStr,
  resolveTimezone,
} from "./__shared__/day-window.js"

// ── Types ─────────────────────────────────────────────────────────────────────

/** Per-method centavo totals. Payment.method is constrained to these three. */
export interface DayCloseMethodTotals {
  readonly pix: number
  readonly card: number
  readonly cash: number
}

/** Read-model summary of one local calendar day's caixa reconciliation. */
export interface DaySummary {
  /** The local calendar day this summary covers (YYYY-MM-DD). */
  readonly date: string
  /** IANA timezone used to resolve the day boundary. */
  readonly timezone: string
  /** Inclusive UTC start of the local day (ISO string, `gte`). */
  readonly windowStart: string
  /** Exclusive UTC end of the local day (ISO string, `lt`). */
  readonly windowEnd: string
  readonly orders: {
    /** Orders created in the window. */
    readonly count: number
    /** Gross order total in centavos (Σ totalInCentavos). */
    readonly grossCentavos: number
  }
  readonly settled: {
    /** Number of settled (captured) payments. */
    readonly count: number
    /** Total captured centavos (== byMethod.pix + card + cash). */
    readonly totalCentavos: number
    /** Captured centavos per method. */
    readonly byMethod: DayCloseMethodTotals
  }
  readonly refunds: {
    /** Number of payments with a refund (refundedAmountCentavos > 0). */
    readonly count: number
    /** Total refunded centavos (== byMethod.pix + card + cash). */
    readonly totalCentavos: number
    /** Refunded centavos per method. */
    readonly byMethod: DayCloseMethodTotals
  }
  /** settled.totalCentavos − refunds.totalCentavos. */
  readonly netCentavos: number
}

export interface DayCloseService {
  /**
   * Aggregate the caixa/day-close summary for a single local calendar day.
   * @param date YYYY-MM-DD (local calendar day)
   * @param opts.timezone IANA zone; defaults to RESTAURANT_TIMEZONE env then America/Sao_Paulo
   */
  getDaySummary(date: string, opts?: { timezone?: string }): Promise<DaySummary>
}

// ── Method-bucket helper (day-close-specific; the DST day-window + settled-status
// helpers live in ./__shared__/day-window.ts, shared with order-analytics) ──────

type MutableMethodTotals = { pix: number; card: number; cash: number }

/** Map a raw Payment.method to a known bucket, or null when unrecognized. */
function methodBucket(method: string): keyof MutableMethodTotals | null {
  return method === "pix" || method === "card" || method === "cash" ? method : null
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createDayCloseService(): DayCloseService {
  return {
    async getDaySummary(date, opts) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new RangeError(`getDaySummary: date must be YYYY-MM-DD, got "${date}"`)
      }
      const timezone = resolveTimezone(opts)
      const windowStart = localDayStartUtc(date, timezone)
      const windowEnd = localDayStartUtc(nextDayStr(date), timezone)

      const [orders, payments] = await Promise.all([
        // Orders CREATED in-window. medusaCreatedAt is the real (indexed)
        // order-creation instant — the business truth, not the row insert time.
        prisma.orderProjection.findMany({
          where: { medusaCreatedAt: { gte: windowStart, lt: windowEnd } },
          select: { totalInCentavos: true },
        }),
        // Settled (captured) payments for those same orders — owner-join idiom.
        prisma.payment.findMany({
          where: {
            order: { medusaCreatedAt: { gte: windowStart, lt: windowEnd } },
            status: { in: SETTLED_PAYMENT_STATUSES_IN },
          },
          select: { method: true, amountInCentavos: true, refundedAmountCentavos: true },
        }),
      ])

      const orderCount = orders.length
      const grossCentavos = orders.reduce((sum, o) => sum + o.totalInCentavos, 0)

      const settledByMethod: MutableMethodTotals = { pix: 0, card: 0, cash: 0 }
      const refundedByMethod: MutableMethodTotals = { pix: 0, card: 0, cash: 0 }
      let settledCount = 0
      let refundCount = 0

      for (const p of payments) {
        const bucket = methodBucket(p.method)
        if (!bucket) continue // method is pix|card|cash at write time; guard keeps totals == bucket sums
        settledByMethod[bucket] += p.amountInCentavos
        settledCount += 1
        const refunded = p.refundedAmountCentavos ?? 0
        if (refunded > 0) {
          refundedByMethod[bucket] += refunded
          refundCount += 1
        }
      }

      const settledTotal = settledByMethod.pix + settledByMethod.card + settledByMethod.cash
      const refundedTotal = refundedByMethod.pix + refundedByMethod.card + refundedByMethod.cash

      return {
        date,
        timezone,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        orders: { count: orderCount, grossCentavos },
        settled: { count: settledCount, totalCentavos: settledTotal, byMethod: settledByMethod },
        refunds: { count: refundCount, totalCentavos: refundedTotal, byMethod: refundedByMethod },
        netCentavos: settledTotal - refundedTotal,
      }
    },
  }
}
