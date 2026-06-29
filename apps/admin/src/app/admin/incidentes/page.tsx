'use client'

// Full two-pane Incidentes inbox (no-reply incident system, W3 Phase 3 UI).
// Thin wrapper over the AdminIncidentesPage organism (the design system owns the
// DataTable/filters/stats), plus the IncidentDetailDrawer + write actions wired
// to the W2a REST routes with reload-after-write. The new-incident beep/toast
// lives in the layout-mounted detector (useIncidentNewDetector), NOT here, so it
// never double-fires while this page is open.

import { useCallback, useEffect, useState } from 'react'
import {
  AdminIncidentesPage,
  IncidentDetailDrawer,
  useToast,
  INCIDENT_TOASTS,
  type AdminIncident,
  type IncidentTranscriptMessage,
} from '@ibatexas/ui'
import { useAdminIncidentsPage, STORM_WINDOW_MINUTES } from '@/domains/admin/admin.hooks'
import { apiFetch } from '@/lib/api'

export default function IncidentesPage(): React.JSX.Element {
  const { addToast } = useToast()
  const {
    incidents,
    openCount,
    loading,
    error,
    statusFilter,
    causeFilter,
    severityFilter,
    counts,
    stats,
    dominantCause,
    isHistoryView,
    hasActiveFilters,
    historyPageSize,
    onStatusFilter,
    onCauseFilter,
    onSeverityFilter,
    onClearFilters,
    refetch,
  } = useAdminIncidentsPage()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{
    incident: AdminIncident
    messages: IncidentTranscriptMessage[]
  } | null>(null)

  // Surface (never swallow) list-load failures — escalações swallowed these.
  useEffect(() => {
    if (error) {
      addToast({ type: 'error', message: INCIDENT_TOASTS.loadFailed, dedupeKey: 'incident-load' })
    }
  }, [error, addToast])

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        const data = (await apiFetch(`/api/admin/incidents/${encodeURIComponent(id)}`)) as {
          incident: AdminIncident
          messages?: IncidentTranscriptMessage[]
        }
        setDetail({ incident: data.incident, messages: data.messages ?? [] })
      } catch {
        // Surface + let row re-click / Atualizar act as retry (no swallow).
        addToast({ type: 'error', message: INCIDENT_TOASTS.loadFailed, dedupeKey: 'incident-detail' })
        setDetail(null)
      }
    },
    [addToast],
  )

  useEffect(() => {
    if (!selectedId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale detail when the selection closes
      setDetail(null)
      return
    }
    void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  // ── Enviar (reply) — reload-after-write, {delivered} toasts ──────────────────
  const handleReply = useCallback(
    async (id: string, text: string) => {
      try {
        const res = (await apiFetch(`/api/admin/incidents/${encodeURIComponent(id)}/reply`, {
          method: 'POST',
          body: JSON.stringify({ text }),
        })) as { delivered: boolean }
        addToast(
          res.delivered
            ? { type: 'success', message: INCIDENT_TOASTS.replyDelivered }
            : { type: 'info', message: INCIDENT_TOASTS.replyRecorded },
        )
        await loadDetail(id) // reload-after-write (not optimistic)
        refetch()
      } catch {
        addToast({ type: 'error', message: INCIDENT_TOASTS.replyFailed })
      }
    },
    [addToast, loadDetail, refetch],
  )

  // ── Resolver — discriminated conflict reasons (§4) ───────────────────────────
  const handleResolve = useCallback(
    async (id: string) => {
      try {
        const res = (await apiFetch(`/api/admin/incidents/${encodeURIComponent(id)}/resolve`, {
          method: 'POST',
        })) as { conflict: 'auto_resolved' | 'changed_by_other' | 'invalid_transition' | null }
        if (res.conflict === 'auto_resolved') {
          addToast({ type: 'info', message: INCIDENT_TOASTS.autoResolvedRace })
          await loadDetail(id) // refresh the drawer to the resolved view
          refetch()
          return
        }
        if (res.conflict === 'changed_by_other') {
          addToast({ type: 'error', message: INCIDENT_TOASTS.changedByOther })
          await loadDetail(id)
          refetch()
          return
        }
        if (res.conflict === 'invalid_transition') {
          addToast({ type: 'error', message: INCIDENT_TOASTS.invalidTransition })
          await loadDetail(id)
          refetch()
          return
        }
        addToast({ type: 'success', message: INCIDENT_TOASTS.resolved })
        setSelectedId(null)
        refetch()
      } catch {
        addToast({ type: 'error', message: INCIDENT_TOASTS.loadFailed })
      }
    },
    [addToast, loadDetail, refetch],
  )

  return (
    <>
      <AdminIncidentesPage
        incidents={incidents}
        loading={loading}
        openCount={openCount}
        statusFilter={statusFilter}
        causeFilter={causeFilter}
        severityFilter={severityFilter}
        counts={counts}
        stats={stats}
        dominantCause={dominantCause}
        stormWindowMinutes={STORM_WINDOW_MINUTES}
        isHistoryView={isHistoryView}
        hasActiveFilters={hasActiveFilters}
        historyPageSize={historyPageSize}
        onStatusFilter={onStatusFilter}
        onCauseFilter={onCauseFilter}
        onSeverityFilter={onSeverityFilter}
        onClearFilters={onClearFilters}
        onRefresh={refetch}
        onRowClick={(inc) => setSelectedId(inc.id)}
      />

      <IncidentDetailDrawer
        incident={detail?.incident ?? null}
        open={selectedId !== null}
        messages={detail?.messages ?? []}
        onClose={() => setSelectedId(null)}
        onReply={handleReply}
        onResolve={handleResolve}
        onNavigatePrior={(priorId) => setSelectedId(priorId)}
      />
    </>
  )
}
