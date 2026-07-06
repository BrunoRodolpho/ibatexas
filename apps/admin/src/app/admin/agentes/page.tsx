'use client'

// Agentes — the operator surface for the per-agent kill switch (BKL-099): the
// emergency brake for a managed agent, one click instead of a curl. Lists the
// managed-agent roster + each agent's kill status (GET /api/admin/agents/kill-
// status, 30s poll) with a Parar/Restaurar toggle. Tripping the brake (Parar) is
// confirm-gated via a Modal (a manager safety control), restoring fires directly.
// The whole surface is MANAGER-gated server-side (requireManagerRole → 403 on the
// read AND the writes): a non-manager sees the honest "sem permissão" banner, and
// the plane-off 503 renders the honest disabled banner — never a crash. reload-
// after-write (NOT optimistic — mirrors aprovacoes); an outcome that disagrees
// with the intent is reported honestly, never faked. All non-trivial logic
// (labels, plan, honest toast copy) lives in the PURE agent-killswitch.mappers
// module. pt-BR (Hard Rule #4).

import { useEffect, useState } from 'react'
import { Power, Bot, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, Modal, useToast } from '@ibatexas/ui'
import { useAgentKillSwitch } from '@/domains/admin/admin.hooks'
import {
  agentDisplayName,
  statusBadge,
  actionLabel,
  planKillToggle,
  killOutcomeToast,
  killErrorToast,
  KILL_CONFIRM,
  AGENT_KILLSWITCH_COPY as COPY,
  type AgentKillStatus,
} from '@/domains/admin/agent-killswitch.mappers'

// ── Plane-off / forbidden / empty banner ──────────────────────────────────────

function Banner({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="rounded-sm border border-dashed border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-sm text-smoke-400">
      {children}
    </div>
  )
}

// ── Agent row ──────────────────────────────────────────────────────────────────

function AgentRow({
  agent,
  busy,
  onToggle,
}: Readonly<{
  agent: AgentKillStatus
  busy: boolean
  onToggle: (agent: AgentKillStatus) => void
}>): React.JSX.Element {
  const badge = statusBadge(agent.killed)
  return (
    <Card className="flex flex-col gap-3 border border-smoke-200 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-charcoal-700" aria-hidden />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-charcoal-900">
            {agentDisplayName(agent.agentId)}
          </h3>
          <p className="truncate text-xs text-smoke-500">
            {COPY.agentId}: {agent.agentId}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <Button
          variant={agent.killed ? 'primary' : 'secondary'}
          size="sm"
          isLoading={busy}
          disabled={busy}
          onClick={() => onToggle(agent)}
        >
          {actionLabel(agent.killed)}
        </Button>
      </div>
    </Card>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default function AgentesPage(): React.JSX.Element {
  const { addToast } = useToast()
  const { agents, planeOff, forbidden, loading, error, toggleAgent, refetch } = useAgentKillSwitch()

  const [busyId, setBusyId] = useState<string | null>(null)
  // The agent awaiting a Parar (kill) confirm, or null when the dialog is closed.
  const [confirmAgent, setConfirmAgent] = useState<AgentKillStatus | null>(null)

  // Surface (never swallow) roster-load failures.
  useEffect(() => {
    if (error) {
      addToast({ type: 'error', message: COPY.loadFailed, dedupeKey: 'agent-killswitch-load' })
    }
  }, [error, addToast])

  async function perform(agent: AgentKillStatus): Promise<void> {
    const plan = planKillToggle(agent)
    setBusyId(agent.agentId)
    try {
      const { ok, status, killed } = await toggleAgent(agent.agentId, plan.intent)
      if (ok) {
        // Outcome-aware: the 200 body carries the AUTHORITATIVE written state
        // (the routes always echo `killed`; assume the intended state only if a
        // 200 somehow lacked it).
        const toast = killOutcomeToast(plan.intent, killed ?? (plan.intent === 'kill'))
        addToast({ type: toast.type, message: toast.message })
        refetch()
      } else {
        const toast = killErrorToast(status)
        addToast({ type: 'error', message: toast.message })
        if (toast.reload) refetch()
      }
    } catch {
      addToast({ type: 'error', message: COPY.networkError })
    } finally {
      setBusyId(null)
    }
  }

  // A click routes through the plan: tripping the brake (kill) opens the confirm
  // step; restoring fires directly.
  function handleToggle(agent: AgentKillStatus): void {
    if (busyId !== null) return
    if (planKillToggle(agent).requiresConfirm) {
      setConfirmAgent(agent)
      return
    }
    void perform(agent)
  }

  function confirmKill(): void {
    const target = confirmAgent
    setConfirmAgent(null)
    if (target) void perform(target)
  }

  const killedCount = agents.filter((a) => a.killed).length

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Power className="mt-0.5 h-5 w-5 text-charcoal-700" aria-hidden />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-charcoal-900">{COPY.title}</h1>
              {!planeOff && !forbidden && killedCount > 0 ? (
                <Badge variant="danger" className="tabular-nums">
                  {killedCount} {killedCount === 1 ? 'parado' : 'parados'}
                </Badge>
              ) : null}
            </div>
            <p className="text-sm text-smoke-500">{COPY.subtitle}</p>
          </div>
        </div>
        {!planeOff && !forbidden ? (
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
      ) : forbidden ? (
        <Banner>{COPY.forbidden}</Banner>
      ) : loading && agents.length === 0 ? (
        <Banner>Carregando…</Banner>
      ) : agents.length === 0 ? (
        <Banner>{COPY.empty}</Banner>
      ) : (
        <div className="flex flex-col gap-3">
          {agents.map((a) => (
            <AgentRow
              key={a.agentId}
              agent={a}
              busy={busyId === a.agentId}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}

      {/* ── Kill confirm dialog (manager safety control) ────────────────────── */}
      <Modal
        isOpen={confirmAgent !== null}
        onClose={() => setConfirmAgent(null)}
        title={KILL_CONFIRM.title}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmAgent(null)}
              disabled={busyId !== null}
            >
              {KILL_CONFIRM.cancelLabel}
            </Button>
            <Button
              variant="primary"
              size="sm"
              isLoading={busyId !== null}
              onClick={confirmKill}
            >
              {KILL_CONFIRM.confirmLabel}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-charcoal-700">
          {confirmAgent ? (
            <>
              <span className="font-semibold">{agentDisplayName(confirmAgent.agentId)}</span> —{' '}
            </>
          ) : null}
          {KILL_CONFIRM.body}
        </p>
      </Modal>
    </div>
  )
}
