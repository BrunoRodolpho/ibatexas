// day-window.ts — shared, DST-safe local-day window + captured-payment-status
// helpers for the read-only reporting aggregations (day-close / order-analytics —
// NEW-011 / NEW-013). Extracted so the money-critical day-boundary + settle-status
// logic lives in ONE place (DRY; no per-service drift). Pure — no IO except reading
// process.env.RESTAURANT_TIMEZONE for the default zone.

import type { PaymentStatus as PrismaPaymentStatus } from "../../generated/prisma-client/client.js"

export const DEFAULT_TIMEZONE = "America/Sao_Paulo"

/** The effective business timezone: `opts.timezone` ?? RESTAURANT_TIMEZONE ?? default. */
export function resolveTimezone(opts?: { timezone?: string }): string {
  return opts?.timezone ?? process.env.RESTAURANT_TIMEZONE ?? DEFAULT_TIMEZONE
}

/**
 * The capture set — statuses whose row had its `amountInCentavos` collected. The
 * literals are `satisfies`-checked against the Prisma `PaymentStatus` enum (a typo
 * is a COMPILE error), so they are the REAL DB values — WITHOUT a value import of
 * the `@ibatexas/types` PaymentStatus enum (that value import, eagerly loaded via
 * `@ibatexas/domain`'s index, breaks any test that partial-mocks `@ibatexas/types`).
 * Excludes `disputed` (contested/held) and every never-captured status.
 */
export const SETTLED_PAYMENT_STATUSES = [
  "paid",
  "partially_refunded",
  "refunded",
] as const satisfies readonly PrismaPaymentStatus[]

/** `SETTLED_PAYMENT_STATUSES` as the mutable array Prisma's `{ in: … }` expects. */
export const SETTLED_PAYMENT_STATUSES_IN = [...SETTLED_PAYMENT_STATUSES] as PrismaPaymentStatus[]

/**
 * Offset (ms) to ADD to a UTC instant to read its wall clock in `tz`
 * (`wallClockAsUtc − instant`). Derived from Intl.formatToParts at the actual
 * instant, so it reflects the correct offset across DST. Uses only Date.UTC and
 * `…Z` literals, so it never depends on the host machine's local timezone.
 */
export function tzOffsetMs(instant: Date, tz: string): number {
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
 * The UTC instant of local midnight (00:00:00.000) for `dateStr` (YYYY-MM-DD) in
 * `tz`. Sao Paulo is a fixed −03:00 offset (Brazil dropped DST in 2019), so a
 * single offset resolution is exact; for DST zones it is correct except within the
 * ≤1h transition window around local midnight.
 */
export function localDayStartUtc(dateStr: string, tz: string): Date {
  const approx = new Date(`${dateStr}T00:00:00.000Z`)
  return new Date(approx.getTime() - tzOffsetMs(approx, tz))
}

/** The local calendar day (YYYY-MM-DD, en-CA) of a UTC instant in `tz`. */
export function localDateStr(instant: Date, tz: string): string {
  return instant.toLocaleDateString("en-CA", { timeZone: tz })
}

/** Next YYYY-MM-DD after `dateStr` (UTC-arithmetic; handles month/year rollover). */
export function nextDayStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Throw a RangeError unless `value` is a YYYY-MM-DD string. */
export function assertYmd(label: string, value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${label} must be YYYY-MM-DD, got "${value}"`)
  }
}
