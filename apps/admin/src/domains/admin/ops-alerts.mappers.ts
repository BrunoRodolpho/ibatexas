// ops-alerts.mappers.ts — pt-BR label registers + PURE list-shaping helpers for
// the Alertas Operacionais admin inbox (BKL-082 / NEW-025 detection plane).
//
// CLIENT-SIDE mirror of the server ops-alert taxonomy. The browser bundle CANNOT
// import `@ibatexas/domain` (it pulls Prisma), so the canonical server registers
// `OPS_ALERT_CAUSE_LABELS_PT` / `OPS_ALERT_SEVERITY_LABELS_PT`
// (packages/domain/src/services/__shared__/ops-alert-policy.ts) are not reachable
// here. They are re-declared below as EXHAUSTIVE `Record<Union, string>` maps
// keyed by the frozen ops unions — adding a member to a union is a COMPILE error
// until it is labeled, so a value can never silently fall back to its raw enum key
// (Hard Rule #4 — pt-BR only). Kept verbatim to the server pt-BR so staff pings,
// digests and this inbox all speak with one meaning.
//
// This module is intentionally framework-free (no React, no '@/' imports) so the
// logic is trivially unit-testable in the repo's node vitest env.

// ── Frozen ops unions (mirror packages/domain prisma enums) ──────────────────

export type OpsAlertCause =
  | 'ops_stuck_order'
  | 'ops_pix_expiry_backlog'
  | 'ops_stale_defer'
  | 'ops_dlq_depth'
  | 'ops_ingredient_underflow'
  | 'ops_staff_auth_infra'
  | 'ops_observability_down'

export type OpsAlertSeverity = 'low' | 'medium' | 'high'

export type OpsAlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'AUTO_RESOLVED' | 'RESOLVED'

export type OpsAlertResolutionType = 'AUTO' | 'STAFF'

/**
 * The ops-alert row as it crosses the JSON boundary from GET /api/admin/ops-alerts.
 * Prisma `DateTime` fields serialize to ISO strings; `context` (Json?) is opaque.
 */
export interface OpsAlert {
  readonly id: string
  readonly cause: OpsAlertCause
  readonly severity: OpsAlertSeverity
  readonly status: OpsAlertStatus
  readonly source: string
  readonly scope: string | null
  readonly title: string
  readonly detail: string | null
  readonly context: unknown
  readonly occurrences: number
  readonly dedupeKey: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly acknowledgedAt: string | null
  readonly acknowledgedBy: string | null
  readonly resolvedAt: string | null
  readonly resolvedBy: string | null
  readonly resolutionType: OpsAlertResolutionType | null
  readonly createdAt: string
  readonly updatedAt: string
}

// ── pt-BR label registers (EXHAUSTIVE — a new enum member fails the build) ────

/** Canonical pt-BR cause labels (verbatim mirror of OPS_ALERT_CAUSE_LABELS_PT). */
export const OPS_ALERT_CAUSE_LABELS: Record<OpsAlertCause, string> = {
  ops_stuck_order: 'pedidos travados (não pagos além do limite)',
  ops_pix_expiry_backlog: 'acúmulo de PIX expirados',
  ops_stale_defer: 'confirmações pendentes vencidas',
  ops_dlq_depth: 'fila de mensagens mortas acumulando (DLQ)',
  ops_ingredient_underflow: 'estoque de insumo abaixo do necessário (baixa de pedido)',
  ops_staff_auth_infra: 'falha de infraestrutura na autenticação de funcionários (logins de staff caindo)',
  ops_observability_down: 'serviço de observabilidade fora do ar (risco de perda de logs/métricas)',
}

/** Canonical pt-BR severity labels (mirror of OPS_ALERT_SEVERITY_LABELS_PT). */
export const OPS_ALERT_SEVERITY_LABELS: Record<OpsAlertSeverity, string> = {
  low: 'baixa',
  medium: 'média',
  high: 'alta',
}

/** pt-BR status labels (mirror the INCIDENT_STATUS_LABELS idiom). */
export const OPS_ALERT_STATUS_LABELS: Record<OpsAlertStatus, string> = {
  OPEN: 'aberto',
  ACKNOWLEDGED: 'em atendimento',
  AUTO_RESOLVED: 'resolvido auto',
  RESOLVED: 'resolvido',
}

