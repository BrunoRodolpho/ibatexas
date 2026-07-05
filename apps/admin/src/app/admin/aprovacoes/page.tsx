'use client'

// Aprovações — the one-tap inbox for parked managed-agent actions (AUT-024). When
// a managed agent's turn adjudicates into the CONFIRM band the kernel PARKS the
// envelope; a manager must approve before it executes. This page lists the pending
// approvals (GET /api/admin/agent-approvals?status=pending, 30s poll) with Aprovar/
// Rejeitar one-tap resolve (POST …/:token/resolve { accept }), plus a toggleable
// resolved-history section. Reads are admin-guarded but NOT role-tightened; the
// resolve is manager-gated server-side (requireManagerRole → 403), and there is no
// client-side role gate here (the JWT is httpOnly) — the buttons render for
// everyone and a 403 maps to an honest pt-BR toast. reload-after-write (NOT
// optimistic — mirrors incidentes). All non-trivial logic (labels, plan, honest
// toast copy) lives in the PURE agent-approvals.mappers module. pt-BR (Hard Rule
// #4); NO amount/money display is invented — only the server-authored `prompt`.

import { useEffect, useState } from 'react'
import { ShieldCheck, RefreshCw } from 'lucide-react'
import { Badge, SectionHeader, useToast } from '@ibatexas/ui'
import { AgentApprovalCard } from '@/components/molecules'
import { useAgentApprovals, useAgentApprovalHistory } from '@/domains/admin/admin.hooks'
import {
  resolveOutcomeToast,
  resolveErrorToast,
  AGENT_APPROVALS_COPY as COPY,
} from '@/domains/admin/agent-approvals.mappers'

// ── Plane-off / empty banners ─────────────────────────────────────────────────

function Banner({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="rounded-sm border border-dashed border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-sm text-smoke-400">
      {children}
    </div>
  )
}

// ── Resolved-history section (lazy, toggleable) ───────────────────────────────

function ResolvedHistory({
  open,
  onToggle,
  reloadSignal,
}: Readonly<{ open: boolean; onToggle: () => void; reloadSignal: number }>): React.JSX.Element {
  const { addToast } = useToast()
  const { history, planeOff, loading, error, refetch } = useAgentApprovalHistory(open)

  // Refetch when a resolve settles upstream (the reloadSignal counter bumps).
  useEffect(() => {
    if (open && reloadSignal > 0) refetch()
  }, [reloadSignal, open, refetch])

  useEffect(() => {
    if (error) {
      addToast({ type: 'error', message: COPY.loadFailed, dedupeKey: 'agent-approvals-history-load' })
    }
  }, [error, addToast])

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title={COPY.historyToggle} collapsible expanded={open} onToggle={onToggle} />
      {open ? (
        loading && history.length === 0 ? (
          <Banner>Carregando…</Banner>
        ) : planeOff ? (
          <Banner>{COPY.planeOff}</Banner>
        ) : history.length === 0 ? (
          <Banner>{COPY.emptyHistory}</Banner>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {history.map((a) => (
              <AgentApprovalCard key={a.token} approval={a} />
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AprovacoesPage(): React.JSX.Element {
  const { addToast } = useToast()
  const { approvals, planeOff, loading, error, resolveApproval, refetch } = useAgentApprovals()

  const [busyToken, setBusyToken] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // Bumped after each settled resolve so the (lazy) history section re-fetches.
  const [reloadSignal, setReloadSignal] = useState(0)

  // Surface (never swallow) list-load failures.
  useEffect(() => {
    if (error) {
      addToast({ type: 'error', message: COPY.loadFailed, dedupeKey: 'agent-approvals-load' })
    }
  }, [error, addToast])

  async function handleResolve(token: string, accept: boolean): Promise<void> {
    setBusyToken(token)
    try {
      const { ok, status, outcome, decisionKind } = await resolveApproval(token, accept)
      if (ok) {
        // Outcome-aware, anti-confabulation: a 200 can carry a non-EXECUTE
        // decision; the structured `outcome` explains WHY it was not executed.
        const toast = resolveOutcomeToast(accept, outcome, decisionKind)
        addToast({ type: toast.type, message: toast.message })
        refetch()
        setReloadSignal((s) => s + 1)
      } else {
        const toast = resolveErrorToast(status)
        addToast({ type: 'error', message: toast.message })
        if (toast.reload) {
          refetch()
          setReloadSignal((s) => s + 1)
        }
      }
    } catch {
      addToast({ type: 'error', message: COPY.networkError })
    } finally {
      setBusyToken(null)
    }
  }

  const pendingCount = approvals.length

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-charcoal-700" aria-hidden />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-charcoal-900">{COPY.title}</h1>
              {!planeOff && pendingCount > 0 ? (
                <Badge variant="warning" className="tabular-nums">
                  {pendingCount} {pendingCount === 1 ? 'pendente' : 'pendentes'}
                </Badge>
              ) : null}
            </div>
            <p className="text-sm text-smoke-500">{COPY.subtitle}</p>
          </div>
        </div>
        {!planeOff ? (
          <button
            type="button"
            onClick={refetch}
            className="flex items-center gap-1.5 rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1.5 text-xs font-medium text-charcoal-700 hover:bg-smoke-100"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Atualizar
          </button>
        ) : null}
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      {planeOff ? (
        <Banner>{COPY.planeOff}</Banner>
      ) : (
        <>
          {loading && approvals.length === 0 ? (
            <Banner>Carregando…</Banner>
          ) : approvals.length === 0 ? (
            <Banner>{COPY.emptyPending}</Banner>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {approvals.map((a) => (
                <AgentApprovalCard
                  key={a.token}
                  approval={a}
                  busy={busyToken === a.token}
                  onApprove={(token) => void handleResolve(token, true)}
                  onReject={(token) => void handleResolve(token, false)}
                />
              ))}
            </div>
          )}

          <ResolvedHistory
            open={historyOpen}
            onToggle={() => setHistoryOpen((v) => !v)}
            reloadSignal={reloadSignal}
          />
        </>
      )}
    </div>
  )
}
