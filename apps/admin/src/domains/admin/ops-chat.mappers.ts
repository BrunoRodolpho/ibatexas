// ops-chat.mappers.ts — PURE view types + pt-BR helpers for the Canal
// Operacional page (BKL-087): the manager/owner ↔ ops-actor chat surface over
// POST /api/admin/ops/chat (NEW-032 slice B — the human face of the AI-manager
// channel). Framework-free (no React, no '@/' imports) so the label / variant /
// thread-entry / error logic is trivially unit-testable in the repo's node
// vitest env — mirrors the ops-snapshot / ops-alerts mappers.
//
// The response shape is a CLIENT-SIDE mirror of the route reply
// (apps/api/src/routes/admin/ops-chat.ts): { reply, decision, executed,
// proposedKinds }. `decision` is the kernel DecisionKind for the turn; the API
// widens it to string at the JSON boundary, so every consumer goes through the
// fallback-safe lookups below (a label / variant is EXHAUSTIVE over the closed
// kind union — a new member is a COMPILE error until mapped, Hard Rule #4 — with
// a defensive fallback for an unrecognized value, never blank, never a crash).
//
// Posture (WS6 — corrected): the thread PERSISTS server-side (BKL-084) and
// rehydrates on reload, and a REQUEST_CONFIRMATION parks conversationally — the
// user resolves it by replying "sim" (matchToParked on the ops channel), which
// the page now offers as an in-chat Confirmar/Cancelar action. This module still
// shapes a SINGLE turn's view; a failed turn renders an honest error bubble with
// the server's own pt-BR text — success is never fabricated.

// ── Kernel decision kinds (client mirror of @adjudicate DecisionKind) ─────────

/**
 * The six kernel decision kinds this channel can surface, verbatim to the
 * server's `KERNEL_VERBS` set (packages/journeys/.../db-verify.ts). Closed union
 * — kept in lock-step with the kernel; a new verb fails the exhaustive records.
 */
export type OpsDecisionKind =
  | 'EXECUTE'
  | 'REFUSE'
  | 'REQUEST_CONFIRMATION'
  | 'ESCALATE'
  | 'DEFER'
  | 'REWRITE'

/** Badge tiers this surface uses (subset of the @ibatexas/ui Badge variants). */
export type OpsBadgeVariant = 'success' | 'danger' | 'warning' | 'info' | 'default'

/**
 * pt-BR decision labels (nouns — the kernel's verdict). EXHAUSTIVE over the
 * closed kind union. Distinct from the "executado" chip word so the two signals
 * (verdict vs. whether a mutation actually committed) never read as one.
 */
export const OPS_DECISION_LABELS: Record<OpsDecisionKind, string> = {
  EXECUTE: 'Execução',
  REFUSE: 'Recusa',
  REQUEST_CONFIRMATION: 'Confirmação necessária',
  ESCALATE: 'Escalação',
  DEFER: 'Adiamento',
  REWRITE: 'Reescrita',
}

/**
 * Decision → Badge tier. EXECUTE=success (green), REFUSE=danger (red),
 * REQUEST_CONFIRMATION=warning (amber), ESCALATE/DEFER=default (neutral),
 * REWRITE=info (blue — the kernel adjusted the command). EXHAUSTIVE.
 */
export const OPS_DECISION_VARIANTS: Record<OpsDecisionKind, OpsBadgeVariant> = {
  EXECUTE: 'success',
  REFUSE: 'danger',
  REQUEST_CONFIRMATION: 'warning',
  ESCALATE: 'default',
  DEFER: 'default',
  REWRITE: 'info',
}

/** pt-BR label for a decision kind. Unknown value → the raw kind (never blank). */
export function decisionLabel(kind: string): string {
  return OPS_DECISION_LABELS[kind as OpsDecisionKind] ?? kind
}

/** Badge tier for a decision kind. Unknown value → 'default' (neutral). */
export function decisionBadgeVariant(kind: string): OpsBadgeVariant {
  return OPS_DECISION_VARIANTS[kind as OpsDecisionKind] ?? 'default'
}

// ── Client mirror of the POST /api/admin/ops/chat reply ──────────────────────

/** The ops-chat turn reply as it crosses the JSON boundary. */
export interface OpsChatResponse {
  readonly reply: string
  readonly decision: string
  readonly executed: boolean
  readonly proposedKinds: readonly string[]
}

// ── Thread entries (client-only transcript — v1 is stateless server-side) ────

export interface UserEntry {
  readonly id: string
  readonly role: 'user'
  readonly text: string
}

export interface AssistantEntry {
  readonly id: string
  readonly role: 'assistant'
  readonly reply: string
  readonly decision: string
  readonly executed: boolean
  readonly proposedKinds: readonly string[]
}

export interface ErrorEntry {
  readonly id: string
  readonly role: 'error'
  readonly text: string
}

