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

// ── Wire contracts (match apps/api/src/routes/qa-rca.ts) ────────────────────

export interface RcaConversation {
  sessionId: string // kernel UUID (conversations.session_id)
  chatCuid: string | null // conversations.id
  channel: string // web | whatsapp | ops (admin:* synthetic) | unknown
  startedAt: string | null // min(recorded_at) — first activity
  lastAt: string | null // max(recorded_at) — last activity
  lastText: string | null // last archived message (server-redacted)
  lastRole: string | null
  turnCount: number
}

export interface RcaTurnSummary {
  turnId: string
  startedAt: string | null
  endedAt: string | null
  callCount: number
  /** Most governance-significant decision of the turn (REFUSE > ESCALATE >
   *  REQUEST_CONFIRMATION > DEFER > REWRITE > EXECUTE); archiver appends excluded. */
  decision: string | null
  adjCount: number
  userText: string | null // nearest archived user message (server-redacted)
  hadSend: boolean
  responderEmpty: boolean
}

export interface InvestigationContext {
  turnId: string // == correlationId in logs
  conversationId: string | null // kernel UUID (turn_trace.conversation_id)
  noncePrefix: string | null // intent_audit system-envelope key: nonce LIKE '<uuid>:%'
  chatCuid: string | null
  phoneHash: string | null
  sessionHashed: string | null // intent_audit.session_id (hashed — the API recomputes it to join)
  channel: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
}

export interface LlmCall {
  callIndex: number
  persona: string | null // prompt_manifest[0] — `<catalogId>@<hash>`; classify by prefix, NOT index
  model: string | null
  temperature: number | null
  intentHash: string | null
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
  completion: string | null
  recordedAt: string | null
}

export interface AdjSupersedes {
  reason: string | null // e.g. confirmation_resolved — the confirm→resume chain
  predecessorIntentHash: string | null
  predecessorAt: string | null
}

export interface AdjDecision {
  recordedAt: string | null
  kind: string | null
  decisionKind: string | null
  refusalKind: string | null
  refusalCode: string | null
  taint: string | null
  principal: string | null
  decisionBasis: string[]
  durationMs: number | null
  nonce: string | null
  intentHash: string | null
  /** Which bridge arm matched: 'turn' (exact intent_hash — this turn's own
   *  envelope, possibly a later resume), 'system' (conversation-prefixed nonce,
   *  archiver/incident), 'session' (session-hash + in-span). */
  scope: string | null
  supersedes: AdjSupersedes | null
}

export interface VlLine {
  time: string | null
  level: string | null
  component: string | null
  msg: string | null
  /** Structured signal fields (claims posture, reply.sent delivery verdict,
   *  conductor turn summary) — null when the line carries none. */
  fields: Record<string, string> | null
}

export interface RcaTurnDetail {
  context: InvestigationContext
  llm: LlmCall[]
  adj: AdjDecision[]
  vl: VlLine[]
  /** Fail-safe lanes flag their outages — an empty degraded lane means "the
   *  store was unreachable", NOT "nothing happened" (absence-is-signal only
   *  holds when the lane actually answered). */
  degraded: { adj: boolean; vl: boolean }
}

// ── Fetchers ────────────────────────────────────────────────────────────────

export const rcaConfigured = (): QaConfig | null => bridgeConfig()

export interface ConversationFilter {
  q?: string
  from?: string | null // ISO — bounds turn activity (recorded_at)
  to?: string | null
  channels?: ReadonlyArray<string> // empty/omitted = all
  limit?: number
}

export const fetchConversations = (cfg: QaConfig, f: ConversationFilter): Promise<RcaConversation[]> => {
  const p = new URLSearchParams()
  p.set("limit", String(f.limit ?? 40))
  if (f.q) p.set("q", f.q)
  if (f.from) p.set("from", f.from)
  if (f.to) p.set("to", f.to)
  if (f.channels !== undefined && f.channels.length > 0) p.set("channel", f.channels.join(","))
  return authedGetJson<{ conversations: RcaConversation[] }>(
    cfg,
    `/internal/qa/rca/conversations?${p.toString()}`,
  ).then((r) => r.conversations)
}

