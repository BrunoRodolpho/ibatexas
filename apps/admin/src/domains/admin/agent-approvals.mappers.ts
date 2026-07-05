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

// ── Client mirror of the server resolved-outcome contract (BKL-104) ───────────
//
// A resolve(accept:true) re-adjudicates the IDENTICAL parked envelope through the
// kernel, so an HTTP 200 can carry a NON-EXECUTE decision (the state moved). The
// server now returns a STRUCTURED outcome that explains WHY it wasn't executed;
// this mirrors it so the UI reports the precise, honest reason instead of the old
// generic "o estado mudou". Mirrors AgentApprovalOutcome in
// apps/api/src/claustrum/agent-approvals.ts (do NOT invent statuses).

export type AgentApprovalOutcomeStatus =
  | 'executed'
  | 'rejected'
  | 'refused'
  | 'reparked'
  | 'escalated'
  | 'denied_by_kernel'

/** The structured resolved outcome from POST …/:token/resolve (200 body). */
export interface AgentApprovalOutcome {
  readonly status: AgentApprovalOutcomeStatus
  /** Raw kernel Decision.kind (absent only for `rejected`). */
  readonly decisionKind?: string
  /** Machine-readable kernel reason (refusal.code / decision basis code). */
  readonly reasonCode?: string
  /** Operator-facing pt-BR reason for a non-executed outcome. */
  readonly refusalPtBr?: string
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

/** Single-approval detail path (backs the BKL-105 deep-link route). Encode defensively. */
export function detailPath(token: string): string {
  return `${AGENT_APPROVALS_ENDPOINT}/${encodeURIComponent(token)}`
}

// ── 404 disambiguation for the detail fetch (BKL-105) ─────────────────────────
//
// The detail endpoint (GET …/:token) returns 404 for BOTH a disabled managed-agent
// plane AND an unknown/expired token, distinguishable only by the body `message`:
// the plane-off body carries the `IBX_AGENTS_ENABLED` marker (server constant
// PLANE_OFF), the not-found body carries "approval not found". This pure predicate
// centralizes that read so the deep-link route can render the honest state (plane-
// off banner vs. "aprovação não encontrada") instead of collapsing both to one.

const PLANE_OFF_MARKER = 'IBX_AGENTS_ENABLED'

/** True when a 404 detail body denotes the plane being disabled (not a bad token). */
export function isPlaneOffMessage(message: string | undefined): boolean {
  return typeof message === 'string' && message.includes(PLANE_OFF_MARKER)
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

// ── Resolve OUTCOME toast — STRUCTURED (BKL-104) ──────────────────────────────
//
// The value-add over `resolveResultToast`: when the server returns a structured
// `outcome`, the toast reports the PRECISE reason a parked action was not
// executed (refused with the kernel refusal text; needs re-confirmation; needs
// escalation) instead of the generic "o estado mudou". The anti-confabulation
// invariant is preserved MECHANICALLY: ONLY `status: "executed"` yields the
// positive-execution copy; every other status contains "não foi executada" and
// never "aprovada e executada".

const NOT_EXECUTED_PREFIX = 'Aprovação registrada, mas a ação não foi executada'

/** Honest "not executed" line, appending the kernel reason when present. */
function notExecutedMessage(reason?: string): string {
  const r = reason?.trim()
  return r && r.length > 0
    ? `${NOT_EXECUTED_PREFIX}: ${r}`
    : `${NOT_EXECUTED_PREFIX} (o estado mudou). Verifique o pedido.`
}

function outcomeToast(outcome: AgentApprovalOutcome): ResolveToast {
  switch (outcome.status) {
    case 'executed':
      return { type: 'success', message: 'Ação do agente aprovada e executada.' }
    case 'rejected':
      return { type: 'success', message: 'Solicitação do agente rejeitada.' }
    case 'refused':
    case 'denied_by_kernel':
      return { type: 'info', message: notExecutedMessage(outcome.refusalPtBr) }
    case 'reparked':
      return {
        type: 'info',
        message: `${NOT_EXECUTED_PREFIX} — requer nova confirmação (o estado mudou). Verifique o pedido.`,
      }
    case 'escalated':
      return {
        type: 'info',
        message: `${NOT_EXECUTED_PREFIX} — requer escalação para um responsável.`,
      }
  }
}

/**
 * pt-BR toast for a settled (HTTP 200) resolve. PREFERS the structured `outcome`
 * (BKL-104 server, precise reason); falls back to the decision-kind inference
 * (`resolveResultToast`) when a pre-BKL-104 server omits it. Honest in every
 * branch — a non-executed outcome never reads as executed.
 */
export function resolveOutcomeToast(
  accept: boolean,
  outcome?: AgentApprovalOutcome,
  decisionKind?: string,
): ResolveToast {
  if (outcome) return outcomeToast(outcome)
  return resolveResultToast(accept, decisionKind)
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
  // BKL-105 — deep-link detail route copy.
  detailSubtitle: 'Ação de agente pausada aguardando aprovação de um gerente.',
  notFound: 'Aprovação não encontrada (expirada ou já resolvida).',
  backToList: 'Voltar para aprovações',
} as const
