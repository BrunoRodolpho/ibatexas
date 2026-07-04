// LaborCostService — read-only labor-cost analytics (NEW-034). EXTENDS the NEW-016
// escala: over a LOCAL-date range [from, to) it aggregates the EXISTING StaffShift
// rows (joined to their Staff for name + pay rate) — NO mutations, NO new tables.
//
// Day cohort: shifts whose `startsAt` falls in the [from, to) window, resolved to
// the business-timezone local-day boundaries — the SAME idiom listShifts / day-close
// / order-analytics use via ./__shared__/day-window.js (no per-service DST drift).
//
// Per staff, over their in-window shifts:
//   • scheduledHours — Σ (endsAt − startsAt) across ALL shifts
//   • actualHours    — Σ (actualEnd − actualStart) across shifts where BOTH clock
//                      stamps are present (a half-clocked shift contributes 0 here)
//   • costCentavos   — round(billableHours × hourlyRateCentavos), where billableHours
//                      is summed PER SHIFT on the ACTUAL-vs-SCHEDULED FALLBACK RULE:
//
//   ┌─ FALLBACK RULE (money) ────────────────────────────────────────────────────┐
//   │ For each shift, the billable basis is:                                      │
//   │   • the ACTUAL hours (actualEnd − actualStart) when BOTH stamps are present │
//   │   • else the SCHEDULED hours (endsAt − startsAt)                            │
//   │ Cost bills what was WORKED when we know it, and falls back to what was      │
//   │ SCHEDULED when the shift is un-/half-clocked. So a staff's billable basis   │
//   │ is a per-shift MIX and is NOT (in general) either scheduledHours or         │
//   │ actualHours as a whole. Cost uses full-precision hours (not the 2-decimal   │
//   │ DISPLAY hours) so no centavo is lost to display rounding; Math.round is     │
//   │ applied ONCE, at the end, on centavos → deterministic integer money.        │
//   └─────────────────────────────────────────────────────────────────────────────┘
//
// NULL-RATE STAFF: a Staff with `hourlyRateCentavos == null` has NO known pay rate,
// so its cost is NEVER guessed — costCentavos is 0 and the row is flagged
// `rateMissing: true` (its hours are still reported; only the money is withheld).
// Such rows contribute 0 to totalCostCentavos.

import { prisma } from "../client.js"
import { assertYmd, localDayStartUtc, resolveTimezone } from "./__shared__/day-window.js"

// ── Constants ─────────────────────────────────────────────────────────────────

const MS_PER_HOUR = 3_600_000

