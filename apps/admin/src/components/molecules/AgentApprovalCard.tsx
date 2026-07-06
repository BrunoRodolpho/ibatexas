'use client'

// AgentApprovalCard — the shared presentation of ONE parked managed-agent approval
// (AUT-024). Lifted out of app/admin/aprovacoes/page.tsx so the BKL-105 deep-link
// detail route (app/admin/aprovacoes/[token]/page.tsx) renders the IDENTICAL card
// with no duplicated label/badge/affordance logic. Presentation-only: the parent
// owns the fetch, the resolve POST, the toast, and the reload decision. All copy is
// pt-BR (Hard Rule #4); NO amount/money is invented — only the server-authored
// `prompt` is shown. Every proposition maps to a mapper helper (intentKindLabel /
// statusBadge / resolvedByLabel / formatApprovalDate), never to raw model output.

import { Bot, Clock, User } from 'lucide-react'
import { Badge, Button } from '@ibatexas/ui'
import {
  intentKindLabel,
  statusBadge,
  resolvedByLabel,
  formatApprovalDate,
  AGENT_APPROVALS_COPY as COPY,
  type AgentApprovalRequest,
} from '@/domains/admin/agent-approvals.mappers'

export function AgentApprovalCard({
  approval,
  busy,
  onApprove,
  onReject,
}: Readonly<{
  approval: AgentApprovalRequest
  busy?: boolean
  onApprove?: (token: string) => void
  onReject?: (token: string) => void
}>): React.JSX.Element {
  const badge = statusBadge(approval.status)
  const isPending = approval.status === 'pending'
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-smoke-200 bg-smoke-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-charcoal-900">{intentKindLabel(approval.intentKind)}</h3>
        <Badge variant={badge.variant} className="shrink-0">
          {badge.label}
        </Badge>
      </div>

      <p className="text-sm text-charcoal-700">{approval.prompt}</p>

      <div className="flex flex-col gap-1 border-t border-smoke-100 pt-2 text-xs text-smoke-500">
        <div className="flex items-center gap-1.5">
          <Bot className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">
            {COPY.agent}: {approval.agentNamespace}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Clock className="h-3 w-3 shrink-0" aria-hidden />
          <span className="tabular-nums">
            {COPY.requestedAt}: {formatApprovalDate(approval.requestedAt)}
          </span>
        </div>
        {!isPending ? (
          <>
            <div className="flex items-center gap-1.5">
              <Clock className="h-3 w-3 shrink-0" aria-hidden />
              <span className="tabular-nums">
                {COPY.resolvedAt}: {formatApprovalDate(approval.resolvedAt)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <User className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">
                {COPY.resolvedBy}: {resolvedByLabel(approval.resolvedBy)}
              </span>
            </div>
          </>
        ) : null}
      </div>

      {isPending && onApprove && onReject ? (
        <div className="flex justify-end gap-2 border-t border-smoke-100 pt-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onReject(approval.token)}
          >
            {COPY.reject}
          </Button>
          <Button
            variant="primary"
            size="sm"
            isLoading={busy}
            onClick={() => onApprove(approval.token)}
          >
            {COPY.approve}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
