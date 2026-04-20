// PONR (Point of No Return) — time-based amend/cancel windows for order items.
//
// Each product has per-item PONR values (amendPonrMinutes, cancelPonrMinutes).
// There are also per-day-of-week global overrides (e.g. Saturday = 15min because
// busier, Monday = 0min because slow). Effective PONR = max(product, day-of-week).

export interface PonrConfig {
  amendMinutes: number
  cancelMinutes: number
}

export interface ItemPonrStatus {
  name: string
  canAmend: boolean
  canCancel: boolean
  amendDeadline: Date
  cancelDeadline: Date
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_AMEND_PONR = Number.parseInt(
  process.env.PONR_DEFAULT_AMEND_MINUTES || "5",
  10,
)
const DEFAULT_CANCEL_PONR = Number.parseInt(
  process.env.PONR_DEFAULT_CANCEL_MINUTES || "5",
  10,
)

// ── Day-of-week overrides ─────────────────────────────────────────────────────

// JSON env var: {"saturday":{"amendMinutes":15,"cancelMinutes":15},"monday":{"amendMinutes":0,"cancelMinutes":0}}
function getDayOverrides(): Record<string, PonrConfig> {
  const raw = process.env.PONR_DAY_OVERRIDES
  if (!raw || raw === "{}") return {}
  try {
    return JSON.parse(raw) as Record<string, PonrConfig>
  } catch {
    return {}
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Calculate the effective PONR for a product, considering both product-level
 * and day-of-week overrides. Returns the stricter (larger) of the two.
 */
export function getEffectivePonr(
  productPonr: { amendMinutes?: number; cancelMinutes?: number },
  date: Date = new Date(),
): PonrConfig {
  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ]
  const dayName = dayNames[date.getDay()]
  const dayOverride = getDayOverrides()[dayName]

  return {
    amendMinutes: Math.max(
      productPonr.amendMinutes ?? DEFAULT_AMEND_PONR,
      dayOverride?.amendMinutes ?? 0,
    ),
    cancelMinutes: Math.max(
      productPonr.cancelMinutes ?? DEFAULT_CANCEL_PONR,
      dayOverride?.cancelMinutes ?? 0,
    ),
  }
}

/**
 * Check if the current time is still within the PONR window.
 */
export function isWithinPonr(
  orderCreatedAt: Date,
  ponrMinutes: number,
  now: Date = new Date(),
): boolean {
  const elapsedMs = now.getTime() - orderCreatedAt.getTime()
  return elapsedMs < ponrMinutes * 60_000
}

/**
 * For each item in an order, determine whether it can still be amended/cancelled.
 */
export function getItemPonrStatus(
  items: Array<{
    name: string
    amendPonrMinutes?: number
    cancelPonrMinutes?: number
  }>,
  orderCreatedAt: Date,
  now: Date = new Date(),
): ItemPonrStatus[] {
  return items.map((item) => {
    const ponr = getEffectivePonr(
      {
        amendMinutes: item.amendPonrMinutes,
        cancelMinutes: item.cancelPonrMinutes,
      },
      now,
    )
    return {
      name: item.name,
      canAmend: isWithinPonr(orderCreatedAt, ponr.amendMinutes, now),
      canCancel: isWithinPonr(orderCreatedAt, ponr.cancelMinutes, now),
      amendDeadline: new Date(
        orderCreatedAt.getTime() + ponr.amendMinutes * 60_000,
      ),
      cancelDeadline: new Date(
        orderCreatedAt.getTime() + ponr.cancelMinutes * 60_000,
      ),
    }
  })
}