/** Round a raw hours value to 2 decimals for display (money is rounded separately). */
function roundHours(hours: number): number {
  return Math.round(hours * 100) / 100
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Params for a labor-cost report over a LOCAL-date range. */
export interface LaborCostParams {
  /** Range start, YYYY-MM-DD — INCLUSIVE (local day). */
  readonly from: string
  /** Range end, YYYY-MM-DD — EXCLUSIVE (local day). */
  readonly to: string
  /** IANA zone; defaults to RESTAURANT_TIMEZONE then America/Sao_Paulo. */
  readonly timezone?: string
}

/** One staff member's labor line over the range. */
export interface StaffLaborCost {
  readonly staffId: string
  /** Staff display name (from the joined Staff row). */
  readonly name: string
  /** Σ scheduled hours across ALL in-window shifts (2-decimal-rounded). */
  readonly scheduledHours: number
  /** Σ actual hours across shifts with BOTH clock stamps (2-decimal-rounded). */
  readonly actualHours: number
  /** Labor cost in integer centavos (0 when rateMissing). */
  readonly costCentavos: number
  /** True when the staff has no `hourlyRateCentavos` → excluded from cost. */
  readonly rateMissing: boolean
}

/** Read-model of labor cost over a local-date range. */
export interface LaborCostReport {
  /** The requested range, echoed back. */
  readonly range: { readonly from: string; readonly to: string }
  /** IANA timezone used to resolve the range boundaries. */
  readonly timezone: string
  /** Per-staff labor lines, ordered by staffId (stable board). */
  readonly byStaff: readonly StaffLaborCost[]
  /** Σ costCentavos across staff (null-rate staff contribute 0). */
  readonly totalCostCentavos: number
  /** Σ scheduled hours across all staff (2-decimal-rounded). */
  readonly totalScheduledHours: number
  /** Σ actual hours across all staff (2-decimal-rounded). */
  readonly totalActualHours: number
}

export interface LaborCostService {
  /**
   * Aggregate labor cost over the [from, to) local-date window. See the file
   * header for the exact ACTUAL-vs-SCHEDULED cost fallback and null-rate handling.
   */
  getLaborCost(params: LaborCostParams): Promise<LaborCostReport>
}

// ── Per-staff accumulator (raw ms; rounded to hours only at the end) ────────────

interface StaffAcc {
  staffId: string
  name: string
  hourlyRateCentavos: number | null
  scheduledMs: number
  actualMs: number
  /** Per-shift billable basis (actual when both stamps present, else scheduled). */
  billableMs: number
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createLaborCostService(): LaborCostService {
  return {
    async getLaborCost(params) {
      assertYmd("getLaborCost: from", params.from)
      assertYmd("getLaborCost: to", params.to)
      const timezone = resolveTimezone(params)
      const windowStart = localDayStartUtc(params.from, timezone)
      const windowEnd = localDayStartUtc(params.to, timezone)

      // In-window shifts joined to their Staff (name + pay rate). Ordered by
      // staffId then startsAt so the Map's insertion order is a stable board.
      const shifts = await prisma.staffShift.findMany({
        where: { startsAt: { gte: windowStart, lt: windowEnd } },
        select: {
          staffId: true,
          startsAt: true,
          endsAt: true,
          actualStart: true,
          actualEnd: true,
          staff: { select: { name: true, hourlyRateCentavos: true } },
        },
        orderBy: [{ staffId: "asc" }, { startsAt: "asc" }],
      })

      const byId = new Map<string, StaffAcc>()

      for (const s of shifts) {
        let acc = byId.get(s.staffId)
        if (!acc) {
          acc = {
            staffId: s.staffId,
            name: s.staff?.name ?? "",
            hourlyRateCentavos: s.staff?.hourlyRateCentavos ?? null,
            scheduledMs: 0,
            actualMs: 0,
            billableMs: 0,
          }
          byId.set(s.staffId, acc)
        }
        // Guard against inverted stamps (defensive; the route validates endsAt >
        // startsAt on create, but actual stamps are operator-entered).
        const scheduledMs = Math.max(0, s.endsAt.getTime() - s.startsAt.getTime())
        acc.scheduledMs += scheduledMs

        const { actualStart, actualEnd } = s
        if (actualStart != null && actualEnd != null) {
          const actualMs = Math.max(0, actualEnd.getTime() - actualStart.getTime())
          acc.actualMs += actualMs
          acc.billableMs += actualMs // FALLBACK RULE: bill ACTUAL when fully clocked
        } else {
          acc.billableMs += scheduledMs // FALLBACK RULE: bill SCHEDULED otherwise
        }
      }

      let totalCostCentavos = 0
      let totalScheduledMs = 0
      let totalActualMs = 0

      const byStaff: StaffLaborCost[] = [...byId.values()].map((acc) => {
        const rateMissing = acc.hourlyRateCentavos == null
        // Cost from FULL-PRECISION billable hours; Math.round ONCE on centavos.
        const costCentavos = rateMissing
          ? 0
          : Math.round((acc.billableMs / MS_PER_HOUR) * (acc.hourlyRateCentavos as number))

        totalCostCentavos += costCentavos
        totalScheduledMs += acc.scheduledMs
        totalActualMs += acc.actualMs

        return {
          staffId: acc.staffId,
          name: acc.name,
          scheduledHours: roundHours(acc.scheduledMs / MS_PER_HOUR),
          actualHours: roundHours(acc.actualMs / MS_PER_HOUR),
          costCentavos,
          rateMissing,
        }
      })

      return {
        range: { from: params.from, to: params.to },
        timezone,
        byStaff,
        totalCostCentavos,
        totalScheduledHours: roundHours(totalScheduledMs / MS_PER_HOUR),
        totalActualHours: roundHours(totalActualMs / MS_PER_HOUR),
      }
    },
  }
}