/** Total label lookups — never fall back to a raw enum key (exhaustive record). */
export function causeLabel(cause: OpsAlertCause): string {
  return OPS_ALERT_CAUSE_LABELS[cause]
}
export function severityLabel(severity: OpsAlertSeverity): string {
  return OPS_ALERT_SEVERITY_LABELS[severity]
}
export function statusLabel(status: OpsAlertStatus): string {
  return OPS_ALERT_STATUS_LABELS[status]
}

// ── Filter chip options (id === '' means "all") ──────────────────────────────

export interface FilterOption {
  readonly id: string
  readonly label: string
}

export const OPS_ALERT_STATUS_FILTERS: readonly FilterOption[] = [
  { id: '', label: 'Todos' },
  { id: 'OPEN', label: 'Abertos' },
  { id: 'ACKNOWLEDGED', label: 'Em atendimento' },
  { id: 'AUTO_RESOLVED', label: 'Resolvidos auto' },
  { id: 'RESOLVED', label: 'Resolvidos' },
]

export const OPS_ALERT_CAUSE_FILTERS: readonly FilterOption[] = [
  { id: '', label: 'Todas' },
  { id: 'ops_stuck_order', label: 'Pedidos travados' },
  { id: 'ops_pix_expiry_backlog', label: 'PIX expirados' },
  { id: 'ops_stale_defer', label: 'Confirmações vencidas' },
  { id: 'ops_dlq_depth', label: 'DLQ' },
  { id: 'ops_ingredient_underflow', label: 'Estoque de insumo' },
  { id: 'ops_staff_auth_infra', label: 'Auth de staff' },
  { id: 'ops_observability_down', label: 'Observabilidade' },
]

// ── Badge variant mapping (maps to @ibatexas/ui Badge tiers) ─────────────────

/** Severity → Badge variant. high=danger, medium=warning, low=default (muted). */
export function severityBadgeVariant(
  severity: OpsAlertSeverity,
): 'danger' | 'warning' | 'default' {
  if (severity === 'high') return 'danger'
  if (severity === 'medium') return 'warning'
  return 'default'
}

/** Status → Badge variant. OPEN=warning, ACK=info, AUTO=info, RESOLVED=success. */
export function statusBadgeVariant(
  status: OpsAlertStatus,
): 'warning' | 'info' | 'success' {
  if (status === 'OPEN') return 'warning'
  if (status === 'RESOLVED') return 'success'
  return 'info'
}

// ── Terminal / ordering logic ────────────────────────────────────────────────

const NON_TERMINAL_STATUSES: ReadonlySet<OpsAlertStatus> = new Set([
  'OPEN',
  'ACKNOWLEDGED',
])

/** A non-terminal alert (OPEN/ACKNOWLEDGED) is still resolvable → shows "Resolver". */
export function isResolvable(status: OpsAlertStatus): boolean {
  return NON_TERMINAL_STATUSES.has(status)
}

/** Semantic status rank for OPEN-first ordering (mirrors the Prisma enum order). */
const STATUS_ORDER: Record<OpsAlertStatus, number> = {
  OPEN: 0,
  ACKNOWLEDGED: 1,
  AUTO_RESOLVED: 2,
  RESOLVED: 3,
}

/**
 * Defensive client sort mirroring the server's `orderBy [status asc, lastSeenAt
 * desc]` (OPEN-first, then most-recently-active). Pure + total, does NOT mutate
 * its input — guarantees the rendered order even if the API order ever drifts.
 */
export function sortOpsAlerts(alerts: readonly OpsAlert[]): OpsAlert[] {
  return [...alerts].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    if (byStatus !== 0) return byStatus
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
  })
}

// ── Query building + formatting ──────────────────────────────────────────────

export interface OpsAlertsQueryParams {
  readonly status?: string
  readonly cause?: string
  readonly limit?: number
  readonly offset?: number
}

/** Build the querystring for GET /api/admin/ops-alerts from the active filters. */
export function buildOpsAlertsQuery(params: OpsAlertsQueryParams): string {
  const qs = new URLSearchParams()
  if (params.status) qs.set('status', params.status)
  if (params.cause) qs.set('cause', params.cause)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  if (params.offset !== undefined) qs.set('offset', String(params.offset))
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** Human pt-BR timestamp for the inbox; guards against a malformed date. */
export function formatOpsAlertTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('pt-BR')
}

/** Source + optional scope, joined for the table ("origem · escopo"). */
export function sourceScopeLabel(alert: Pick<OpsAlert, 'source' | 'scope'>): string {
  return alert.scope ? `${alert.source} · ${alert.scope}` : alert.source
}
