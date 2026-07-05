// agent-killswitch.mappers.ts — PURE view types + pt-BR label/plan helpers for the
// BKL-099 "Agentes" admin control: the operator surface for the per-agent kill
// switch (the emergency brake for a managed agent). Backs the reuse of the
// BKL-098 manager-gated routes — GET /api/admin/agents/kill-status (the roster +
// each agent's killed flag) + POST …/:agentId/kill|unkill.
//
// Framework-free (no React, no '@/' imports) so the logic is trivially unit-
// testable in the repo's node vitest env — the only dep it pulls is the PURE
// `@ibatexas/ui/utils` BadgeVariant type. The `AgentKillStatus` shape below
// mirrors the server projection (apps/api/src/routes/admin/agents-kill-switch.ts)
// — an operator read, not domain state, so not imported from @ibatexas/agents
// (a server package the browser bundle cannot pull). The agent display name is
// mapped client-side (like intentKindLabel), raw-id fallback. pt-BR (Hard Rule
// #4) throughout.

import type { BadgeVariant } from '@ibatexas/ui/utils'

export type { BadgeVariant }

// ── Client mirror of the server kill-status projection ────────────────────────

/** One managed agent + whether its kill switch is tripped, as it crosses JSON. */
export interface AgentKillStatus {
  readonly agentId: string
  readonly killed: boolean
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

export const AGENT_KILLSWITCH_ENDPOINT = '/api/admin/agents'

/** The roster + kill-status read (no agentId → the whole roster). */
export const AGENT_KILL_STATUS_PATH = `${AGENT_KILLSWITCH_ENDPOINT}/kill-status`

/** Trip path for an agent (id is a registry key; encode defensively). */
export function killPath(agentId: string): string {
  return `${AGENT_KILLSWITCH_ENDPOINT}/${encodeURIComponent(agentId)}/kill`
}

/** Clear path for an agent (id is a registry key; encode defensively). */
export function unkillPath(agentId: string): string {
  return `${AGENT_KILLSWITCH_ENDPOINT}/${encodeURIComponent(agentId)}/unkill`
}

// ── agentId → pt-BR display name ─────────────────────────────────────────────
//
// A best-effort, NON-exhaustive register mirroring the AGENT_REGISTRY displayName
// (the server package @ibatexas/agents cannot be imported into the browser
// bundle). Any id absent here falls back to the RAW id string — an honest, if
// unpolished, display rather than a mislabel.

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'pix-payment-failure-remediation': 'Remediação de falhas de pagamento PIX',
}

/** pt-BR display name for the agent; RAW id string when unmapped (never blank). */
export function agentDisplayName(agentId: string): string {
  return AGENT_DISPLAY_NAMES[agentId] ?? agentId
}

// ── killed → Badge ────────────────────────────────────────────────────────────

export interface StatusBadge {
  readonly label: string
  readonly variant: BadgeVariant
}

/**
 * pt-BR status badge. A killed agent (kill switch tripped) is the notable,
 * abnormal state → red `danger`; a live agent → green `success`.
 */
export function statusBadge(killed: boolean): StatusBadge {
  return killed
    ? { label: 'Parado (kill-switch)', variant: 'danger' }
    : { label: 'Ativo', variant: 'success' }
}

/** pt-BR label for the toggle button (the ACTION, i.e. the opposite of state). */
export function actionLabel(killed: boolean): string {
  return killed ? 'Restaurar' : 'Parar'
}

// ── Toggle plan (pure) ────────────────────────────────────────────────────────

/** Which way a toggle click moves the agent. */
export type KillIntent = 'kill' | 'restore'

export interface KillTogglePlan {
  readonly path: string
  readonly method: 'POST'
  readonly intent: KillIntent
  /**
   * Whether the click must pass a confirm step first. Tripping the brake (kill)
   * stops the agent immediately and IS confirm-worthy; restoring is the make-
   * things-normal reversal and fires directly (mirrors clientes opt-in gating,
   * where only the re-enable is confirm-gated).
   */
  readonly requiresConfirm: boolean
}

