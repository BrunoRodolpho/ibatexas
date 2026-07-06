// RCA client — reads the live turn forensics exposed by apps/api's dev-only
// /internal/qa/rca/* routes (turn_trace + intent_audit + VictoriaLogs), and
// derives the investigation model the workbench renders: the tri-state
// pipeline, the merged [ADJ]/[LLM]/[VL] timeline (with GAP synthesis for
// absence-is-signal cases like a dropped empty reply), and the deep-links.
//
// The backend is a thin reader; the "methodology as code" (pipeline states,
// GAP detection, ID-bridge → launch URLs) lives here so it is unit-testable
// and mirrors the ibx-rca skill's calibration discipline.

import { authedGetJson, bridgeConfig, type QaConfig } from "./bridge"

// ── Wire contracts (match apps/api/src/routes/qa-obs.ts) ────────────────────

export interface RcaConversation {
  sessionId: string // kernel UUID (conversations.session_id)
  chatCuid: string | null // conversations.id
  channel: string
  startedAt: string | null
  lastText: string | null
  turnCount: number
}

export interface RcaTurnSummary {
  turnId: string
  startedAt: string | null
  callCount: number
  decision: string | null
  userText: string | null
  hadSend: boolean
  responderEmpty: boolean
}

export interface InvestigationContext {
  turnId: string // == correlationId in logs
  conversationId: string | null // kernel UUID (turn_trace.conversation_id)
  noncePrefix: string | null // intent_audit join key: nonce LIKE '<uuid>:%'
  chatCuid: string | null
  phoneHash: string | null
  sessionHashed: string | null // intent_audit.session_id (hashed — does NOT join)
  channel: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
}

export interface LlmCall {
  callIndex: number // 0 = planner, 1 = responder
  persona: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
  completion: string | null
  recordedAt: string | null
}

export interface AdjDecision {
  recordedAt: string | null
  kind: string | null
  decisionKind: string | null
  refusalCode: string | null
  taint: string | null
}

export interface VlLine {
  time: string | null
  level: string | null
  component: string | null
  msg: string | null
}

export interface RcaTurnDetail {
  context: InvestigationContext
  llm: LlmCall[]
  adj: AdjDecision[]
  vl: VlLine[]
}

// ── Fetchers ────────────────────────────────────────────────────────────────

export const rcaConfigured = (): QaConfig | null => bridgeConfig()

