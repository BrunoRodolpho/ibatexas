'use client'

import { createColumnHelper, type Row } from '@tanstack/react-table'
import { AlertTriangle, RefreshCw, X, ShieldCheck } from 'lucide-react'
import { DataTable } from '../atoms/DataTable'
import { Badge } from '../atoms/Badge'
import { StatCard } from '../atoms/StatCard'
import { PageHeader } from '../atoms/PageHeader'
import { EmptyState } from '../atoms/EmptyState'
import { Button } from '../atoms/Button'
import { PageShell } from '../layouts/PageShell'
import { FilterBar } from '../molecules/FilterBar'
import { FilterChip } from '../molecules/FilterChip'
import { StormDigestBanner } from './StormDigestBanner'
import type { AdminIncident } from './IncidentDetailDrawer'
import { incidentStatusVariant } from '../utils/status-variant'
import { formatAge, isAged } from '../utils/format'
import {
  INCIDENT_LABELS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_CAUSE_LABELS,
  INCIDENT_STATUS_FILTERS,
  INCIDENT_CAUSE_FILTERS,
  INCIDENT_SEVERITY_FILTERS,
  INCIDENT_COLUMN_HEADERS,
  INCIDENT_EMPTY,
  INCIDENT_STAT_LABELS,
  EMPTY_STATES,
  ACTION_LABELS,
} from '../constants/admin-labels'

const col = createColumnHelper<AdminIncident>()

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['AUTO_RESOLVED', 'RESOLVED'])

// Filter-chip dots (§3/§6). Only the actionable buckets carry a colored dot.
const STATUS_CHIP_DOT: Record<string, string> = {
  OPEN: 'bg-accent-red',
  ACKNOWLEDGED: 'bg-accent-amber',
}
const SEVERITY_CHIP_DOT: Record<string, string> = {
  high: 'bg-accent-red',
  medium: 'bg-accent-amber',
  low: 'bg-smoke-300',
}
const SEVERITY_DOT: Record<string, string> = {
  high: 'bg-accent-red',
  medium: 'bg-accent-amber',
  low: 'bg-smoke-400',
}

export interface IncidentInboxCounts {
  readonly open: number
  readonly acknowledged: number
  readonly high: number
  readonly medium: number
  readonly low: number
}

export interface IncidentInboxStats {
  readonly open: number
  readonly acknowledged: number
  readonly resolvedToday: number
  readonly resolvedAuto: number
  readonly resolvedStaff: number
  readonly avgMinutes: number
}

export interface AdminIncidentesPageProps {
  readonly incidents: AdminIncident[]
  readonly loading: boolean
  readonly openCount: number
  readonly statusFilter: string
  readonly causeFilter: string
  readonly severityFilter: string
  readonly counts: IncidentInboxCounts
  readonly stats: IncidentInboxStats
  readonly dominantCause: string
  readonly stormWindowMinutes: number
  readonly isHistoryView: boolean
  readonly hasActiveFilters: boolean
  readonly historyPageSize: number
  readonly onStatusFilter: (id: string) => void
  readonly onCauseFilter: (id: string) => void
  readonly onSeverityFilter: (id: string) => void
  readonly onClearFilters: () => void
  readonly onRefresh: () => void
  readonly onRowClick: (incident: AdminIncident) => void
}

function channelLabel(channel: string): string {
  return channel === 'whatsapp' ? 'WhatsApp' : channel
}

function customerLabel(inc: AdminIncident): string {
  if (inc.customerName) return inc.customerName
  if (inc.customerPhoneMasked) return inc.customerPhoneMasked
  if (inc.senderRef) {
    const phone = inc.senderRef.replace(/^whatsapp:/, '')
    return phone.length <= 6 ? phone : `${phone.slice(0, 3)}•••${phone.slice(-4)}`
  }
  return '—'
}

/** ·silêncio (ghost — nothing reached the customer) vs ·aviso enviado (degraded). */
function ImpactTag({ impacted }: { readonly impacted: boolean }) {
  return impacted ? (
    <span className="text-accent-red">{INCIDENT_LABELS.impactedSilence}</span>
  ) : (
    <span className="text-smoke-600">{INCIDENT_LABELS.impactedNotice}</span>
  )
}

