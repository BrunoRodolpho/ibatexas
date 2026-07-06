// ops-snapshot.mappers.ts — PURE view types + pt-BR format helpers for the
// Painel Operacional manager overview (NEW-041). It renders the READ-ONLY
// GET /api/admin/ops/snapshot composition (NEW-040 / PR #158).
//
// Like its sibling ops-alerts.mappers, this module is framework-free (no React,
// no '@/' imports) so the logic is trivially unit-testable in the repo's node
// vitest env — the one dep it pulls is the pure `@ibatexas/ui/utils` subpath
// (format.ts / status-variant.ts, no React) for the CANONICAL money formatter.
// The response types below are a CLIENT-SIDE mirror of the route-local
// `OpsSnapshot` view-composition (apps/api/src/routes/admin/ops-snapshot.ts) —
// that shape is a view, not domain state, so it is not exported from
// `@ibatexas/domain` (which the browser bundle cannot import anyway). MONEY
// crosses the boundary as INTEGER centavos (Hard Rule #2) and durations as
// INTEGER milliseconds.
//
// DRY: the severity band labels/variants come from ops-alerts.mappers and the
// centavos→BRL formatter from `@ibatexas/ui/utils` (the single-source formatBRL)
// — both are imported + re-exposed here, never re-declared.

import { formatBRL } from '@ibatexas/ui/utils'
import {
  severityLabel,
  severityBadgeVariant,
  OPS_ALERT_SEVERITY_LABELS,
  type OpsAlertSeverity,
} from './ops-alerts.mappers'

// Re-export the severity band helpers so the page has a single import source
// while the DECLARATION stays solely in ops-alerts.mappers.
export { severityLabel, severityBadgeVariant, OPS_ALERT_SEVERITY_LABELS }
export type { OpsAlertSeverity }

// ── Client mirror of the GET /api/admin/ops/snapshot view-composition ────────

/** Non-terminal ops-alert tally per severity band (keys === OpsAlertSeverity). */
export interface SeverityTally {
  readonly low: number
  readonly medium: number
  readonly high: number
}

/** Open ops-alerts summary — the inbox badge count + a small severity tally. */
export interface OpsAlertsSummary {
  readonly open: number
  readonly bySeverity: SeverityTally
}

/** Open conversation-incidents summary — the attention-badge count. */
export interface IncidentsSummary {
  readonly open: number
}

/** One kitchen queue-depth bucket (`status` widened to string at the boundary). */
export interface OpsQueueDepthEntry {
  readonly status: string
  readonly count: number
}

/** Kitchen load summary — active count + oldest wait (ms) + per-status depth. */
export interface KitchenSummary {
  readonly activeTickets: number
  readonly oldestTicketAgeMs: number
  readonly queueDepth: readonly OpsQueueDepthEntry[]
}

/** Today's caixa — compact headline money figures (INTEGER centavos). */
export interface CaixaSummary {
  readonly date: string
  readonly ordersCount: number
  readonly grossCentavos: number
  readonly settledCentavos: number
  readonly refundedCentavos: number
  readonly netCentavos: number
}

/** The composed manager situational snapshot. */
export interface OpsSnapshot {
  /** The instant the snapshot was assembled (ISO). */
  readonly now: string
  readonly opsAlerts: OpsAlertsSummary
  readonly incidents: IncidentsSummary
  readonly kitchen: KitchenSummary
  readonly caixa: CaixaSummary
}

// ── Money (integer centavos → pt-BR BRL) ─────────────────────────────────────

/**
 * INTEGER-centavos → "R$ 89,00". Delegates to the CANONICAL single-source
 * `formatBRL` (@ibatexas/ui/utils) so the caixa figures render identically to
 * every other price in the admin app (DRY — no 7th duplicate). A finite/integer
 * guard keeps a stray NaN from leaking "R$ NaN" into the manager overview.
 */
export function formatCentavosBRL(centavos: number): string {
  return formatBRL(Number.isFinite(centavos) ? Math.trunc(centavos) : 0)
}

// ── Duration (integer ms → humane pt-BR) ─────────────────────────────────────

const MS_PER_MINUTE = 60_000

/**
 * Humanize an INTEGER millisecond duration to pt-BR: "12 min", "1 h 5 min",
 * "2 h". Anything under a minute (including 0 and a negative from clock skew)
 * collapses to "0 min". Integer math only — floors to whole minutes.
 */
export function formatDurationMs(ms: number): string {
  const totalMinutes =
    Number.isFinite(ms) && ms > 0 ? Math.floor(ms / MS_PER_MINUTE) : 0
  if (totalMinutes === 0) return '0 min'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
}

// ── Kitchen queue-depth status labels (pt-BR) ────────────────────────────────

/** The active fulfillment statuses the kitchen board reports depth for. */
export type KitchenQueueStatus = 'pending' | 'confirmed' | 'preparing' | 'ready'

/**
 * pt-BR labels for the kitchen queue-depth statuses. EXHAUSTIVE over the closed
 * union (a new member is a COMPILE error until labeled — Hard Rule #4). Declared
 * locally to keep this module framework-free (mirrors the ops-alerts.mappers
 * self-contained-registers pattern rather than importing the React barrel).
 */
export const KITCHEN_QUEUE_STATUS_LABELS: Record<KitchenQueueStatus, string> = {
  pending: 'Pendente',
  confirmed: 'Confirmado',
  preparing: 'Preparando',
  ready: 'Pronto',
}

/**
 * Label for a kitchen queue-depth status. The API widens `status` to string, so
 * an unknown value falls back to the raw status (defensive — never blank).
 */
export function queueStatusLabel(status: string): string {
  return KITCHEN_QUEUE_STATUS_LABELS[status as KitchenQueueStatus] ?? status
}
