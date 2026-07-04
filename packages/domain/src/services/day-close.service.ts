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
import type { PaymentStatus as PrismaPaymentStatus } from "../generated/prisma-client/client.js"

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEZONE = "America/Sao_Paulo"

/**
 * The capture set — statuses whose row had its `amountInCentavos` collected.
 * The literals are `satisfies`-checked against the Prisma `PaymentStatus` enum
 * (a typo'd status is a COMPILE error), so they are the REAL DB values, never
 * invented — WITHOUT a value import of the `@ibatexas/types` PaymentStatus enum
 * (that value import, eagerly loaded via `@ibatexas/domain`'s index, breaks any
 * test that partial-mocks `@ibatexas/types`). Excludes `disputed` (contested/held)
 * and every never-captured status (awaiting_payment, payment_pending, cash_pending,
 * switching_method, payment_failed, payment_expired, canceled, waived).
 */
const SETTLED_PAYMENT_STATUSES = [
  "paid",
  "partially_refunded",
  "refunded",
] as const satisfies readonly PrismaPaymentStatus[]

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

// ── Day-boundary helpers (DST-safe, host-TZ independent) ───────────────────────

type MutableMethodTotals = { pix: number; card: number; cash: number }

/**
 * Offset (ms) to ADD to a UTC instant to read its wall clock in `tz`
 * (i.e. `wallClockAsUtc − instant`). Derived from Intl.formatToParts at the
 * actual instant, so it reflects the correct offset across DST. Uses only Date.UTC
 * and `…Z` literals, so it never depends on the host machine's local timezone.
 */
function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant)
  const get = (t: string): number =>
    Number.parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10)
  let hour = get("hour")
  if (hour === 24) hour = 0 // some engines emit 24 for midnight
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"))
  return asUtc - instant.getTime()
}

/**
 * The UTC instant of local midnight (00:00:00.000) for `dateStr` (YYYY-MM-DD)
 * in `tz`. Sao Paulo is a fixed −03:00 offset (Brazil dropped DST in 2019), so a
 * single offset resolution is exact; for DST zones it is correct except within
 * the ≤1h transition window around local midnight.
 */
function localDayStartUtc(dateStr: string, tz: string): Date {
  const approx = new Date(`${dateStr}T00:00:00.000Z`)
  return new Date(approx.getTime() - tzOffsetMs(approx, tz))
}

/** Next YYYY-MM-DD after `dateStr` (UTC-arithmetic; handles month/year rollover). */
function nextDayStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

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
      const timezone = opts?.timezone ?? process.env.RESTAURANT_TIMEZONE ?? DEFAULT_TIMEZONE
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
            status: { in: SETTLED_PAYMENT_STATUSES as unknown as PrismaPaymentStatus[] },
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