/**
 * A REHYDRATED assistant turn (BKL-091). The persisted thread stores only
 * { role, content } per message — the kernel decision / executed / proposedKinds
 * metadata was NOT retained — so a reloaded assistant turn is a distinct,
 * badge-LESS variant. Kept separate from `AssistantEntry` on purpose: the live
 * turn's exhaustive badge rendering stays intact and a hydrated turn never fakes
 * a blank/neutral badge for metadata it doesn't have.
 */
export interface HistoryAssistantEntry {
  readonly id: string
  readonly role: 'history-assistant'
  readonly reply: string
  /**
   * This rehydrated turn is a still-OPEN money park (a REQUEST_CONFIRMATION
   * awaiting confirm/cancel) — the persisted thread keeps no decision metadata,
   * so the flag is reconstructed on the CLIENT from a per-session marker and set
   * ONLY on the newest history-assistant entry (a park is always the last turn).
   * When true the bubble shows a pt-BR "ação pendente de confirmação" indicator
   * and re-exposes the Confirmar/Cancelar affordance so the operator can resume
   * the park (posting "sim"/"não" resumes it server-side via matchToParked).
   */
  readonly pendingConfirmation?: boolean
}

/**
 * A one-shot "histórico carregado" separator (BKL-091) placed after the last
 * rehydrated turn, so the manager can tell the reloaded thread from the live
 * session below it. Carries no content — it is a pure render marker.
 */
export interface HistoryDividerEntry {
  readonly id: string
  readonly role: 'history-divider'
}

export type OpsThreadEntry =
  | UserEntry
  | AssistantEntry
  | ErrorEntry
  | HistoryAssistantEntry
  | HistoryDividerEntry

/** The staff message the manager typed. */
export function userEntry(id: string, text: string): UserEntry {
  return { id, role: 'user', text }
}

/** The assistant turn (well-typed response → entry). */
export function assistantEntry(id: string, res: OpsChatResponse): AssistantEntry {
  return {
    id,
    role: 'assistant',
    reply: res.reply,
    decision: res.decision,
    executed: res.executed,
    proposedKinds: res.proposedKinds,
  }
}

/** An honest error turn (never fabricated success). */
export function errorEntry(id: string, text: string): ErrorEntry {
  return { id, role: 'error', text }
}

/** A rehydrated (badge-less) assistant turn from the persisted thread. */
export function historyAssistantEntry(id: string, reply: string): HistoryAssistantEntry {
  return { id, role: 'history-assistant', reply }
}

/** The "histórico carregado" separator between hydrated history and the live session. */
export function historyDividerEntry(id: string): HistoryDividerEntry {
  return { id, role: 'history-divider' }
}

// ── Persisted-thread hydrate (GET /api/admin/ops/chat/history → entries) ──────

/** One stored message as it crosses the JSON boundary (client mirror). */
export interface OpsHistoryMessage {
  readonly role: string
  readonly content: string
}

/**
 * Defensively pull the message list out of an unknown history-response body. A
 * missing / non-array `messages`, or an entry with a non-string role/content, is
 * dropped rather than crashing the hydrate — best-effort, mirroring
 * `coerceResponse`. `count` is ignored (the array length is authoritative).
 */
export function coerceHistoryMessages(body: unknown): OpsHistoryMessage[] {
  const rec = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const raw = Array.isArray(rec.messages) ? rec.messages : []
  const out: OpsHistoryMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m.role === 'string' && typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/**
 * Map an unknown history-response body into thread entries for the initial
 * hydrate (BKL-091). `user` → UserEntry, `assistant` → a badge-LESS
 * HistoryAssistantEntry (the persisted thread kept no decision metadata); any
 * other role (e.g. `system`) is dropped. A single "histórico carregado" divider
 * is appended iff at least one message survived, so the manager can tell the
 * reloaded thread from the live session that follows. Ids are namespaced
 * `ops-hist-*` so they never collide with the live `ops-chat-*` keys.
 */
export function historyEntries(body: unknown): OpsThreadEntry[] {
  const messages = coerceHistoryMessages(body)
  const entries: OpsThreadEntry[] = []
  let seq = 0
  for (const msg of messages) {
    if (msg.role === 'user') {
      entries.push(userEntry(`ops-hist-${seq}`, msg.content))
      seq += 1
    } else if (msg.role === 'assistant') {
      entries.push(historyAssistantEntry(`ops-hist-${seq}`, msg.content))
      seq += 1
    }
    // Any other role (system/unknown) is dropped — it never belongs in the thread.
  }
  if (entries.length > 0) {
    entries.push(historyDividerEntry('ops-hist-divider'))
  }
  return entries
}

/**
 * Decorate the NEWEST rehydrated assistant turn as a still-open money park so a
 * reloaded thread makes a pending confirmation VISIBLE and RESUMABLE again (the
 * live Confirmar/Cancelar affordance is lost on reload because the persisted
 * thread carries no decision metadata). Pure + non-mutating: returns a new list
 * only when it changes anything. A no-op when `pending` is false or there is no
 * history-assistant entry. Only the LAST such entry can be open — a park is
 * always the newest turn — so exactly one entry is ever marked.
 */
export function markPendingConfirmation(
  entries: readonly OpsThreadEntry[],
  pending: boolean,
): OpsThreadEntry[] {
  const list = entries as OpsThreadEntry[]
  if (!pending) return list
  let lastIdx = -1
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === 'history-assistant') {
      lastIdx = i
      break
    }
  }
  if (lastIdx === -1) return list
  return entries.map((e, i) =>
    i === lastIdx ? { ...(e as HistoryAssistantEntry), pendingConfirmation: true } : e,
  )
}

