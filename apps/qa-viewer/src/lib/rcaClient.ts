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
  // LE2-014 — the @ibatexas/catalog version this turn ran under
  // (max(turn_trace.catalog_version); the value is identical on every row of
  // the turn). Together with the prompt manifest this is the replay key: a
  // historical turn is re-runnable against exactly the catalog it saw.
  //
  // OPTIONAL on the wire, and nullable, for two independent reasons: turns
  // traced before the column existed have no value, and older API builds do
  // not send the field at all. Displayed as "—" in both cases — never
  // defaulted to a version number, which would misattribute the turn.
  catalogVersion?: number | null
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

/** Wire Truth — one durable wire ATTEMPT (llm_wire row): the relay's exact
 *  outbound request + the raw provider response. Retry attempts share a
 *  `callIndex` (the LlmCall they render into) across ascending `seq`. */
export interface WireExchange {
  seq: number
  callIndex: number | null
  model: string | null
  request: unknown
  response: unknown
  requestHash: string | null
  requestTruncated: boolean
  responseTruncated: boolean
  recordedAt: string | null
}

/** LE2-030 — Twilio delivery confirmation for ONE outbound reply part
 *  (`whatsapp_delivery`, keyed by the message SID captured at send time).
 *
 *  `status === null` means no delivery callback has arrived yet — the honest
 *  "pending" state, NOT an error. Every other value is Twilio's own
 *  `MessageStatus` verbatim (sent / delivered / read / failed / undelivered …). */
export interface DeliveryRecord {
  messageSid: string | null
  partIndex: number
  status: string | null
  sentAt: string | null
  statusAt: string | null
  errorCode: string | null
  errorMessage: string | null
  /** How many callbacks Twilio has posted for this SID (0 = pure silence). */
  callbackCount: number
  /** Call-site tag: "send" (text part) | "sendMedia". */
  source: string | null
}

export interface RcaTurnDetail {
  context: InvestigationContext
  llm: LlmCall[]
  adj: AdjDecision[]
  vl: VlLine[]
  /** Wire Truth lane — absent on pre-capture turns (degraded.wire then says
   *  whether the store was unreachable vs the turn predating capture). */
  wire: WireExchange[]
  /** LE2-030 delivery lane — one row per outbound reply part whose SID was
   *  captured at send. OPTIONAL on the wire: an older API build sends no field
   *  at all, and a turn that predates SID capture legitimately has no rows. */
  delivery?: DeliveryRecord[]
  /** Fail-safe lanes flag their outages — an empty degraded lane means "the
   *  store was unreachable", NOT "nothing happened" (absence-is-signal only
   *  holds when the lane actually answered). */
  degraded: { adj: boolean; vl: boolean; wire: boolean; delivery?: boolean }
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

// ── Derived: Twilio delivery confirmation (LE2-030) ─────────────────────────
//
// `reply.sent` proves only that our process handed the message to Twilio. The
// delivery lane carries what Twilio's own status callbacks reported, so it
// outranks the local verdict wherever it has rows.

export type DeliveryState = "delivered" | "failed" | "pending"

/** Twilio statuses that mean the message reached the handset. */
const DELIVERED_STATUSES = new Set(["delivered", "read"])
/** Twilio statuses that mean it did not, and never will. */
const FAILED_STATUSES = new Set(["failed", "undelivered", "canceled"])

/** Classify ONE part's latest status. `null` (no callback yet) and the
 *  in-flight statuses (queued/sending/sent) are both "pending" — Twilio has
 *  accepted the message but not yet confirmed the hop. Pending is never an
 *  error: it is the normal state of a reply sent seconds ago. */
export function deliveryState(status: string | null): DeliveryState {
  if (status === null) return "pending"
  if (DELIVERED_STATUSES.has(status)) return "delivered"
  if (FAILED_STATUSES.has(status)) return "failed"
  return "pending"
}

export interface DeliveryRollup {
  total: number
  delivered: number
  failed: number
  pending: number
  /** Worst state across the parts: one failed part fails the whole reply, and
   *  an unconfirmed part keeps it pending. Only all-delivered is delivered. */
  state: DeliveryState
}

/** Roll the per-part rows up to one verdict for the turn. `null` when the turn
 *  has no delivery rows at all (a pre-capture turn, a web turn, or a turn that
 *  genuinely sent nothing) — the caller then falls back to the VL verdict. */
export function rollupDelivery(rows: ReadonlyArray<DeliveryRecord>): DeliveryRollup | null {
  if (rows.length === 0) return null
  let delivered = 0
  let failed = 0
  let pending = 0
  for (const r of rows) {
    const s = deliveryState(r.status)
    if (s === "delivered") delivered++
    else if (s === "failed") failed++
    else pending++
  }
  const state: DeliveryState = failed > 0 ? "failed" : pending > 0 ? "pending" : "delivered"
  return { total: rows.length, delivered, failed, pending, state }
}

/** Attribute one VL line to a pipeline stage for the donut drill-down —
 *  mirrors exactly the signals derivePipeline reads per stage; undefined when
 *  the line belongs to no single donut (generic conductor chatter). */
function vlStage(l: VlLine): string | undefined {
  const ev = l.fields?.event ?? ""
  const msg = l.msg ?? ""
  if (ev === "reply.sent" || msg.includes("[whatsapp.send]")) return "send"
  if (l.component === "claims" || l.component === "claim-planner" || ev.startsWith("claim")) return "claims"
  if (ev === "turn" || msg.includes("incoming")) return "inbound"
  if (msg.includes("archiver") || msg.includes("archived")) return "archive"
  return undefined
}

// ── Derived: merged timeline ────────────────────────────────────────────────

export type TimelineSource = "ADJ" | "LLM" | "VL" | "GAP"

export interface TimelineEvent {
  tMs: number
  ts: string
  source: TimelineSource
  text: string
  /** Pipeline-stage attribution (derivePipeline keys: inbound / planner /
   *  claims / kernel / responder / send / archive) — the donut drill-down
   *  filters the timeline by this; absent when a row maps to no one stage. */
  stage?: string
  /** Expandable payload: full completion / basis chain / raw structured fields. */
  detail?: string
  empty?: boolean
  gap?: boolean
  /** LLM rows only: the prompt-catalog id of the call's persona — the
   *  cross-tab jump target for the Prompts editor. */
  promptId?: string
  /** Wire Truth — the durable wire attempts behind this LLM call (retries
   *  included), rendered as structured sections in the expander. */
  wire?: WireExchange[]
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
  const degraded = d.degraded ?? { adj: false, vl: false, wire: false }
  const wire = d.wire ?? []