export const fetchTurns = (
  cfg: QaConfig,
  sessionId: string,
  range?: { from?: string | null; to?: string | null },
): Promise<RcaTurnSummary[]> => {
  const p = new URLSearchParams()
  if (range?.from) p.set("from", range.from)
  if (range?.to) p.set("to", range.to)
  const qs = p.toString()
  return authedGetJson<{ turns: RcaTurnSummary[] }>(
    cfg,
    `/internal/qa/rca/conversations/${encodeURIComponent(sessionId)}/turns${qs ? `?${qs}` : ""}`,
  ).then((r) => r.turns)
}

/** `window` overrides the server's turn-anchored VL range (e.g. "1h", "7d");
 *  omit for the default: an absolute ±5m window around the turn's own span. */
export const fetchTurn = (cfg: QaConfig, turnId: string, window?: string | null): Promise<RcaTurnDetail> =>
  authedGetJson<{ turn: RcaTurnDetail }>(
    cfg,
    `/internal/qa/rca/turns/${encodeURIComponent(turnId)}${window ? `?window=${encodeURIComponent(window)}` : ""}`,
  ).then((r) => r.turn)

/** One find-by-text hit from the audit ledger (ibx-find-msg.sh as a route).
 *  Carries BOTH roles — a hit may be an assistant/store message. */
export interface RcaFindHit {
  recordedAt: string | null
  role: string | null
  decisionKind: string | null
  text: string | null // matched content (server-redacted, 160ch)
  sessionId: string | null // conversation id candidate from the nonce prefix
  chatCuid: string | null
  turnId: string | null // resolved turn — null when no trace matched
}

export const findMessages = (
  cfg: QaConfig,
  text: string,
  range?: { from?: string | null; to?: string | null },
): Promise<RcaFindHit[]> => {
  const p = new URLSearchParams({ text })
  if (range?.from) p.set("from", range.from)
  if (range?.to) p.set("to", range.to)
  return authedGetJson<{ hits: RcaFindHit[] }>(cfg, `/internal/qa/rca/find?${p.toString()}`).then(
    (r) => r.hits,
  )
}

export interface RcaMessage {
  role: string | null
  sentAt: string | null
  text: string | null // server-redacted
}

export interface RcaTranscript {
  messages: RcaMessage[]
  /** true = the domain schema was unreachable (empty is NOT "no messages"). */
  degraded: boolean
}

export const fetchTranscript = (cfg: QaConfig, sessionId: string): Promise<RcaTranscript> =>
  authedGetJson<RcaTranscript>(
    cfg,
    `/internal/qa/rca/conversations/${encodeURIComponent(sessionId)}/messages`,
  )

export interface StoreProbe {
  ok: boolean
  latencyMs: number
  error: string | null
}

/** Preflight: one reachability probe per store the workbench joins across,
 *  plus the env facts that silently reshape the lanes (redact secret → ADJ
 *  bridge arm 2; claims flag → 3-call vs 2-call turn shape). */
export interface RcaStatus {
  turnTrace: StoreProbe
  intentAudit: StoreProbe
  domain: StoreProbe
  victoriaLogs: StoreProbe
  flags: { redactSecretSet: boolean; claimsPipeline: boolean }
}

export const fetchStatus = (cfg: QaConfig): Promise<RcaStatus> =>
  authedGetJson<{ status: RcaStatus }>(cfg, "/internal/qa/rca/status").then((r) => r.status)

// ── Derived: LLM call classification (persona-based, NOT positional) ────────
// With ENABLE_CLAIMS_PIPELINE on (the dev default) a turn runs THREE calls:
// 0=planner, 1=claim-planner, 2=responder — so callIndex is not a role.

export type LlmPhase = "planner" | "claim-planner" | "responder" | null

export function personaPhase(persona: string | null): LlmPhase {
  if (persona === null) return null
  // The ops plane runs the same loop under ops/* personas (ops/planner.persona,
  // ops/responder.grounded, …) — normalize so ops turns classify too instead
  // of rendering every stage as "no call".
  const p = persona.startsWith("ops/") ? `ibatexas/${persona.slice(4)}` : persona
  if (p.startsWith("ibatexas/claim-planner")) return "claim-planner"
  if (p.startsWith("ibatexas/planner")) return "planner"
  if (p.startsWith("ibatexas/responder")) return "responder"
  return null
}

/** The persona manifest entry is content-addressed (`<catalogId>@<hash>`,
 *  llm-trace.ts manifestWithHashes) — the id before the `@` IS the prompt
 *  catalog id the Prompts editor navigates by. Null when the entry doesn't
 *  look like a catalog id (defensive: never build a dead prompts link). */