// ── Fetch-result → thread entry (pure so the hook's branch is tested) ────────

/**
 * Defensively shape an unknown 200 body into the response contract — a missing /
 * mistyped field degrades to a safe default rather than crashing the render.
 */
export function coerceResponse(body: unknown): OpsChatResponse {
  const rec = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  return {
    reply: typeof rec.reply === 'string' ? rec.reply : '',
    decision: typeof rec.decision === 'string' ? rec.decision : '',
    executed: rec.executed === true,
    proposedKinds: Array.isArray(rec.proposedKinds)
      ? rec.proposedKinds.filter((k): k is string => typeof k === 'string')
      : [],
  }
}

/** A settled ops-chat fetch (body read on BOTH paths so errors surface honestly). */
export interface OpsChatResult {
  readonly ok: boolean
  readonly status: number
  readonly body: unknown
}

/**
 * Turn a settled fetch result into an assistant / error thread entry. A non-ok
 * response NEVER renders as success — it becomes an honest error bubble carrying
 * the server's pt-BR text.
 */
export function entryFromResult(id: string, result: OpsChatResult): AssistantEntry | ErrorEntry {
  return result.ok
    ? assistantEntry(id, coerceResponse(result.body))
    : errorEntry(id, errorMessageFromBody(result.body, result.status))
}

// ── Error → pt-BR message ────────────────────────────────────────────────────

/** Generic English HTTP reason tokens that must NOT surface as user copy. */
const GENERIC_HTTP_REASONS: ReadonlySet<string> = new Set([
  'Forbidden',
  'Unauthorized',
  'Bad Request',
  'Not Found',
  'Internal Server Error',
  'Bad Gateway',
  'Service Unavailable',
])

/** Status-keyed pt-BR fallbacks — verbatim to the route's own error copy. */
export const OPS_CHAT_STATUS_FALLBACKS: Record<number, string> = {
  403: 'Acesso restrito a funcionários.',
  502: 'Não consegui processar seu comando agora. Tente novamente.',
  503: 'Canal operacional indisponível no momento.',
}

/** Last-resort pt-BR copy when the body carried no usable text and status is unmapped. */
export const OPS_CHAT_GENERIC_ERROR = 'Não foi possível processar o comando. Tente novamente.'

/** Transport/network failure copy (fetch rejected before a response arrived). */
export const OPS_CHAT_NETWORK_ERROR =
  'Falha de conexão ao enviar o comando. Verifique sua rede e tente novamente.'

/**
 * First usable pt-BR string in the error body — the route sends it in `error`;
 * the requireStaff guard sends it in `message` (with a generic English `error`).
 * Skips the bare English HTTP reason tokens so "Forbidden" never leaks to copy.
 */
function serverErrorText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const rec = body as Record<string, unknown>
  for (const key of ['error', 'message'] as const) {
    const v = rec[key]
    if (typeof v === 'string') {
      const t = v.trim()
      if (t.length > 0 && !GENERIC_HTTP_REASONS.has(t)) return t
    }
  }
  return null
}

/**
 * Honest pt-BR error text for a failed turn: prefer the server's own pt-BR
 * message, else a status-keyed fallback, else a generic message. Never
 * fabricates success and never surfaces a raw English HTTP reason.
 */
export function errorMessageFromBody(body: unknown, status: number): string {
  return serverErrorText(body) ?? OPS_CHAT_STATUS_FALLBACKS[status] ?? OPS_CHAT_GENERIC_ERROR
}

// ── Composer gate ────────────────────────────────────────────────────────────

/** Max message length the route accepts (mirrors the Zod `max(2000)` bound). */
export const MAX_OPS_CHAT_MESSAGE = 2000

/** A turn is sendable iff not in flight, non-empty (trimmed), and within bound. */
export function canSend(text: string, inFlight: boolean): boolean {
  const trimmed = text.trim()
  return !inFlight && trimmed.length > 0 && trimmed.length <= MAX_OPS_CHAT_MESSAGE
}
