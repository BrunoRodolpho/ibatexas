// agent-approvals.mappers.ts — PURE view types + pt-BR label/plan helpers for the
// AUT-024 "Aprovações" admin inbox: the one-tap surface for parked managed-agent
// actions (GET /api/admin/agent-approvals[?status=] + POST …/:token/resolve).
//
// Framework-free (no React, no '@/' imports) so the logic is trivially unit-
// testable in the repo's node vitest env — the only dep it pulls is the PURE
// `@ibatexas/ui/utils` BadgeVariant type. The `AgentApprovalRequest` shape below
// mirrors the server projection (apps/api/src/claustrum/agent-approvals.ts) — a
// TTL'd operator projection, not domain state, so not exported from
// @ibatexas/domain (which the browser bundle cannot import anyway). It carries NO
// amount/payload fields — this surface renders the server-authored pt-BR `prompt`
// and never invents a money display. pt-BR throughout (Hard Rule #4).

import type { BadgeVariant } from '@ibatexas/ui/utils'

export type { BadgeVariant }

// ── Client mirror of the server AgentApprovalRequest projection ───────────────

export type AgentApprovalStatus = 'pending' | 'approved' | 'rejected'

/** The resolving staff identity carried on a resolved projection (DR-6). */
export interface AgentApprovalResolvedBy {
  readonly id: string
  readonly displayName?: string
}