  const matchedSeqs = new Set<number>()
  for (const c of d.llm) {
    const empty = callEmpty(c)
    const phase = personaPhase(c.persona)
    const phaseLabel = phase ?? `call ${c.callIndex}`
    // The claim-planner call renders under the "Claims" donut; planner and
    // responder map 1:1 to their stages.
    const stage = phase === "claim-planner" ? "claims" : phase
    const head = empty ? "<EMPTY>" : (c.completion ?? "").slice(0, 120)
    const promptId = promptIdForPersona(c.persona)
    // Wire Truth: the durable attempts behind THIS call (retries share its
    // callIndex). An LLM row with wire attached always expands.
    const attempts = wire.filter((x) => x.callIndex === c.callIndex)
    for (const x of attempts) matchedSeqs.add(x.seq)
    out.push({
      tMs: ms(c.recordedAt),
      ts: c.recordedAt ?? "",
      source: "LLM",
      text: `call ${c.callIndex} ${phaseLabel} · ${c.persona ?? "?"} · in=${c.inputTokens ?? 0} out=${c.outputTokens ?? 0} · ${c.durationMs ?? "?"}ms :: ${head}${attempts.length > 0 ? ` · wire×${attempts.length}` : ""}`,
      // Every LLM row expands (spec story 15): with wire attempts it shows
      // them; without, the expander states the absence explicitly.
      detail: c.completion ?? "",
      ...(stage !== null ? { stage } : {}),
      ...(empty ? { empty: true } : {}),
      ...(promptId !== null ? { promptId } : {}),
      ...(attempts.length > 0 ? { wire: attempts } : {}),
    })
  }

