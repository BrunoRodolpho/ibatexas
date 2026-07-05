'use client'

// Aprovação (detalhe) — the BKL-105 deep-link landing. The parked managed-agent
// approval NATS notification (support.handoff_requested) already carries the
// `approvalToken`; this route (/admin/aprovacoes/[token]) is the one-tap target so
// staff land on the EXACT approval instead of hunting the list. It fetches the
// single projection (GET /api/admin/agent-approvals/:token) and renders the SAME
// AgentApprovalCard the inbox uses, with the SAME manager-gated Aprovar/Rejeitar
// resolve (POST …/:token/resolve → BKL-104 structured outcome). Honest terminal
// states: plane-off (IBX_AGENTS_ENABLED unset), not-found (expired / already
// resolved / bad token), and — because a deep-link can point at an ALREADY-resolved
// token — the resolved card renders read-only with its status badge (no buttons).
// The resolve is 403-gated server-side; a non-manager gets the honest pt-BR toast.
// On a settled resolve we return to the inbox (the toast store is global, so the
// outcome toast persists across the navigation). pt-BR throughout (Hard Rule #4).

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ShieldCheck, ArrowLeft } from 'lucide-react'
import { useToast } from '@ibatexas/ui'
import { AgentApprovalCard } from '@/components/molecules'
import { useAgentApproval } from '@/domains/admin/admin.hooks'
import {
  resolveOutcomeToast,
  resolveErrorToast,
  AGENT_APPROVALS_COPY as COPY,
} from '@/domains/admin/agent-approvals.mappers'

const LIST_PATH = '/admin/aprovacoes'

function Banner({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="rounded-sm border border-dashed border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-sm text-smoke-400">
      {children}
    </div>
  )
}

export default function AprovacaoDetalhePage(): React.JSX.Element {
  const { addToast } = useToast()
  const router = useRouter()
  const params = useParams<{ token: string }>()
  const token = params.token

  const { approval, planeOff, notFound, loading, error, resolveApproval, refetch } =
    useAgentApproval(token)
  const [busy, setBusy] = useState(false)

  // Surface (never swallow) a transient detail-load failure.
  useEffect(() => {
    if (error) {
      addToast({ type: 'error', message: COPY.loadFailed, dedupeKey: 'agent-approval-detail-load' })
    }
  }, [error, addToast])

  async function handleResolve(accept: boolean): Promise<void> {
    setBusy(true)
    try {
      const { ok, status, outcome, decisionKind } = await resolveApproval(accept)
      if (ok) {
        // Outcome-aware, anti-confabulation: a 200 can carry a non-EXECUTE decision;
        // the structured `outcome` explains WHY. Toast then return to the inbox.
        const toast = resolveOutcomeToast(accept, outcome, decisionKind)
        addToast({ type: toast.type, message: toast.message })
        router.push(LIST_PATH)
      } else {
        const toast = resolveErrorToast(status)
        addToast({ type: 'error', message: toast.message })
        // On a projection-changing error (already-resolved / plane-off) reload in
        // place so the card flips to its honest resolved / not-found state.
        if (toast.reload) refetch()
      }
    } catch {
      addToast({ type: 'error', message: COPY.networkError })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Back link ─────────────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => router.push(LIST_PATH)}
        className="flex w-fit items-center gap-1.5 text-xs font-medium text-smoke-500 hover:text-charcoal-700"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {COPY.backToList}
      </button>

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 h-5 w-5 text-charcoal-700" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold text-charcoal-900">{COPY.title}</h1>
          <p className="text-sm text-smoke-500">{COPY.detailSubtitle}</p>
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────────── */}
      {loading && !approval ? (
        <Banner>Carregando…</Banner>
      ) : planeOff ? (
        <Banner>{COPY.planeOff}</Banner>
      ) : notFound ? (
        <Banner>{COPY.notFound}</Banner>
      ) : approval ? (
        <div className="max-w-xl">
          <AgentApprovalCard
            approval={approval}
            busy={busy}
            onApprove={() => void handleResolve(true)}
            onReject={() => void handleResolve(false)}
          />
        </div>
      ) : (
        <Banner>{COPY.loadFailed}</Banner>
      )}
    </div>
  )
}