function SeverityCell({ severity }: { readonly severity: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[severity] ?? 'bg-smoke-400'}`} />
      <span>{INCIDENT_SEVERITY_LABELS[severity] ?? severity}</span>
    </div>
  )
}

function AgeCell({ inc }: { readonly inc: AdminIncident }) {
  const active = !TERMINAL_STATUSES.has(inc.status)
  const aged = active && isAged(inc.openedAt)
  return (
    <span className={aged ? 'text-accent-red' : 'text-charcoal-700'}>
      {formatAge(inc.openedAt)}
      {aged && (
        <span className="ml-1 text-[10px] uppercase tracking-wide text-accent-red/80">
          {INCIDENT_LABELS.neverReturned}
        </span>
      )}
    </span>
  )
}

function StatusCell({ inc }: { readonly inc: AdminIncident }) {
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={incidentStatusVariant(inc.status)} className="text-xs">
        {INCIDENT_STATUS_LABELS[inc.status] ?? inc.status}
      </Badge>
      {inc.priorIncidentId && (
        <Badge variant="warning" className="text-xs">
          {INCIDENT_LABELS.reopenedTag}
        </Badge>
      )}
    </div>
  )
}

// Severity left-tint (§3/§6) — the first eye-draw; history rows recede (no tint).
function rowClassName(inc: AdminIncident): string {
  if (TERMINAL_STATUSES.has(inc.status)) return 'text-smoke-500'
  if (inc.severity === 'high') return 'border-l-2 border-accent-red bg-accent-red/[0.06]'
  if (inc.severity === 'medium') return 'border-l-2 border-accent-amber'
  return 'border-l-2 border-smoke-300'
}

/**
 * The Incidentes inbox (list view, §3). Presentational organism — mirrors the
 * `AdminPedidosPage` idiom (the design system owns the DataTable/@tanstack;
 * pages stay thin). The detail drawer + write actions are rendered by the page
 * (they need async transcript loads + toasts). The list is server-pre-sorted
 * (status-bucket → aged-first → severity desc); client click-sort layers on top.
 */
export function AdminIncidentesPage({
  incidents,
  loading,
  openCount,
  statusFilter,
  causeFilter,
  severityFilter,
  counts,
  stats,
  dominantCause,
  stormWindowMinutes,
  isHistoryView,
  hasActiveFilters,
  historyPageSize,
  onStatusFilter,
  onCauseFilter,
  onSeverityFilter,
  onClearFilters,
  onRefresh,
  onRowClick,
}: AdminIncidentesPageProps) {
  const columns = [
    col.accessor('severity', {
      header: INCIDENT_COLUMN_HEADERS.severity,
      cell: (i) => <SeverityCell severity={i.getValue()} />,
    }),
    col.accessor('cause', {
      header: INCIDENT_COLUMN_HEADERS.cause,
      cell: (i) => (
        <Badge variant="default" className="text-xs">
          {INCIDENT_CAUSE_LABELS[i.getValue()] ?? i.getValue()}
        </Badge>
      ),
    }),
    col.display({
      id: 'customer',
      header: INCIDENT_COLUMN_HEADERS.customer,
      cell: (i) => {
        const inc = i.row.original
        return (
          <span>
            {customerLabel(inc)} <ImpactTag impacted={inc.customerImpacted} />
          </span>
        )
      },
    }),
    col.accessor('channel', {
      header: INCIDENT_COLUMN_HEADERS.channel,
      cell: (i) => channelLabel(i.getValue()),
    }),
    col.accessor('dropCount', {
      header: INCIDENT_COLUMN_HEADERS.drops,
      cell: (i) => {
        const n = i.getValue()
        return (
          <span className={`tabular-nums ${n >= 2 ? 'font-semibold text-accent-red' : 'text-charcoal-700'}`}>
            ⟨{n}⟩
          </span>
        )
      },
    }),
    col.accessor('status', {
      header: INCIDENT_COLUMN_HEADERS.status,
      cell: (i) => <StatusCell inc={i.row.original} />,
    }),
    col.accessor('openedAt', {
      header: INCIDENT_COLUMN_HEADERS.age,
      cell: (i) => <AgeCell inc={i.row.original} />,
    }),
  ]

  const mobileCardRenderer = (row: Row<AdminIncident>) => {
    const inc = row.original
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <SeverityCell severity={inc.severity} />
          <StatusCell inc={inc} />
        </div>
        <Badge variant="default" className="text-xs">
          {INCIDENT_CAUSE_LABELS[inc.cause] ?? inc.cause}
        </Badge>
        <div className="text-sm text-charcoal-700">
          {customerLabel(inc)} <ImpactTag impacted={inc.customerImpacted} />
        </div>
        <div className="flex items-center justify-between text-xs text-smoke-500">
          <span>
            {channelLabel(inc.channel)} · {INCIDENT_COLUMN_HEADERS.drops} ⟨{inc.dropCount}⟩
          </span>
          <AgeCell inc={inc} />
        </div>
      </div>
    )
  }

  const showHealthyEmpty = !loading && incidents.length === 0 && !hasActiveFilters && openCount === 0
  const showFilteredEmpty = !loading && incidents.length === 0 && hasActiveFilters

  return (
    <PageShell>
      <PageHeader
        icon={AlertTriangle}
        title={INCIDENT_LABELS.pageTitle}
        subtitle={INCIDENT_LABELS.pageSubtitle}
        action={
          <Button variant="secondary" size="sm" onClick={onRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />
            {ACTION_LABELS.refresh}
          </Button>
        }
      />

      <StormDigestBanner
        openCount={openCount}
        windowMinutes={stormWindowMinutes}
        dominantCause={dominantCause}
        onFilterByCause={onCauseFilter}
      />

      {/* StatCard strip (§3) */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label={INCIDENT_STAT_LABELS.open}
          value={stats.open}
          variant="danger"
          subLabel={INCIDENT_STAT_LABELS.openSub}
          isLoading={loading}
        />
        <StatCard
          label={INCIDENT_STAT_LABELS.acknowledged}
          value={stats.acknowledged}
          variant="warning"
          subLabel={INCIDENT_STAT_LABELS.acknowledgedSub}
          isLoading={loading}
        />
        <StatCard
          label={INCIDENT_STAT_LABELS.resolvedToday}
          value={stats.resolvedToday}
          variant="success"
          subLabel={INCIDENT_STAT_LABELS.resolvedSub(stats.resolvedAuto, stats.resolvedStaff)}
          isLoading={loading}
        />
        <StatCard
          label={INCIDENT_STAT_LABELS.avgTime}
          value={`${stats.avgMinutes} min`}
          variant="info"
          subLabel={INCIDENT_STAT_LABELS.avgTimeSub}
          isLoading={loading}
        />
      </div>

      {/* Status filter */}
      <FilterBar>
        {INCIDENT_STATUS_FILTERS.map((f) => {
          let count: number | undefined
          if (f.id === 'OPEN') count = counts.open
          else if (f.id === 'ACKNOWLEDGED') count = counts.acknowledged
          return (
            <FilterChip
              key={f.id || 'status-all'}
              id={f.id || 'status-all'}
              label={f.label}
              selected={statusFilter === f.id}
              onToggle={() => onStatusFilter(f.id)}
              dot={STATUS_CHIP_DOT[f.id]}
              count={count}
            />
          )
        })}
      </FilterBar>

      {/* Cause + severity filter */}
      <FilterBar>
        {INCIDENT_CAUSE_FILTERS.map((f) => (
          <FilterChip
            key={f.id || 'cause-all'}
            id={f.id || 'cause-all'}
            label={f.label}
            selected={causeFilter === f.id}
            onToggle={() => onCauseFilter(f.id)}
          />
        ))}
        <span className="mx-1 h-3 w-px bg-smoke-200" />
        {INCIDENT_SEVERITY_FILTERS.map((f) => {
          let count: number | undefined
          if (f.id === 'high') count = counts.high
          else if (f.id === 'medium') count = counts.medium
          else if (f.id === 'low') count = counts.low
          return (
            <FilterChip
              key={f.id || 'severity-all'}
              id={f.id || 'severity-all'}
              label={f.label}
              selected={severityFilter === f.id}
              onToggle={() => onSeverityFilter(f.id)}
              dot={SEVERITY_CHIP_DOT[f.id]}
              count={count}
            />
          )
        })}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            className="ml-auto flex items-center gap-1 text-sm text-[var(--color-text-secondary)] hover:text-charcoal-700"
          >
            <X className="h-3.5 w-3.5" />
            {ACTION_LABELS.clearFilters}
          </button>
        )}
      </FilterBar>

      {/* Queue / empty states (§5) */}
      {showHealthyEmpty ? (
        <EmptyState icon={ShieldCheck} title={INCIDENT_EMPTY.title} subtitle={INCIDENT_EMPTY.subtitle} />
      ) : showFilteredEmpty ? (
        <EmptyState
          title={EMPTY_STATES.incidentsFiltered}
          action={
            <Button variant="secondary" size="sm" onClick={onClearFilters}>
              <X className="h-3.5 w-3.5" />
              {ACTION_LABELS.clearFilters}
            </Button>
          }
        />
      ) : (
        <DataTable<AdminIncident>
          data={incidents}
          columns={columns}
          isLoading={loading}
          // F1: the active OPEN/ACK queue is server-pre-sorted + UNPAGINATED;
          // only the Resolvidos/history view paginates (client-side here).
          pageSize={isHistoryView ? historyPageSize : 1000}
          emptyMessage={EMPTY_STATES.incidents}
          onRowClick={onRowClick}
          rowClassName={rowClassName}
          mobileCardRenderer={mobileCardRenderer}
        />
      )}
    </PageShell>
  )
}