export function promptIdForPersona(persona: string | null): string | null {
  if (persona === null) return null
  const id = persona.split("@")[0] ?? ""
  return id.includes("/") ? id : null
}

const callEmpty = (c: LlmCall): boolean => (c.outputTokens ?? 0) === 0 || (c.completion ?? "").trim() === ""

const planner = (d: RcaTurnDetail): LlmCall | undefined => d.llm.find((c) => personaPhase(c.persona) === "planner")
const claimPlanner = (d: RcaTurnDetail): LlmCall | undefined =>
  d.llm.find((c) => personaPhase(c.persona) === "claim-planner")
/** Last responder call wins — an empty-completion retry re-runs the responder. */
const responder = (d: RcaTurnDetail): LlmCall | undefined =>
  [...d.llm].reverse().find((c) => personaPhase(c.persona) === "responder")

// ── Derived: delivery verdict (reply.sent — SIGNAL-8) ───────────────────────

interface DeliveryVerdict {
  /** null = no reply.sent event seen */
  disposition: string | null
  delivered: boolean
}

function deliveryVerdict(vl: VlLine[]): DeliveryVerdict | null {
  const ev = vl.find((l) => l.fields?.event === "reply.sent")
  if (ev === undefined) return null
  return {
    disposition: ev.fields?.disposition ?? null,
    delivered: ev.fields?.deliveredText === "true" || ev.fields?.textSent === "true" || ev.fields?.pixDelivered === "true",
  }
}

/** Legacy fallback — the raw send line (it carries no correlation ids, so it
 *  only appears if the emitter gains them; kept as a cheap extra signal). */
function hasLegacySend(vl: VlLine[]): boolean {
  return vl.some((l) => (l.msg ?? "").includes("[whatsapp.send]"))
}

// ── Derived: merged timeline ────────────────────────────────────────────────

export type TimelineSource = "ADJ" | "LLM" | "VL" | "GAP"

export interface TimelineEvent {
  tMs: number
  ts: string
  source: TimelineSource
  text: string
  /** Expandable payload: full completion / basis chain / raw structured fields. */
  detail?: string
  empty?: boolean
  gap?: boolean
  /** LLM rows only: the prompt-catalog id of the call's persona — the
   *  cross-tab jump target for the Prompts editor. */
  promptId?: string
}

function ms(iso: string | null): number {
  if (iso === null) return Number.NaN
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : Number.NaN
}

/** Merge the three sources into one timestamp-ordered lane view, and synthesize
 *  a GAP marker when a whatsapp turn ran but produced no delivery evidence —
 *  suppressed while the VL lane is degraded (an unreachable log store must not
 *  mint false ghosts: absence is only a signal when the lane answered). */
