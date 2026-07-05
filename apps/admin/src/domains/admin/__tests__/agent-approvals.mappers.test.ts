// Unit tests for the PURE agent-approvals helpers (AUT-024). No React, no network
// — pure logic. Covers the endpoint/path builders, the pt-BR intentKind + status
// label maps, the resolved-by identity, the date formatter, the history sort, the
// resolve plan, and the DECISION-AWARE / status-keyed toast copy — including the
// honest-copy invariants (a non-EXECUTE 200 never reads as "executed"; an error
// never reads as success). Mirrors the customers.mappers.test style.

import { describe, it, expect } from 'vitest'
import {
  listPath,
  resolvePath,
  detailPath,
  isPlaneOffMessage,
  AGENT_APPROVALS_ENDPOINT,
  intentKindLabel,
  statusBadge,
  resolvedByLabel,
  formatApprovalDate,
  sortByResolvedAtDesc,
  planResolve,
  resolveResultToast,
  resolveOutcomeToast,
  resolveErrorToast,
  type AgentApprovalRequest,
  type AgentApprovalOutcome,
  type AgentApprovalOutcomeStatus,
} from '../agent-approvals.mappers'

const req = (over: Partial<AgentApprovalRequest>): AgentApprovalRequest => ({
  token: 't1',
  agentNamespace: 'agent:ops-manager',
  intentKind: 'pix.charge.refund',
  intentHash: 'h1',
  prompt: 'Reembolsar R$ 50,00 do pedido #1234?',
  status: 'pending',
  requestedAt: '2026-07-04T12:00:00.000Z',
  ...over,
})

describe('listPath / resolvePath', () => {
  it('builds the unfiltered list path and per-status filters', () => {
    expect(listPath()).toBe('/api/admin/agent-approvals')
    expect(listPath('pending')).toBe('/api/admin/agent-approvals?status=pending')
    expect(listPath('approved')).toBe('/api/admin/agent-approvals?status=approved')
    expect(listPath('rejected')).toBe('/api/admin/agent-approvals?status=rejected')
  })
  it('resolve path targets the single-use token resolve verb (encoded)', () => {
    expect(resolvePath('abc-123')).toBe('/api/admin/agent-approvals/abc-123/resolve')
    expect(resolvePath('a/b')).toBe('/api/admin/agent-approvals/a%2Fb/resolve')
    expect(AGENT_APPROVALS_ENDPOINT).toBe('/api/admin/agent-approvals')
  })
  it('detail path (BKL-105 deep-link) targets the single-token projection (encoded, no /resolve)', () => {
    expect(detailPath('abc-123')).toBe('/api/admin/agent-approvals/abc-123')
    expect(detailPath('a/b')).toBe('/api/admin/agent-approvals/a%2Fb')
  })
})

describe('isPlaneOffMessage (BKL-105 — disambiguate the detail 404)', () => {
  it('true only when the body carries the plane-off marker', () => {
    // The server PLANE_OFF constant carries the IBX_AGENTS_ENABLED marker.
    expect(isPlaneOffMessage('managed-agent plane not enabled (IBX_AGENTS_ENABLED)')).toBe(true)
  })
  it('false for the not-found body and for missing/blank messages', () => {
    expect(isPlaneOffMessage('approval not found')).toBe(false)
    expect(isPlaneOffMessage(undefined)).toBe(false)
    expect(isPlaneOffMessage('')).toBe(false)
  })
})

describe('intentKindLabel', () => {
  it('maps known agent-parkable kinds to pt-BR', () => {
    expect(intentKindLabel('payment.pix.regenerate')).toBe('Regenerar cobrança PIX')
    expect(intentKindLabel('pix.charge.refund')).toBe('Reembolso PIX')
    expect(intentKindLabel('product.availability.set')).toBe('Disponibilidade de item (86 / liberar)')
    expect(intentKindLabel('product.price.set')).toBe('Alterar preço de item')
  })
  it('falls back to the raw kind string when unmapped (never blank)', () => {
    expect(intentKindLabel('some.new.kind')).toBe('some.new.kind')
    expect(intentKindLabel('')).toBe('')
  })
})