  // Wire attempts with no trace row to attach to (a call whose emit guard was
  // off, or a count mismatch) — surfaced, never silently dropped.
  for (const x of wire) {
    if (matchedSeqs.has(x.seq)) continue
    out.push({
      tMs: ms(x.recordedAt),
      ts: x.recordedAt ?? "",
      source: "LLM",
      text: `wire seq ${x.seq} (unmatched attempt) · ${x.model ?? "?"}`,
      detail: "",
      wire: [x],
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
      stage: a.kind === ARCHIVER_KIND ? "archive" : "kernel",
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
    const stage = vlStage(l)
    out.push({
      tMs: ms(l.time),
      ts: l.time ?? "",
      source: "VL",
      text: `${l.level ? `L${l.level} ` : ""}${l.component ? `[${l.component}] ` : ""}${tag}${l.msg ?? ""}`,
      ...(stage !== undefined ? { stage } : {}),
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
      stage: "send",
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

// ── Derived: wire-exchange sections (Wire Truth) ────────────────────────────

export interface WireSection {
  /** One-line sampling params: model / temp / max_tokens / response_format /
   *  reasoning_effort — whatever the wire body actually carried. */
  params: string
  /** Messages by role, persona (system) first — the component collapses it. */
  messages: Array<{ role: string; content: string }>
  /** Tool roster: name + pretty-printed schema per tool. */
  tools: Array<{ name: string; schema: string }>
  /** Raw provider response, pretty-printed. */
  response: string
  /** Non-OpenAI request bodies (a truncation marker, an unknown shape) land
   *  here pretty-printed — rendered in a scroll-capped block, never inline in
   *  the params line. */
  raw?: string
  truncated: { request: boolean; response: boolean }
}

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "null"
  } catch {
    return String(v)
  }
}

/** Build the structured expander sections for one wire exchange. Pure —
 *  tolerates any body shape (a truncation marker, a non-OpenAI body) by
 *  degrading to raw JSON in `params`/`response`. */
export function buildWireSections(x: WireExchange): WireSection {
  const req = (x.request ?? {}) as Record<string, unknown>
  const paramKeys = ["model", "temperature", "max_tokens", "response_format", "reasoning_effort", "stop"]
  const params = paramKeys
    .filter((k) => req[k] !== undefined)
    .map((k) => `${k}=${typeof req[k] === "object" ? JSON.stringify(req[k]) : String(req[k])}`)
    .join(" · ")
  const rawMessages = Array.isArray(req.messages) ? req.messages : []
  const messages = rawMessages
    .filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")
    .map((m) => ({
      role: typeof m.role === "string" ? m.role : "?",
      content: typeof m.content === "string" ? m.content : pretty(m.content),
    }))
  const rawTools = Array.isArray(req.tools) ? req.tools : []
  const tools = rawTools
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((t) => {
      const fn = (t.function ?? {}) as Record<string, unknown>
      return {
        name: typeof fn.name === "string" ? fn.name : "?",
        schema: pretty(fn.parameters ?? null),
      }
    })
  const standardShape = params.length > 0 || messages.length > 0
  return {
    params: standardShape ? params : "(non-standard request body)",
    messages,
    tools,
    response: pretty(x.response),
    ...(standardShape ? {} : { raw: pretty(x.request) }),
    truncated: { request: x.requestTruncated, response: x.responseTruncated },
  }
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

/** Most-governance-significant decision first (mirrors the API route's
 *  DECISION_SEVERITY): a REFUSE outranks the EXECUTEs around it. */
const DECISION_SEVERITY = ["REFUSE", "ESCALATE", "REQUEST_CONFIRMATION", "DEFER", "REWRITE", "EXECUTE"] as const

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
    DECISION_SEVERITY.find((k) => decided.some((a) => a.decisionKind === k)) ?? decided[0]?.decisionKind
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

  // Send: the reply.sent delivery verdict beats any substring heuristic — and
  // LE2-030's Twilio confirmation beats reply.sent, which only ever proved that
  // the Twilio API ACCEPTED the message.
  const verdict = deliveryVerdict(d.vl)
  const rollup = rollupDelivery(d.delivery ?? [])
  const send: PipelineStage = (() => {
    const label = isWhatsapp ? "WhatsApp" : "Send"
    // A paused turn deliberately sends nothing, so it has no SIDs to confirm —
    // designed silence is judged before the delivery lane.
    if (verdict?.disposition === "suppressed_paused") {
      return { key: "send", label, state: "ok" as StageState, sub: "paused · designed silence" }
    }
    if (rollup !== null) {
      const parts = rollup.total > 1 ? ` (${rollup.total} parts)` : ""
      if (rollup.state === "failed") {
        return {
          key: "send",
          label,
          state: "fail" as StageState,
          sub: `failed · ${rollup.failed}/${rollup.total} not delivered`,
        }
      }
      if (rollup.state === "delivered") {
        return { key: "send", label, state: "ok" as StageState, sub: `delivered${parts}` }
      }
      // Pending: Twilio accepted it, no confirmation yet. Absence of a callback
      // is NOT a failure — the normal state of a reply sent moments ago.
      return {
        key: "send",
        label,
        state: "silent" as StageState,
        sub: `pending · ${rollup.pending}/${rollup.total} unconfirmed`,
      }
    }
    // No delivery rows: a web turn, or a whatsapp turn from before SID capture
    // existed. Fall back to the pre-LE2-030 verdict, unchanged.
    if (verdict !== null) {
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

/** The "most relevant data" behind one donut — compact per-stage evidence for
 *  the pipeline drill-down, derived entirely from the already-loaded detail
 *  (no extra fetch). Mirrors the same signals derivePipeline judges by, so the
 *  facts always explain the donut's state. Returns [] for an unknown key. */
export function stageFacts(d: RcaTurnDetail, key: string): string[] {
  const callFacts = (c: LlmCall): string[] => [
    `persona: ${c.persona ?? "?"}`,
    `model: ${c.model ?? "?"}${c.temperature !== null ? ` · temp ${c.temperature}` : ""}`,
    `tokens: in ${c.inputTokens ?? 0} · out ${c.outputTokens ?? 0} · ${c.durationMs ?? "?"}ms`,
    ...(callEmpty(c) ? ["completion: <EMPTY>"] : []),
  ]
  const fieldFacts = (l: VlLine | undefined): string[] =>
    l?.fields != null
      ? Object.entries(l.fields)
          .filter(([k]) => k !== "event")
          .map(([k, v]) => `${k}: ${v}`)
      : []
  switch (key) {
    case "inbound": {
      return [
        `channel: ${d.context.channel ?? "?"}`,
        `started: ${d.context.startedAt ?? "?"}`,
        `duration: ${d.context.durationMs ?? "?"}ms`,
        ...fieldFacts(d.vl.find((l) => l.fields?.event === "turn")),
      ]
    }
    case "planner": {
      const c = planner(d)
      return c === undefined ? ["no planner call"] : callFacts(c)
    }
    case "claims": {
      const c = claimPlanner(d)
      return [
        ...(c === undefined ? ["no claim-planner call"] : callFacts(c)),
        ...fieldFacts(d.vl.find((l) => l.fields?.event === "claims.terminal")),
      ]
    }
    case "kernel": {
      if (d.degraded?.adj === true) return ["ADJ lane degraded — absence is not a signal here"]
      const rows = d.adj.filter((a) => a.kind !== ARCHIVER_KIND && a.decisionKind !== null)
      if (rows.length === 0) return ["no envelopes (a read-only turn adjudicates nothing)"]
      return rows.map(
        (a) =>
          `${a.kind ?? "?"} → ${a.decisionKind ?? "?"}${a.refusalCode !== null ? ` (${a.refusalCode})` : ""}${
            a.taint !== null ? ` · taint ${a.taint}` : ""
          }${a.supersedes !== null ? ` ↩ resumes ${a.supersedes.reason ?? "?"}` : ""}`,
      )
    }
    case "responder": {
      const c = responder(d)
      if (c === undefined) return ["no responder call"]
      return [...callFacts(c), ...(callEmpty(c) ? [] : [`reply: ${(c.completion ?? "").slice(0, 200)}`])]
    }
    case "send": {
      // LE2-030 — Twilio's per-part delivery confirmation leads the evidence:
      // it is the only fact here that speaks about the HANDSET rather than
      // about our own process. reply.sent follows as the local view.
      const rows = d.delivery ?? []
      const deliveryFacts: string[] = []
      if (rows.length > 0) {
        const r = rollupDelivery(rows)!
        deliveryFacts.push(
          `delivery: ${r.delivered} delivered · ${r.failed} failed · ${r.pending} pending (${r.total} parts)`,
          ...rows.map((row) => {
            const state = deliveryState(row.status)
            const err =
              row.errorCode !== null || row.errorMessage !== null
                ? ` — ${row.errorCode ?? "?"}${row.errorMessage !== null ? `: ${row.errorMessage}` : ""}`
                : ""
            const at = row.statusAt ?? row.sentAt ?? "?"
            return `part ${row.partIndex} [${row.source ?? "send"}] ${row.messageSid ?? "?"}: ${state}${
              row.status !== null ? ` (${row.status})` : " — no callback yet"
            } @ ${at}${err}`
          }),
        )
      } else if (d.degraded?.delivery === true) {
        deliveryFacts.push("delivery lane degraded — absence is not a signal here")
      }

      const ev = d.vl.find((l) => l.fields?.event === "reply.sent")
      if (ev !== undefined) return [...deliveryFacts, ...fieldFacts(ev)]
      if (hasLegacySend(d.vl)) return [...deliveryFacts, "legacy [whatsapp.send] line present"]
      if (deliveryFacts.length > 0) return deliveryFacts
      return [d.degraded?.vl === true ? "VL lane degraded — absence is not a signal here" : "no send event"]
    }
    case "archive": {
      const n = d.adj.filter((a) => a.kind === ARCHIVER_KIND && a.decisionKind === "EXECUTE").length
      return n > 0 ? [`archiver ${ARCHIVER_KIND} EXECUTE ×${n}`] : ["no archiver rows"]
    }
    default:
      return []
  }
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