/** One parked managed-agent approval as it crosses the JSON boundary. */
export interface AgentApprovalRequest {
  readonly token: string
  readonly agentNamespace: string
  readonly intentKind: string
  readonly intentHash: string
  readonly prompt: string
  readonly status: AgentApprovalStatus
  readonly requestedAt: string
  readonly resolvedAt?: string
  readonly resolvedBy?: AgentApprovalResolvedBy
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

export const AGENT_APPROVALS_ENDPOINT = '/api/admin/agent-approvals'

/** List path for one status bucket, or the whole set when omitted. */
export function listPath(status?: AgentApprovalStatus): string {
  return status ? `${AGENT_APPROVALS_ENDPOINT}?status=${status}` : AGENT_APPROVALS_ENDPOINT
}

/** Single-use resolve path for a token (token is a UUID; encode defensively). */
export function resolvePath(token: string): string {
  return `${AGENT_APPROVALS_ENDPOINT}/${encodeURIComponent(token)}/resolve`
}

// ── intentKind → pt-BR label ─────────────────────────────────────────────────
//
// A best-effort, NON-exhaustive register: the kinds a managed agent can park into
// the CONFIRM band today (refunds, PIX, 86/price, notes, kitchen/cancel). Any
// kind absent here falls back to the RAW kind string — an honest, if unpolished,
// display rather than a mislabel (Hard Rule #4 keeps the mapped ones pt-BR).

const INTENT_KIND_LABELS: Record<string, string> = {
  'payment.pix.regenerate': 'Regenerar cobrança PIX',
  'pix.charge.refund': 'Reembolso PIX',
  'payment.refund.issue': 'Emitir reembolso',
  'payment.refund.confirm': 'Confirmar reembolso',
  'product.availability.set': 'Disponibilidade de item (86 / liberar)',
  'product.price.set': 'Alterar preço de item',
  'order.note.add': 'Adicionar observação ao pedido',
  'order.status.transition': 'Avançar status do pedido',
  'order.cancel': 'Cancelar pedido',
}

/** pt-BR label for the parked intent kind; RAW kind string when unmapped. */
export function intentKindLabel(kind: string): string {
  return INTENT_KIND_LABELS[kind] ?? kind
}

// ── status → Badge ────────────────────────────────────────────────────────────

export interface StatusBadge {
  readonly label: string
  readonly variant: BadgeVariant
}

/**
 * pt-BR status badge. Pending is the actionable, notable state → amber `warning`;
 * approved → green `success`; rejected → red `danger`. Exhaustive over the union
 * (a new status member becomes a compile error until it is labeled here).
 */
export function statusBadge(status: AgentApprovalStatus): StatusBadge {
  switch (status) {
    case 'pending':
      return { label: 'Pendente', variant: 'warning' }
    case 'approved':
      return { label: 'Aprovada', variant: 'success' }
    case 'rejected':
      return { label: 'Rejeitada', variant: 'danger' }
  }
}

// ── Missing-value + identity display ─────────────────────────────────────────

const EMPTY = '—'

/** Resolver identity for the history rows: displayName, else id, else em-dash. */
export function resolvedByLabel(resolvedBy: AgentApprovalResolvedBy | undefined): string {
  if (!resolvedBy) return EMPTY
  const name = resolvedBy.displayName?.trim()
  if (name && name.length > 0) return name
  const id = resolvedBy.id?.trim()
  return id && id.length > 0 ? id : EMPTY
}

// ── Dates (ISO → pt-BR datetime) ─────────────────────────────────────────────

/** Human pt-BR datetime for the inbox; em-dash for a null / malformed value. */
export function formatApprovalDate(iso: string | null | undefined): string {
  if (!iso) return EMPTY
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return EMPTY
  return d.toLocaleString('pt-BR')
}

// ── History ordering (pure) ──────────────────────────────────────────────────

/**
 * Resolved-history order: most-recently-resolved first (falls back to
 * requestedAt when a row is missing resolvedAt). Pure + total; does NOT mutate
 * its input.
 */
export function sortByResolvedAtDesc(
  rows: readonly AgentApprovalRequest[],
): AgentApprovalRequest[] {
  const key = (r: AgentApprovalRequest): number => {
    const t = new Date(r.resolvedAt ?? r.requestedAt).getTime()
    return Number.isNaN(t) ? 0 : t
  }
  return [...rows].sort((a, b) => key(b) - key(a))
}

// ── Resolve plan (pure) ──────────────────────────────────────────────────────

export interface ResolvePlan {
  readonly path: string
  /** The resolve body — note the key is `accept`, NOT `accepted`. */
  readonly body: { readonly accept: boolean }
}

/** Pure request plan for a one-tap resolve (approve or reject). */
export function planResolve(token: string, accept: boolean): ResolvePlan {
  return { path: resolvePath(token), body: { accept } }
}

// ── Resolve OUTCOME toast (decision-aware, anti-confabulation) ────────────────
//
// A 200 from resolve(accept:true) is NOT proof of execution: the kernel re-
// adjudicates the IDENTICAL parked envelope through every guard, so a stale/moved
// entity state legitimately comes back REFUSE (or re-park) with HTTP 200. The
// toast must therefore report what the DECISION says, never a blanket "executed"
// (the repo's whole thesis: no confident-wrong claim). Only EXECUTE/REWRITE earn
// the executed message; any other decision kind reports the honest "not executed".

const EXECUTED_DECISION_KINDS: ReadonlySet<string> = new Set(['EXECUTE', 'REWRITE'])

export interface ResolveToast {
  readonly type: 'success' | 'info'
  readonly message: string
}

/**
 * pt-BR toast for a settled (HTTP 200) resolve, honest about the kernel decision.
 *   - reject                          → "rejeitada"
 *   - approve + EXECUTE/REWRITE       → "aprovada e executada"
 *   - approve + any other / no kind   → info: approved but NOT executed (state moved)
 */
export function resolveResultToast(accept: boolean, decisionKind?: string): ResolveToast {
  if (!accept) {
    return { type: 'success', message: 'Solicitação do agente rejeitada.' }
  }
  if (decisionKind && EXECUTED_DECISION_KINDS.has(decisionKind)) {
    return { type: 'success', message: 'Ação do agente aprovada e executada.' }
  }
  return {
    type: 'info',
    message: 'Aprovação registrada, mas a ação não foi executada (o estado mudou). Verifique o pedido.',
  }
}

// ── Resolve ERROR toast (status → pt-BR copy + reload intent) ─────────────────

export interface ResolveErrorToast {
  readonly message: string
  /** Whether the caller should reload the lists (the projection likely changed). */
  readonly reload: boolean
}

/**
 * pt-BR error copy for a non-OK resolve, keyed by HTTP status. Exhaustive over the
 * three server refusals + a generic fallback; NONE of these ever reads as success.
 *   - 400 → single-use token already resolved / unknown / expired (reload to sync)
 *   - 403 → caller is not a manager (requireManagerRole); no reload (row unchanged)
 *   - 404 → managed-agent plane disabled (reload flips the page to its off-state)
 */
export function resolveErrorToast(status: number): ResolveErrorToast {
  switch (status) {
    case 400:
      return { message: 'Esta aprovação já foi resolvida.', reload: true }
    case 403:
      return {
        message: 'Sem permissão — apenas gerentes podem resolver aprovações.',
        reload: false,
      }
    case 404:
      return { message: 'Plano de agentes desativado (IBX_AGENTS_ENABLED).', reload: true }
    default:
      return { message: 'Falha ao resolver a aprovação. Tente novamente.', reload: false }
  }
}

// ── Shared page copy (pt-BR) ─────────────────────────────────────────────────

export const AGENT_APPROVALS_COPY = {
  title: 'Aprovações',
  subtitle: 'Ações de agente pausadas aguardando aprovação de um gerente.',
  loadFailed: 'Falha ao carregar as aprovações.',
  networkError: 'Falha de conexão ao resolver a aprovação. Tente novamente.',
  emptyPending: 'Nenhuma aprovação pendente. Tudo em ordem.',
  emptyHistory: 'Nenhuma aprovação resolvida ainda.',
  planeOff: 'Plano de agentes desativado (IBX_AGENTS_ENABLED).',
  historyToggle: 'Histórico de resoluções',
  approve: 'Aprovar',
  reject: 'Rejeitar',
  requestedAt: 'Solicitada em',
  resolvedAt: 'Resolvida em',
  resolvedBy: 'Resolvida por',
  agent: 'Agente',
} as const