export const fetchConversations = (cfg: QaConfig, q: string, limit = 40): Promise<RcaConversation[]> =>
  authedGetJson<{ conversations: RcaConversation[] }>(
    cfg,
    `/internal/qa/rca/conversations?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
  ).then((r) => r.conversations)

export const fetchTurns = (cfg: QaConfig, sessionId: string): Promise<RcaTurnSummary[]> =>
  authedGetJson<{ turns: RcaTurnSummary[] }>(
    cfg,
    `/internal/qa/rca/conversations/${encodeURIComponent(sessionId)}/turns`,
  ).then((r) => r.turns)

export const fetchTurn = (cfg: QaConfig, turnId: string): Promise<RcaTurnDetail> =>
  authedGetJson<{ turn: RcaTurnDetail }>(cfg, `/internal/qa/rca/turns/${encodeURIComponent(turnId)}`).then(
    (r) => r.turn,
  )

// ── Derived: merged timeline ────────────────────────────────────────────────

export type TimelineSource = "ADJ" | "LLM" | "VL" | "GAP"

export interface TimelineEvent {
  tMs: number
  ts: string
  source: TimelineSource
  text: string
  empty?: boolean
  gap?: boolean
}

function ms(iso: string | null): number {
  if (iso === null) return Number.NaN
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : Number.NaN
}

function hasSend(vl: VlLine[]): boolean {
  return vl.some((l) => (l.msg ?? "").includes("[whatsapp.send]"))
}

/** Merge the three sources into one timestamp-ordered lane view, and synthesize
 *  a GAP marker when a whatsapp turn ran but never emitted [whatsapp.send]
 *  (the empty-reply "ghost" — absence is the only signal). */
export function mergeTimeline(d: RcaTurnDetail): TimelineEvent[] {
  const out: TimelineEvent[] = []

  for (const c of d.llm) {
    const empty = (c.outputTokens ?? 0) === 0 || (c.completion ?? "") === ""
    const phase = c.callIndex === 0 ? "planner" : c.callIndex === 1 ? "responder" : `call ${c.callIndex}`
    const head = empty ? "<EMPTY>" : (c.completion ?? "").slice(0, 120)
    out.push({
      tMs: ms(c.recordedAt),
      ts: c.recordedAt ?? "",
      source: "LLM",
      text: `call ${c.callIndex} ${phase} · ${c.persona ?? "?"} · in=${c.inputTokens ?? 0} out=${c.outputTokens ?? 0} · ${c.durationMs ?? "?"}ms :: ${head}`,
      ...(empty ? { empty: true } : {}),
    })
  }

  for (const a of d.adj) {
    out.push({
      tMs: ms(a.recordedAt),
      ts: a.recordedAt ?? "",
      source: "ADJ",
      text: `${a.kind ?? "?"} → ${a.decisionKind ?? "?"}${a.refusalCode ? ` (${a.refusalCode})` : ""}${a.taint ? ` · taint ${a.taint}` : ""}`,
    })
  }

  for (const l of d.vl) {
    out.push({
      tMs: ms(l.time),
      ts: l.time ?? "",
      source: "VL",
      text: `${l.level ? `L${l.level} ` : ""}${l.component ? `[${l.component}] ` : ""}${l.msg ?? ""}`,
    })
  }

  // GAP: whatsapp turn that produced no send event.
  if (d.context.channel === "whatsapp" && !hasSend(d.vl) && (d.llm.length > 0 || d.adj.length > 0)) {
    const at = d.context.endedAt ?? d.context.startedAt
    out.push({
      tMs: ms(at) || Number.MAX_SAFE_INTEGER,
      ts: at ?? "",
      source: "GAP",
      text: "expected [whatsapp.send] here — ABSENT (empty-reply fail-open, no log line). Absence is the signal.",
      gap: true,
    })
  }

  return out.sort((x, y) => {
    if (Number.isNaN(x.tMs) && Number.isNaN(y.tMs)) return 0
    if (Number.isNaN(x.tMs)) return 1
    if (Number.isNaN(y.tMs)) return -1
    return x.tMs - y.tMs
  })
}

// ── Derived: tri-state pipeline ─────────────────────────────────────────────

export type StageState = "ok" | "warn" | "fail" | "silent" | "off"

export interface PipelineStage {
  key: string
  label: string
  state: StageState
  sub: string
}

const planner = (d: RcaTurnDetail): LlmCall | undefined => d.llm.find((c) => c.callIndex === 0)
const responder = (d: RcaTurnDetail): LlmCall | undefined => d.llm.find((c) => c.callIndex === 1)

/** Tri-state, never a bare ✓/✗ — because half the stages fail silently (no row,
 *  no log). Derived from presence/absence, honoring absence-is-signal. */
export function derivePipeline(d: RcaTurnDetail): PipelineStage[] {
  const p = planner(d)
  const r = responder(d)
  const rEmpty = r !== undefined && ((r.outputTokens ?? 0) === 0 || (r.completion ?? "") === "")
  const send = hasSend(d.vl)
  const inbound = d.adj.some((a) => (a.kind ?? "").includes("inbound")) || d.vl.some((l) => (l.msg ?? "").includes("incoming"))
  const decided = d.adj.find((a) => a.decisionKind !== null)
  const archived = d.vl.some((l) => (l.msg ?? "").includes("archiver") || (l.msg ?? "").includes("archived"))
  const isWhatsapp = d.context.channel === "whatsapp"

  return [
    { key: "inbound", label: "Inbound", state: inbound ? "ok" : "silent", sub: inbound ? "received" : "no signal" },
    {
      key: "planner",
      label: "Planner",
      state: p === undefined ? "off" : (p.outputTokens ?? 0) === 0 ? "warn" : "ok",
      sub: p === undefined ? "no call" : "call 0",
    },
    { key: "claims", label: "Claims", state: "off", sub: "not wired" },
    {
      key: "kernel",
      label: "Kernel",
      state: d.adj.length === 0 ? "silent" : decided ? "ok" : "warn",
      sub: decided?.decisionKind ?? (d.adj.length === 0 ? "no rows" : "nothing to adj."),
    },
    {
      key: "responder",
      label: "Responder",
      state: r === undefined ? "off" : rEmpty ? "warn" : "ok",
      sub: r === undefined ? "no call" : rEmpty ? "empty" : `${r.outputTokens ?? 0} tok`,
    },
    {
      key: "send",
      label: isWhatsapp ? "WhatsApp" : "Send",
      state: send ? "ok" : rEmpty ? "silent" : isWhatsapp ? "silent" : "off",
      sub: send ? "sent" : "no send event",
    },
    { key: "archive", label: "Archive", state: archived ? "ok" : "off", sub: archived ? "persisted" : "skipped" },
  ]
}

// ── Derived: deep-links (env-configured bases) ──────────────────────────────

function envBase(key: string, fallback: string): string {
  const v = (import.meta.env as Record<string, string | undefined>)[key]
  const base = typeof v === "string" && v.length > 0 ? v : fallback
  return base.endsWith("/") ? base.slice(0, -1) : base
}

export interface DeepLinks {
  victoriaLogs: string
  adjConsole: string | null
}

export function buildLinks(ctx: InvestigationContext): DeepLinks {
  const vlBase = envBase("VITE_VICTORIALOGS_URL", "http://localhost:9428")
  const adjBase = envBase("VITE_ADJ_CONSOLE_URL", "http://localhost:5180")
  const vmui = `${vlBase}/select/vmui/#/?query=${encodeURIComponent(`correlationId:${ctx.turnId}`)}&g0.range_input=1h`
  const adjConsole = ctx.conversationId
    ? `${adjBase}/turn-trace/${encodeURIComponent(ctx.conversationId)}`
    : null
  return { victoriaLogs: vmui, adjConsole }
}
