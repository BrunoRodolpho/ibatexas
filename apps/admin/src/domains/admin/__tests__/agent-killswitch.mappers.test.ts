// Unit tests for the PURE agent-killswitch helpers (BKL-099). No React, no network
// — pure logic. Covers the endpoint/path builders, the pt-BR display-name map, the
// killed→badge + action labels, the toggle plan (kill is confirm-gated, restore is
// not), and the OUTCOME-aware / status-keyed toast copy — including the honest-copy
// invariants (a kill response that came back still-live NEVER reads as executed; an
// error never reads as success). Mirrors the agent-approvals.mappers.test style.

import { describe, it, expect } from 'vitest'
import {
  AGENT_KILLSWITCH_ENDPOINT,
  AGENT_KILL_STATUS_PATH,
  killPath,
  unkillPath,
  agentDisplayName,
  statusBadge,
  actionLabel,
  planKillToggle,
  killOutcomeToast,
  killErrorToast,
  KILL_CONFIRM,
  type AgentKillStatus,
} from '../agent-killswitch.mappers'

const agent = (over: Partial<AgentKillStatus>): AgentKillStatus => ({
  agentId: 'pix-payment-failure-remediation',
  killed: false,
  ...over,
})

describe('endpoint / path builders', () => {
  it('targets the manager-gated kill-status roster read', () => {
    expect(AGENT_KILLSWITCH_ENDPOINT).toBe('/api/admin/agents')
    expect(AGENT_KILL_STATUS_PATH).toBe('/api/admin/agents/kill-status')
  })
  it('builds the trip / clear verb paths (id encoded)', () => {
    expect(killPath('pix-payment-failure-remediation')).toBe(
      '/api/admin/agents/pix-payment-failure-remediation/kill',
    )
    expect(unkillPath('pix-payment-failure-remediation')).toBe(
      '/api/admin/agents/pix-payment-failure-remediation/unkill',
    )
    expect(killPath('a/b')).toBe('/api/admin/agents/a%2Fb/kill')
    expect(unkillPath('a/b')).toBe('/api/admin/agents/a%2Fb/unkill')
  })
})

describe('agentDisplayName', () => {
  it('maps the known registry agent to pt-BR', () => {
    expect(agentDisplayName('pix-payment-failure-remediation')).toBe(
      'Remediação de falhas de pagamento PIX',
    )
  })
  it('falls back to the raw id when unmapped (never blank)', () => {
    expect(agentDisplayName('some-new-agent')).toBe('some-new-agent')
    expect(agentDisplayName('')).toBe('')
  })
})

describe('statusBadge', () => {
  it('a killed agent is the abnormal red danger state', () => {
    expect(statusBadge(true)).toEqual({ label: 'Parado (kill-switch)', variant: 'danger' })
  })
  it('a live agent is a green success', () => {
    expect(statusBadge(false)).toEqual({ label: 'Ativo', variant: 'success' })
  })
})

describe('actionLabel', () => {
  it('offers the OPPOSITE of the current state', () => {
    expect(actionLabel(false)).toBe('Parar')
    expect(actionLabel(true)).toBe('Restaurar')
  })
})

describe('planKillToggle', () => {
  it('a live agent plans a confirm-gated kill (POST …/kill)', () => {
    expect(planKillToggle(agent({ killed: false }))).toEqual({
      path: '/api/admin/agents/pix-payment-failure-remediation/kill',
      method: 'POST',
      intent: 'kill',
      requiresConfirm: true,
    })
  })
  it('a killed agent plans a direct restore (POST …/unkill, no confirm)', () => {
    expect(planKillToggle(agent({ killed: true }))).toEqual({
      path: '/api/admin/agents/pix-payment-failure-remediation/unkill',
      method: 'POST',
      intent: 'restore',
      requiresConfirm: false,
    })
  })
})

describe('KILL_CONFIRM', () => {
  it('is pt-BR and reassures that customer conversations are unaffected', () => {
    expect(KILL_CONFIRM.title).toBe('Parar agente?')
    expect(KILL_CONFIRM.confirmLabel).toBe('Parar agente')
    expect(KILL_CONFIRM.body).toContain('kill-switch')
    expect(KILL_CONFIRM.body).toContain('cliente')
  })
})

describe('killOutcomeToast (outcome-aware, anti-confabulation)', () => {
  it('a kill that came back killed:true reports parado', () => {
    expect(killOutcomeToast('kill', true)).toEqual({
      type: 'success',
      message: 'Kill-switch acionado. O agente foi parado.',
    })
  })
  it('a restore that came back killed:false reports restaurado', () => {
    expect(killOutcomeToast('restore', false)).toEqual({
      type: 'success',
      message: 'Kill-switch liberado. O agente voltou a operar.',
    })
  })
  it('a kill whose response disagrees (still live) NEVER reads as parado', () => {
    const toast = killOutcomeToast('kill', false)
    expect(toast.type).toBe('info')
    expect(toast.message).not.toContain('foi parado')
    expect(toast.message).toContain('ainda consta como ativo')
  })
  it('a restore whose response disagrees (still killed) NEVER reads as restaurado', () => {
    const toast = killOutcomeToast('restore', true)
    expect(toast.type).toBe('info')
    expect(toast.message).not.toContain('voltou a operar')
    expect(toast.message).toContain('ainda consta como parado')
  })
})

describe('killErrorToast (status → pt-BR copy + reload intent)', () => {
  it('403 non-manager → permission copy, no reload', () => {
    expect(killErrorToast(403)).toEqual({
      message: 'Sem permissão — apenas gerentes podem parar ou restaurar agentes.',
      reload: false,
    })
  })
  it('404 unknown agent → resync copy + reload', () => {
    expect(killErrorToast(404)).toEqual({
      message: 'Agente desconhecido. Atualizando a lista.',
      reload: true,
    })
  })
  it('503 plane-off → disabled-plane copy + reload', () => {
    expect(killErrorToast(503)).toEqual({
      message: 'Plano de agentes desativado (IBX_AGENTS_ENABLED).',
      reload: true,
    })
  })
  it('an unknown status still fails honestly (never reads as success)', () => {
    const toast = killErrorToast(500)
    expect(toast.message).toBe('Falha ao alterar o kill-switch do agente. Tente novamente.')
    expect(toast.reload).toBe(false)
  })
})