/** Pure request plan for a one-tap toggle of the given agent. */
export function planKillToggle(agent: AgentKillStatus): KillTogglePlan {
  if (agent.killed) {
    return { path: unkillPath(agent.agentId), method: 'POST', intent: 'restore', requiresConfirm: false }
  }
  return { path: killPath(agent.agentId), method: 'POST', intent: 'kill', requiresConfirm: true }
}

// ── Kill confirm copy (pt-BR) ─────────────────────────────────────────────────
//
// The confirm step for tripping the brake. Mirrors the clientes OPT_IN_CONFIRM
// idiom: a single pt-BR const, rendered inside a Modal footer.

export const KILL_CONFIRM = {
  title: 'Parar agente?',
  body: 'Acionar o kill-switch para de imediato todos os gatilhos deste agente. Nenhuma conversa de cliente é afetada. Você pode restaurá-lo a qualquer momento.',
  confirmLabel: 'Parar agente',
  cancelLabel: 'Cancelar',
} as const

// ── Toggle OUTCOME toast (outcome-aware, anti-confabulation) ──────────────────
//
// A 200 from kill/unkill returns the AUTHORITATIVE written state as `killed`
// (the route echoes the switch it wrote to Redis). The toast reports what the
// RESPONSE says, never a blanket "done" keyed on the intent — so a response that
// disagrees with the intent (e.g. a kill POST that came back still-live) is
// reported honestly, never as fake success (the repo's whole thesis: no
// confident-wrong claim).

export interface KillToast {
  readonly type: 'success' | 'info'
  readonly message: string
}

/**
 * pt-BR toast for a settled (HTTP 200) toggle, honest about the WRITTEN state.
 *   - intent kill    + killed:true  → success: parado
 *   - intent restore + killed:false → success: restaurado
 *   - any mismatch (killed disagrees with intent) → info: honest "not yet" copy
 */
export function killOutcomeToast(intent: KillIntent, responseKilled: boolean): KillToast {
  if (intent === 'kill') {
    return responseKilled
      ? { type: 'success', message: 'Kill-switch acionado. O agente foi parado.' }
      : {
          type: 'info',
          message: 'Comando enviado, mas o agente ainda consta como ativo. Atualize em instantes.',
        }
  }
  return !responseKilled
    ? { type: 'success', message: 'Kill-switch liberado. O agente voltou a operar.' }
    : {
        type: 'info',
        message: 'Comando enviado, mas o agente ainda consta como parado. Atualize em instantes.',
      }
}

// ── Toggle ERROR toast (status → pt-BR copy + reload intent) ──────────────────

export interface KillErrorToast {
  readonly message: string
  /** Whether the caller should reload the roster (the state likely changed). */
  readonly reload: boolean
}

/**
 * pt-BR error copy for a non-OK toggle, keyed by HTTP status. Exhaustive over the
 * server refusals + a generic fallback; NONE of these ever reads as success.
 *   - 403 → caller is not a manager (requireManagerRole); no reload (row unchanged)
 *   - 404 → unknown agent (never trips a phantom); reload to resync the roster
 *   - 503 → managed-agent plane disabled (reload flips the page to its off-state)
 */
export function killErrorToast(status: number): KillErrorToast {
  switch (status) {
    case 403:
      return {
        message: 'Sem permissão — apenas gerentes podem parar ou restaurar agentes.',
        reload: false,
      }
    case 404:
      return { message: 'Agente desconhecido. Atualizando a lista.', reload: true }
    case 503:
      return { message: 'Plano de agentes desativado (IBX_AGENTS_ENABLED).', reload: true }
    default:
      return { message: 'Falha ao alterar o kill-switch do agente. Tente novamente.', reload: false }
  }
}

// ── Shared page copy (pt-BR) ─────────────────────────────────────────────────

export const AGENT_KILLSWITCH_COPY = {
  title: 'Agentes',
  subtitle: 'Freio de emergência dos agentes gerenciados — parar ou restaurar em um clique.',
  loadFailed: 'Falha ao carregar os agentes.',
  networkError: 'Falha de conexão ao alterar o kill-switch. Tente novamente.',
  empty: 'Nenhum agente gerenciado registrado.',
  planeOff: 'Plano de agentes desativado (IBX_AGENTS_ENABLED).',
  forbidden: 'Sem permissão — apenas gerentes podem gerenciar agentes.',
  agentId: 'ID',
} as const
