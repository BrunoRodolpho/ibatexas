'use client'

// Alertas Operacionais — read + resolve inbox over the deterministic ops-watchdog
// alerts (BKL-082 / NEW-025 detection plane). Bespoke filterable table (the app's
// @tanstack DataTable primitive lives only inside @ibatexas/ui and is not a dep of
// this app), fetch/resolve via the useAdminOpsAlertsPage hook + apiFetch, toast via
// @ibatexas/ui useToast, reload-after-write. All non-trivial logic (labels, sort,
// terminal check, query building) lives in the PURE ops-alerts.mappers module.
// pt-BR throughout (Hard Rule #4).

import { useEffect, useState } from 'react'
import { Siren, RefreshCw } from 'lucide-react'
import { Badge, useToast } from '@ibatexas/ui'
import { useAdminOpsAlertsPage } from '@/domains/admin/admin.hooks'
import {
  OPS_ALERT_STATUS_FILTERS,
  OPS_ALERT_CAUSE_FILTERS,
  causeLabel,
  severityLabel,
  statusLabel,
  severityBadgeVariant,
  statusBadgeVariant,
  isResolvable,
  formatOpsAlertTimestamp,
  sourceScopeLabel,
  type FilterOption,
} from '@/domains/admin/ops-alerts.mappers'

const OPS_ALERT_TOASTS = {
  loadFailed: 'Falha ao carregar os alertas operacionais.',
  resolved: 'Alerta resolvido.',
  resolveFailed: 'Falha ao resolver o alerta.',
  notFound: 'Alerta não encontrado (já removido).',
} as const

const COLUMN_HEADERS = {
  cause: 'Causa',
  severity: 'Gravidade',
  status: 'Status',
  source: 'Origem',
  occurrences: 'Ocorrências',
  lastSeen: 'Última ocorrência',
  actions: 'Ações',
} as const

// ── Filter chip row (id === '' means "all") ──────────────────────────────────

function FilterChips({
  options,
  active,
  onSelect,
}: Readonly<{
  options: readonly FilterOption[]
  active: string
  onSelect: (id: string) => void
}>): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const isActive = opt.id === active
        return (
          <button
            key={opt.id || 'all'}
            type="button"
            onClick={() => onSelect(opt.id)}
            className={`rounded-sm border px-2.5 py-1 text-xs font-medium transition-colors ${
              isActive
                ? 'border-charcoal-900 bg-charcoal-900 text-white'
                : 'border-smoke-200 bg-smoke-50 text-charcoal-700 hover:bg-smoke-100'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export default function AlertasOperacionaisPage(): React.JSX.Element {
  const { addToast } = useToast()
  const {
    alerts,
    openCount,
    loading,
    error,
    statusFilter,
    causeFilter,
    hasActiveFilters,
    onStatusFilter,
    onCauseFilter,
    onClearFilters,
    resolveAlert,
    refetch,
  } = useAdminOpsAlertsPage()

  const [resolvingId, setResolvingId] = useState<string | null>(null)

  // Surface (never swallow) list-load failures.
  useEffect(() => {
    if (error) {
      addToast({ type: 'error', message: OPS_ALERT_TOASTS.loadFailed, dedupeKey: 'ops-alert-load' })
    }
  }, [error, addToast])

  async function handleResolve(id: string): Promise<void> {
    setResolvingId(id)
    try {
      await resolveAlert(id) // reload-after-write happens inside the hook
      addToast({ type: 'success', message: OPS_ALERT_TOASTS.resolved })
    } catch (err) {
      const notFound = err instanceof Error && err.message.includes('404')
      addToast({
        type: 'error',
        message: notFound ? OPS_ALERT_TOASTS.notFound : OPS_ALERT_TOASTS.resolveFailed,
      })
    } finally {
      setResolvingId(null)
    }
  }

  const isEmpty = !loading && alerts.length === 0

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Siren className="mt-0.5 h-5 w-5 text-accent-red" aria-hidden />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-charcoal-900">Alertas Operacionais</h1>
              {openCount > 0 ? (
                <Badge variant="danger" className="tabular-nums">
                  {openCount} {openCount === 1 ? 'aberto' : 'abertos'}
                </Badge>
              ) : null}
            </div>
            <p className="text-sm text-smoke-500">
              Condições operacionais detectadas automaticamente (pedidos travados, PIX
              expirados, confirmações vencidas, filas mortas).
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={refetch}
          className="flex items-center gap-1.5 rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1.5 text-xs font-medium text-charcoal-700 hover:bg-smoke-100"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Atualizar
        </button>
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <FilterChips options={OPS_ALERT_STATUS_FILTERS} active={statusFilter} onSelect={onStatusFilter} />
        <FilterChips options={OPS_ALERT_CAUSE_FILTERS} active={causeFilter} onSelect={onCauseFilter} />
        {hasActiveFilters ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="self-start text-xs font-medium text-smoke-500 underline hover:text-charcoal-700"
          >
            Limpar filtros
          </button>
        ) : null}
      </div>

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      <div className="w-full overflow-x-auto rounded-sm border border-smoke-200 bg-smoke-50">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-smoke-100 bg-smoke-100/50 text-left text-[10px] uppercase tracking-wider text-smoke-400">
              <th className="px-4 py-2.5 font-medium">{COLUMN_HEADERS.cause}</th>
              <th className="px-4 py-2.5 font-medium">{COLUMN_HEADERS.severity}</th>
              <th className="px-4 py-2.5 font-medium">{COLUMN_HEADERS.status}</th>
              <th className="px-4 py-2.5 font-medium">{COLUMN_HEADERS.source}</th>
              <th className="px-4 py-2.5 font-medium">{COLUMN_HEADERS.occurrences}</th>
              <th className="px-4 py-2.5 font-medium">{COLUMN_HEADERS.lastSeen}</th>
              <th className="px-4 py-2.5 font-medium">{COLUMN_HEADERS.actions}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-smoke-400">
                  Carregando…
                </td>
              </tr>
            ) : isEmpty ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-smoke-400">
                  {hasActiveFilters
                    ? 'Nenhum alerta para os filtros selecionados.'
                    : 'Nenhum alerta operacional. Tudo em ordem. 🎉'}
                </td>
              </tr>
            ) : (
              alerts.map((alert) => (
                <tr
                  key={alert.id}
                  className={`border-b border-smoke-100 last:border-0 hover:bg-smoke-100/50 ${
                    isResolvable(alert.status) ? '' : 'text-smoke-500'
                  }`}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-charcoal-700">{causeLabel(alert.cause)}</span>
                      <span className="text-xs text-smoke-500">{alert.title}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={severityBadgeVariant(alert.severity)}>
                      {severityLabel(alert.severity)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={statusBadgeVariant(alert.status)}>
                      {statusLabel(alert.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-charcoal-700">{sourceScopeLabel(alert)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-charcoal-700">{alert.occurrences}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-smoke-500">
                    {formatOpsAlertTimestamp(alert.lastSeenAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    {isResolvable(alert.status) ? (
                      <button
                        type="button"
                        onClick={() => void handleResolve(alert.id)}
                        disabled={resolvingId === alert.id}
                        className="rounded-sm bg-charcoal-900 px-3 py-1 text-xs font-medium text-white hover:bg-charcoal-700 disabled:opacity-50"
                      >
                        {resolvingId === alert.id ? 'Resolvendo…' : 'Resolver'}
                      </button>
                    ) : (
                      <span className="text-xs text-smoke-400">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