describe('statusBadge', () => {
  it('pending is an amber warning (the actionable state)', () => {
    expect(statusBadge('pending')).toEqual({ label: 'Pendente', variant: 'warning' })
  })
  it('approved is a green success, rejected is a red danger', () => {
    expect(statusBadge('approved')).toEqual({ label: 'Aprovada', variant: 'success' })
    expect(statusBadge('rejected')).toEqual({ label: 'Rejeitada', variant: 'danger' })
  })
})

describe('resolvedByLabel', () => {
  it('prefers displayName, falls back to id, then em-dash', () => {
    expect(resolvedByLabel({ id: 'staff_1', displayName: 'Maria' })).toBe('Maria')
    expect(resolvedByLabel({ id: 'staff_1' })).toBe('staff_1')
    expect(resolvedByLabel({ id: '   ', displayName: '  ' })).toBe('—')
    expect(resolvedByLabel(undefined)).toBe('—')
  })
})

describe('formatApprovalDate', () => {
  it('renders the em-dash for null / malformed input', () => {
    expect(formatApprovalDate(null)).toBe('—')
    expect(formatApprovalDate('not-a-date')).toBe('—')
  })
  it('renders a non-empty pt-BR datetime for a valid ISO string', () => {
    const out = formatApprovalDate('2026-07-04T12:00:00.000Z')
    expect(out).not.toBe('—')
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('sortByResolvedAtDesc', () => {
  it('orders most-recently-resolved first without mutating the input', () => {
    const a = req({ token: 'a', resolvedAt: '2026-07-04T10:00:00.000Z', status: 'approved' })
    const b = req({ token: 'b', resolvedAt: '2026-07-04T12:00:00.000Z', status: 'rejected' })
    const input = [a, b]
    const sorted = sortByResolvedAtDesc(input)
    expect(sorted.map((r) => r.token)).toEqual(['b', 'a'])
    expect(input.map((r) => r.token)).toEqual(['a', 'b']) // input untouched
  })
  it('falls back to requestedAt when resolvedAt is absent', () => {
    const a = req({ token: 'a', requestedAt: '2026-07-04T09:00:00.000Z' })
    const b = req({ token: 'b', requestedAt: '2026-07-04T11:00:00.000Z' })
    expect(sortByResolvedAtDesc([a, b]).map((r) => r.token)).toEqual(['b', 'a'])
  })
})

describe('planResolve', () => {
  it('carries the token in the path and the accept flag in the body (key is `accept`)', () => {
    expect(planResolve('t9', true)).toEqual({
      path: '/api/admin/agent-approvals/t9/resolve',
      body: { accept: true },
    })
    expect(planResolve('t9', false).body).toEqual({ accept: false })
    // Guard against the `accepted` (wrong-key) regression.
    expect('accepted' in planResolve('t9', true).body).toBe(false)
  })
})

describe('resolveResultToast (decision-aware, anti-confabulation)', () => {
  it('a rejection is an honest success', () => {
    expect(resolveResultToast(false)).toEqual({
      type: 'success',
      message: 'Solicitação do agente rejeitada.',
    })
  })
  it('an approval that EXECUTEs (or REWRITEs) reports executed', () => {
    expect(resolveResultToast(true, 'EXECUTE')).toEqual({
      type: 'success',
      message: 'Ação do agente aprovada e executada.',
    })
    expect(resolveResultToast(true, 'REWRITE').message).toBe('Ação do agente aprovada e executada.')
  })
  it('an approval that came back REFUSE/re-park NEVER reads as executed (200 ≠ executed)', () => {
    for (const kind of ['REFUSE', 'REQUEST_CONFIRMATION', 'ESCALATE', undefined]) {
      const toast = resolveResultToast(true, kind)
      expect(toast.type).toBe('info')
      // Never the positive-execution claim; explicitly reports NOT executed.
      expect(toast.message).not.toContain('aprovada e executada')
      expect(toast.message).toContain('não foi executada')
    }
  })
})

describe('resolveOutcomeToast (structured outcome, anti-confabulation)', () => {
  const out = (over: Partial<AgentApprovalOutcome> & { status: AgentApprovalOutcomeStatus }): AgentApprovalOutcome => over

  it('executed is the ONLY status that reads as executed', () => {
    expect(resolveOutcomeToast(true, out({ status: 'executed', decisionKind: 'EXECUTE' }))).toEqual({
      type: 'success',
      message: 'Ação do agente aprovada e executada.',
    })
  })

  it('rejected is an honest success', () => {
    expect(resolveOutcomeToast(false, out({ status: 'rejected' }))).toEqual({
      type: 'success',
      message: 'Solicitação do agente rejeitada.',
    })
  })

  it('refused reports WHY — the kernel refusal text — and never reads as executed', () => {
    const toast = resolveOutcomeToast(
      true,
      out({
        status: 'refused',
        decisionKind: 'REFUSE',
        reasonCode: 'payment.already_terminal',
        refusalPtBr: 'Este pagamento já foi finalizado.',
      }),
    )
    expect(toast.type).toBe('info')
    expect(toast.message).toContain('não foi executada')
    expect(toast.message).toContain('Este pagamento já foi finalizado.')
    expect(toast.message).not.toContain('aprovada e executada')
  })

  it('reparked reports the need for a fresh confirmation', () => {
    const toast = resolveOutcomeToast(true, out({ status: 'reparked', decisionKind: 'REQUEST_CONFIRMATION' }))
    expect(toast.type).toBe('info')
    expect(toast.message).toContain('não foi executada')
    expect(toast.message).toMatch(/confirmação/i)
  })

  it('escalated reports the need for escalation', () => {
    const toast = resolveOutcomeToast(true, out({ status: 'escalated', decisionKind: 'ESCALATE' }))
    expect(toast.type).toBe('info')
    expect(toast.message).toContain('não foi executada')
    expect(toast.message).toMatch(/escalação/i)
  })

  it('denied_by_kernel fails honestly (not executed)', () => {
    const toast = resolveOutcomeToast(true, out({ status: 'denied_by_kernel' }))
    expect(toast.type).toBe('info')
    expect(toast.message).toContain('não foi executada')
  })

  it('ANTI-CONFABULATION: no non-executed status ever reads as "aprovada e executada"', () => {
    const statuses: AgentApprovalOutcomeStatus[] = [
      'rejected',
      'refused',
      'reparked',
      'escalated',
      'denied_by_kernel',
    ]
    for (const status of statuses) {
      const toast = resolveOutcomeToast(status !== 'rejected', out({ status }))
      expect(toast.message).not.toContain('aprovada e executada')
    }
  })

  it('back-compat: no structured outcome → falls back to decision-kind inference (still honest)', () => {
    expect(resolveOutcomeToast(true, undefined, 'EXECUTE')).toEqual({
      type: 'success',
      message: 'Ação do agente aprovada e executada.',
    })
    const fallback = resolveOutcomeToast(true, undefined, 'REFUSE')
    expect(fallback.type).toBe('info')
    expect(fallback.message).toContain('não foi executada')
    expect(fallback.message).not.toContain('aprovada e executada')
  })
})

describe('resolveErrorToast (status → pt-BR copy + reload intent)', () => {
  it('400 already-resolved (single-use) → honest copy + reload', () => {
    expect(resolveErrorToast(400)).toEqual({ message: 'Esta aprovação já foi resolvida.', reload: true })
  })
  it('403 non-manager → permission copy, no reload', () => {
    expect(resolveErrorToast(403)).toEqual({
      message: 'Sem permissão — apenas gerentes podem resolver aprovações.',
      reload: false,
    })
  })
  it('404 plane-off → disabled-plane copy + reload', () => {
    expect(resolveErrorToast(404)).toEqual({
      message: 'Plano de agentes desativado (IBX_AGENTS_ENABLED).',
      reload: true,
    })
  })
  it('an unknown status still fails honestly (never reads as success)', () => {
    const toast = resolveErrorToast(500)
    expect(toast.message).toBe('Falha ao resolver a aprovação. Tente novamente.')
    expect(toast.reload).toBe(false)
  })
})