export function mergeTimeline(d: RcaTurnDetail): TimelineEvent[] {
  const out: TimelineEvent[] = []
  // Tolerate a not-yet-restarted API serving the previous wire shape.
  const degraded = d.degraded ?? { adj: false, vl: false }

  for (const c of d.llm) {
    const empty = callEmpty(c)
    const phase = personaPhase(c.persona) ?? `call ${c.callIndex}`
    const head = empty ? "<EMPTY>" : (c.completion ?? "").slice(0, 120)
    const promptId = promptIdForPersona(c.persona)
    out.push({
      tMs: ms(c.recordedAt),
      ts: c.recordedAt ?? "",
      source: "LLM",
      text: `call ${c.callIndex} ${phase} · ${c.persona ?? "?"} · in=${c.inputTokens ?? 0} out=${c.outputTokens ?? 0} · ${c.durationMs ?? "?"}ms :: ${head}`,
      ...(c.completion !== null && c.completion.length > 0
        ? { detail: c.completion }
        : {}),
      ...(empty ? { empty: true } : {}),
      ...(promptId !== null ? { promptId } : {}),
    })
  }

  for (const a of d.adj) {
    const basis = a.decisionBasis ?? []
    const resume = a.supersedes != null ? ` ↩ resumes ${a.supersedes.reason ?? "?"}` : ""
    const scope = a.scope != null && a.scope !== "system" ? ` · ${a.scope}` : ""
    out.push({
      tMs: ms(a.recordedAt),
      ts: a.recordedAt ?? "",
      source: "ADJ",
      text: `${a.kind ?? "?"} → ${a.decisionKind ?? "?"}${a.refusalCode ? ` (${a.refusalCode})` : ""}${a.taint ? ` · taint ${a.taint}` : ""}${a.durationMs != null ? ` · ${a.durationMs}ms` : ""}${scope}${resume}`,
      detail: [
        a.principal != null ? `principal: ${a.principal}` : null,
        basis.length > 0 ? `basis: ${basis.join(", ")}` : null,
        a.refusalKind != null ? `refusal: ${a.refusalKind} (${a.refusalCode ?? "?"})` : null,
        a.nonce != null ? `nonce: ${a.nonce}` : null,
        a.intentHash != null ? `intentHash: ${a.intentHash}` : null,
        a.supersedes != null
          ? `supersedes: ${a.supersedes.reason ?? "?"} of ${a.supersedes.predecessorIntentHash ?? "?"} @ ${a.supersedes.predecessorAt ?? "?"}`
          : null,
      ]
        .filter((x): x is string => x !== null)
        .join("\n"),
    })
  }

  for (const l of d.vl) {
    const f = l.fields
    const tag = f?.event !== undefined ? `${f.event} ` : ""
    out.push({
      tMs: ms(l.time),
      ts: l.time ?? "",
      source: "VL",
      text: `${l.level ? `L${l.level} ` : ""}${l.component ? `[${l.component}] ` : ""}${tag}${l.msg ?? ""}`,
      ...(f !== null && f !== undefined
        ? {
            detail: Object.entries(f)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n"),
          }
        : {}),
    })
  }

  // GAP: whatsapp turn with activity but zero delivery evidence — only
  // assertable when the VL lane actually answered.
  const verdict = deliveryVerdict(d.vl)
  if (
    d.context.channel === "whatsapp" &&
    !degraded.vl &&
    verdict === null &&
    !hasLegacySend(d.vl) &&
    (d.llm.length > 0 || d.adj.length > 0)
  ) {
    const at = d.context.endedAt ?? d.context.startedAt
    out.push({
      tMs: ms(at) || Number.MAX_SAFE_INTEGER,
      ts: at ?? "",
      source: "GAP",
      text: "expected outbound reply.sent here — ABSENT (pre-send failure or ghost). Absence is the signal.",
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

const ARCHIVER_KIND = "conversation.message.append"

/** Tri-state, never a bare ✓/✗ — because half the stages fail silently (no row,
 *  no log). Derived from presence/absence, honoring absence-is-signal — and
 *  honoring lane degradation: a degraded lane reads "silent", never "ok"/"off". */
export function derivePipeline(d: RcaTurnDetail): PipelineStage[] {
  const p = planner(d)
  const cp = claimPlanner(d)
  const r = responder(d)
  const rEmpty = r !== undefined && callEmpty(r)
  const isWhatsapp = d.context.channel === "whatsapp"
  // Tolerate a not-yet-restarted API serving the previous wire shape.
  const degraded = d.degraded ?? { adj: false, vl: false }

  const inbound =
    d.vl.some((l) => l.fields?.event === "turn") ||
    d.vl.some((l) => (l.msg ?? "").includes("incoming")) ||
    d.llm.length > 0

  // Kernel: real envelopes only (archiver appends are bookkeeping, not the
  // turn's mutations). ADJ degradation → silent, not "no rows".
  const mutations = d.adj.filter((a) => a.kind !== ARCHIVER_KIND)
  const decided = mutations.filter((a) => a.decisionKind !== null)
  const kernelPick =
    ["REFUSE", "ESCALATE", "REQUEST_CONFIRMATION", "DEFER", "REWRITE", "EXECUTE"].find((k) =>
      decided.some((a) => a.decisionKind === k),
    ) ?? decided[0]?.decisionKind
  const kernel: PipelineStage = degraded.adj
    ? { key: "kernel", label: "Kernel", state: "silent", sub: "ADJ degraded" }
    : mutations.length === 0
      ? { key: "kernel", label: "Kernel", state: "silent", sub: "no envelopes" }
      : {
          key: "kernel",
          label: "Kernel",
          state: decided.some((a) => a.decisionKind === "REFUSE") ? "warn" : "ok",
          sub: `${kernelPick ?? "?"}${decided.length > 1 ? ` ×${decided.length}` : ""}`,
        }

  // Claims: engaged when a claim-planner call ran or claims telemetry landed.
  const claimsVl = d.vl.filter(
    (l) => l.component === "claims" || l.component === "claim-planner" || (l.fields?.event ?? "").startsWith("claim"),
  )
  const terminal = claimsVl.find((l) => l.fields?.event === "claims.terminal")
  const claims: PipelineStage = (() => {
    if (cp === undefined && claimsVl.length === 0) {
      return { key: "claims", label: "Claims", state: "off" as StageState, sub: "not engaged" }
    }
    if (terminal !== undefined) {
      const posture = terminal.fields?.kernelTerminal ?? terminal.fields?.posture ?? "?"
      const degradedFromRender = terminal.fields?.degradedFromRender === "true"
      return {
        key: "claims",
        label: "Claims",
        state: (degradedFromRender || posture === "UNKNOWN" || posture === "ESCALATE" || posture === "CLARIFY"
          ? "warn"
          : "ok") as StageState,
        sub: `${posture}${degradedFromRender ? " (degraded)" : ""}`,
      }
    }
    if (degraded.vl) {
      return { key: "claims", label: "Claims", state: "silent" as StageState, sub: "engaged · VL degraded" }
    }
    return { key: "claims", label: "Claims", state: "ok" as StageState, sub: "engaged" }
  })()

  // Send: the reply.sent delivery verdict beats any substring heuristic.
  const verdict = deliveryVerdict(d.vl)
  const send: PipelineStage = (() => {
    const label = isWhatsapp ? "WhatsApp" : "Send"
    if (verdict !== null) {
      if (verdict.disposition === "suppressed_paused") {
        return { key: "send", label, state: "ok" as StageState, sub: "paused · designed silence" }
      }
      if (verdict.delivered) return { key: "send", label, state: "ok" as StageState, sub: "delivered" }
      return { key: "send", label, state: "fail" as StageState, sub: `not delivered (${verdict.disposition ?? "?"})` }
    }
    if (hasLegacySend(d.vl)) return { key: "send", label, state: "ok" as StageState, sub: "sent" }
    if (degraded.vl) return { key: "send", label, state: "silent" as StageState, sub: "VL degraded" }
    if (isWhatsapp) return { key: "send", label, state: "silent" as StageState, sub: "no send event" }
    // Web: the conductor turn line's redacted response is the reply evidence.
    const turnLine = d.vl.find((l) => l.fields?.event === "turn")
    if (turnLine?.fields?.response !== undefined && turnLine.fields.response.length > 0) {
      return { key: "send", label, state: "ok" as StageState, sub: "replied" }
    }
    return { key: "send", label, state: rEmpty ? ("silent" as StageState) : ("off" as StageState), sub: "no send event" }
  })()

  // Archive: the archiver's own EXECUTE rows are now in the ADJ lane — a far
  // stronger signal than grepping log text (kept as fallback).
  const archived =
    d.adj.some((a) => a.kind === ARCHIVER_KIND && a.decisionKind === "EXECUTE") ||
    d.vl.some((l) => (l.msg ?? "").includes("archiver") || (l.msg ?? "").includes("archived"))

  return [
    { key: "inbound", label: "Inbound", state: inbound ? "ok" : "silent", sub: inbound ? "received" : "no signal" },
    {
      key: "planner",
      label: "Planner",
      state: p === undefined ? "off" : callEmpty(p) ? "warn" : "ok",
      sub: p === undefined ? "no call" : `call ${p.callIndex}`,
    },
    claims,
    kernel,
    {
      key: "responder",
      label: "Responder",
      state: r === undefined ? "off" : rEmpty ? "warn" : "ok",
      sub: r === undefined ? "no call" : rEmpty ? "empty" : `${r.outputTokens ?? 0} tok`,
    },
    send,
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
  // Match both id bindings — conductor lines carry correlationId, claims /
  // outbound / responder telemetry carries turnId.
  const vmui = `${vlBase}/select/vmui/#/?query=${encodeURIComponent(
    `correlationId:${ctx.turnId} OR turnId:${ctx.turnId}`,
  )}&g0.range_input=1h`
  const adjConsole = ctx.conversationId
    ? `${adjBase}/turn-trace/${encodeURIComponent(ctx.conversationId)}`
    : null
  return { victoriaLogs: vmui, adjConsole }
}
