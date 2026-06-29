// schema/scaffold.ts — `ibx journey from-audit <sessionId>` (T2-3).
//
// Scaffolds a journey YAML from a PRODUCTION AUDIT SLICE: the conversation
// transcript (the same `ibx chat dump --json` material, read here from
// `ibx_domain.conversations` via the SELECT-only oracle role) plus the
// session's `intent_audit` rows, fetched through the run-scoped AuditReader
// (T1a-7).
//
// ── D-012 reality (binding) ──────────────────────────────────────────────────
//
// The operator passes the RAW chat session id (e.g. `web:sess-<uuid>`, from
// `ibx chat list`). The audit sink's redactor HASHES every envelope
// actor.sessionId before the row lands:
//
//   intent_audit.session_id
//     = "hashed:" + sha256(rawSessionId + AUDIT_REDACT_SECRET).hex.slice(0, 8)
//
// (packages/audit-sink/src/audit-redactor.ts `hashValue`; wiring
// intent-audit-wiring.ts:210). The scaffolder re-derives that namespace with
// `hashedAuditSessionId` (oracle/domain-reader.ts — the byte-for-byte mirror),
// so it MUST run against the test/ops environment whose env file carries the
// SAME `AUDIT_REDACT_SECRET` the stack's audit sink used (the `ibx journey
// from-audit` command loads `.env.test` by default — `--env-file` for an ops
// env). The secret itself is never logged and never lands in the scaffold —
// only the derived `hashed:xxxxxxxx` token may appear in output.
//
// ── What a scaffold is (governance) ──────────────────────────────────────────
//
// A scaffold is NEVER born active: it is emitted with `status: blocked`,
// `blocked_by: [scaffold-review]`, a `JOURNEY-000` placeholder id, and
// TODO(scaffold-review) markers. It is schema-valid and `ibx journey lint`-
// green as authored, so the only thing between a scaffold and the registry is
// the human review the blocker names. Derivation rules:
//
//   acts     ← the USER side of the transcript, one chat act per utterance
//              (assistant replies surface as authoring notes only); raw
//              Medusa entity ids are scrubbed to `<medusa-id>` (handle-only
//              governance, schema rule `raw_medusa_id`).
//   expects  ← observed intentKind×decision tuples in trajectory order,
//              first occurrence per tuple. `optional: true` (reconciliation
//              allowance, T1b-1) is applied heuristically to noisy extras:
//              REFUSE tuples whose kind ALSO reached a non-REFUSE decision in
//              the same slice (retry-noise shape), and inner projection-level
//              `*.status.transition` kinds (the JOURNEY-001 precedent).
//   verify   ← skeleton: `audit.trajectory.in_order` + `audit.record.verified`
//              plus TODO(scaffold-review) goal-state markers (comments — a
//              scaffold never fabricates goal-state assertions).

import pg from "pg"
import { stringify as stringifyYaml } from "yaml"
import type { AuditRecord } from "@adjudicate/core"

import {
  createAuditReader,
  type OracleQueryable,
} from "../oracle/audit-reader.js"
import { hashedAuditSessionId } from "../oracle/domain-reader.js"
import { requireOracleDatabaseUrl } from "../oracle/oracle-database-url.js"
import {
  INTENT_KIND_PATTERN,
  JOURNEY_EXPECT_DECISIONS,
  validateJourney,
  type Journey,
  type JourneyExpect,
  type JourneyVerify,
} from "./journey.js"
import { parseJourneyYaml } from "./load.js"

// ── Vocabulary pins ──────────────────────────────────────────────────────────

/** Placeholder id every scaffold is born with — renumbering is review step 1. */
export const SCAFFOLD_PLACEHOLDER_ID = "JOURNEY-000"

/** The blocker id that keeps a scaffold out of the active suite. */
export const SCAFFOLD_REVIEW_BLOCKER = "scaffold-review"

export class FromAuditScaffoldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FromAuditScaffoldError"
  }
}

// ── Input shapes ─────────────────────────────────────────────────────────────

export interface ScaffoldTranscriptMessage {
  /** `user` / `assistant` / `system` (Prisma MessageRole / chat dump roles). */
  role: string
  content: string
}

export interface ScaffoldTranscript {
  messages: readonly ScaffoldTranscriptMessage[]
  /**
   * `ibx_domain.conversations.customer_id` — non-null means the session was
   * an authenticated-customer one (`params.authenticated: true`, which also
   * picks the lint persona context, DR-5). `--transcript` (chat dump JSON)
   * input carries no binding → null → guest until review confirms.
   */
  customerId: string | null
}

/** One observed audited kernel decision, trajectory order. */
export interface ScaffoldObservedDecision {
  intentKind: string
  decision: string
}

/** Project fetched `AuditRecord`s onto the observed-tuple input shape. */
export function observedDecisionsFromRecords(
  records: readonly AuditRecord[],
): ScaffoldObservedDecision[] {
  return records.map((r) => ({
    intentKind: r.envelope.kind,
    decision: r.decision.kind,
  }))
}

/**
 * Parse `ibx chat dump <sessionId> --json` output (array of
 * `{role, content, …}`) into a ScaffoldTranscript. The dump carries no
 * customer binding → `customerId: null` (guest until review confirms).
 */
export function transcriptFromChatDumpJson(jsonText: string): ScaffoldTranscript {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    throw new FromAuditScaffoldError(
      `transcript is not valid JSON (expected \`ibx chat dump <id> --json\` output): ${(err as Error).message}`,
    )
  }
  if (!Array.isArray(parsed)) {
    throw new FromAuditScaffoldError(
      "transcript JSON must be an ARRAY of {role, content} messages (the `ibx chat dump --json` shape)",
    )
  }
  const messages: ScaffoldTranscriptMessage[] = parsed.map((item) => {
    const msg = (item ?? {}) as { role?: unknown; content?: unknown }
    return {
      role: typeof msg.role === "string" ? msg.role : "unknown",
      content: typeof msg.content === "string" ? msg.content : "",
    }
  })
  return { messages, customerId: null }
}

// ── Pure scaffolder ──────────────────────────────────────────────────────────

export interface ScaffoldJourneyInput {
  /** RAW chat session id — provenance only (`source: from-audit:<id>`). */
  sessionId: string
  transcript: ScaffoldTranscript
  /** Observed audit tuples for the session's hashed namespace, trajectory order. */
  observed: readonly ScaffoldObservedDecision[]
  /** The derived `hashed:xxxxxxxx` namespace, for the generated header. */
  hashedSessionId?: string
}

export interface ScaffoldedJourney {
  /** The full YAML text (header + commented sections), schema-valid as emitted. */
  yaml: string
  /** The emitted text re-parsed through the journey schema (self-check). */
  journey: Journey
}

const VALID_EXPECT_DECISIONS: ReadonlySet<string> = new Set(JOURNEY_EXPECT_DECISIONS)

/** Inner projection-level transitions — optional-allowance precedent (JOURNEY-001). */
const INNER_TRANSITION_SUFFIX = ".status.transition"

/**
 * Global scrub of raw Medusa entity-id literals (the schema's
 * `raw_medusa_id` rule) out of free transcript text — journeys reference
 * catalog entities by handle only, and production ids are not seed-stable.
 */
const RAW_MEDUSA_ID_SCRUB = /(^|\W)((?:prod|variant|cart)_[A-Za-z0-9]{8,})/g

function scrubRawMedusaIds(text: string): string {
  return text.replace(RAW_MEDUSA_ID_SCRUB, "$1<medusa-id>")
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

/** Sanitize free text for embedding inside generated YAML comments. */
function commentSafe(text: string): string {
  return truncate(text, 200)
}

function deriveExpects(observed: readonly ScaffoldObservedDecision[]): {
  expects: JourneyExpect[]
  skipped: number
} {
  // Kinds that reached a non-REFUSE decision somewhere in the slice — their
  // REFUSE rows are the retry-noise shape (fumble → success) and become
  // optional allowances. A REFUSE with no later success stays REQUIRED: the
  // session's outcome WAS the refusal (pinned-negative shape).
  const kindsWithNonRefuse = new Set<string>()
  for (const o of observed) {
    if (VALID_EXPECT_DECISIONS.has(o.decision) && o.decision !== "REFUSE") {
      kindsWithNonRefuse.add(o.intentKind)
    }
  }

  const expects: JourneyExpect[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const o of observed) {
    if (!VALID_EXPECT_DECISIONS.has(o.decision) || !INTENT_KIND_PATTERN.test(o.intentKind)) {
      skipped += 1
      continue
    }
    const key = `${o.intentKind} ${o.decision}`
    if (seen.has(key)) continue // duplicates: IN_ORDER + tuple reconciliation tolerate repeats
    seen.add(key)
    const optional =
      o.intentKind.endsWith(INNER_TRANSITION_SUFFIX) ||
      (o.decision === "REFUSE" && kindsWithNonRefuse.has(o.intentKind))
    expects.push({
      intentKind: o.intentKind,
      decision: o.decision as JourneyExpect["decision"],
      ...(optional ? { optional: true } : {}),
    })
  }
  return { expects, skipped }
}

interface DerivedChatAct {
  kind: "chat"
  name: string
  utterance: string
  note?: string
}

/**
 * The assistant reply that followed a user turn (before the next user turn) —
 * review context only, never asserted.
 */
function findAssistantNote(
  messages: readonly ScaffoldTranscriptMessage[],
  afterIndex: number,
): string | undefined {
  for (let j = afterIndex + 1; j < messages.length; j++) {
    const next = messages[j]!
    const role = next.role.toLowerCase()
    if (role === "user") break
    if (role === "assistant" && next.content.trim().length > 0) {
      return `assistant replied: ${truncate(scrubRawMedusaIds(next.content), 160)}`
    }
  }
  return undefined
}

function deriveChatActs(transcript: ScaffoldTranscript): DerivedChatAct[] {
  const messages = transcript.messages
  const acts: DerivedChatAct[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role.toLowerCase() !== "user") continue
    const utterance = scrubRawMedusaIds(msg.content).trim()
    if (utterance.length === 0) continue
    const note = findAssistantNote(messages, i)
    acts.push({
      kind: "chat",
      name: `turn-${String(acts.length + 1).padStart(2, "0")}`,
      utterance,
      ...(note === undefined ? {} : { note }),
    })
  }
  return acts
}

const EXPECTS_COMMENT = `# Observed intentKind×decision tuples from the audit slice, trajectory
# order, first occurrence per tuple (repeats deduped — IN_ORDER + the T1b-1
# reconciliation gate match tuples). \`optional: true\` = scaffold heuristic
# for noisy extras (REFUSE noise before a same-kind success; inner
# *.status.transition rows) — review every flag; optional entries claim NO
# coverage cells.`

const VERIFY_COMMENT = `# Verify skeleton: trajectory order + tamper-evidence only.
# TODO(scaffold-review): add goal-state invariants for the session's terminal
# state (order.goal-state / reservation.goal-state / cart.goal-state) — a
# scaffold never fabricates goal-state assertions.`

export function scaffoldJourneyFromAudit(input: ScaffoldJourneyInput): ScaffoldedJourney {
  const sessionId = input.sessionId.trim()
  if (sessionId.length === 0) {
    throw new FromAuditScaffoldError("sessionId must be non-empty (the RAW chat session id)")
  }

  const acts = deriveChatActs(input.transcript)
  if (acts.length === 0) {
    throw new FromAuditScaffoldError(
      `session "${commentSafe(sessionId)}": transcript has no user-side utterances — ` +
        "cannot derive chat acts (a journey needs at least one act)",
    )
  }

  const { expects, skipped } = deriveExpects(input.observed)
  const authenticated = input.transcript.customerId !== null
  const userTurns = acts.length
  const assistantTurns = input.transcript.messages.filter(
    (m) => m.role.toLowerCase() === "assistant",
  ).length

  const verify: JourneyVerify[] = [
    {
      invariant: "audit.trajectory.in_order",
      args: {
        note: "scaffolded: expects[] as a subsequence of the session's hashed audit namespace",
      },
    },
    { invariant: "audit.record.verified", args: {} },
  ]

  const journeyDoc = {
    id: SCAFFOLD_PLACEHOLDER_ID,
    title: "TODO(scaffold-review): title this journey (from-audit scaffold)",
    businessCase:
      "TODO(scaffold-review): why does the business care? Scaffolded from a " +
      `production audit slice of chat session "${commentSafe(sessionId)}".`,
    persona:
      "TODO(scaffold-review): persona descriptor (pt-BR). Transcript opens: " +
      `"${truncate(acts[0]!.utterance, 120)}"`,
    channel: "web",
    status: "blocked",
    blocked_by: [SCAFFOLD_REVIEW_BLOCKER],
    source: `from-audit:${sessionId}`,
    params: { authenticated },
    acts,
    expects,
    verify,
  }

  // Validate the OBJECT before emitting — a hostile transcript or a schema
  // drift must fail here with named codes, never emit an unlintable file.
  const validation = validateJourney(journeyDoc)
  if (!validation.ok) {
    const summary = validation.errors.map((e) => `${e.code} at ${e.path || "<root>"}`).join("; ")
    throw new FromAuditScaffoldError(
      `scaffold did not validate against the journey schema (${summary}) — ` +
        "this is a scaffolder bug or hostile transcript content; nothing was emitted",
    )
  }

  const header = [
    `# ${SCAFFOLD_PLACEHOLDER_ID} — FROM-AUDIT SCAFFOLD (\`ibx journey from-audit\`, T2-3).`,
    "#",
    "# Derived from a production audit slice:",
    `#   raw chat session id : ${commentSafe(sessionId)}`,
    `#   audit namespace     : ${input.hashedSessionId ?? "(not derived — transcript-only input)"}`,
    `#   transcript turns    : ${userTurns} user / ${assistantTurns} assistant`,
    `#   audited envelopes   : ${input.observed.length} row(s) → ${expects.length} expect tuple(s)` +
      (skipped > 0 ? ` (${skipped} non-conforming row(s) skipped)` : ""),
    "#",
    "# A scaffold is NEVER born active (status: blocked, blocked_by:",
    `# [${SCAFFOLD_REVIEW_BLOCKER}]). Review checklist:`,
    `#   1. renumber ${SCAFFOLD_PLACEHOLDER_ID} to the next free id (registry:`,
    "#      packages/journeys/journeys/) and name the file <id>-<slug>.yaml",
    "#   2. write title / businessCase / persona (placeholders below)",
    "#   3. confirm params.authenticated (derived from",
    "#      ibx_domain.conversations.customer_id; --transcript input defaults",
    "#      to guest) — it picks the lint persona context (DR-5)",
    "#   4. review expects[]: promote/demote `optional: true` allowances",
    "#      (T1b-1) and delete incidental tuples",
    "#   5. replace the TODO goal-state markers in verify[] with real",
    "#      invariants; add fixture acts for the preconditions the original",
    "#      production state implied (preconditions ONLY — never asserted",
    "#      state)",
    "#   6. activate (status: active, blocked_by: []) only once live-green",
  ].join("\n")

  const body = stringifyYaml(journeyDoc, { lineWidth: 100 })
    // Top-level keys are the only flush-left lines in the emitted document,
    // so these anchors are unambiguous.
    .replace(/^expects:/m, `${EXPECTS_COMMENT}\nexpects:`)
    .replace(/^verify:/m, `${VERIFY_COMMENT}\nverify:`)
  const yaml = `${header}\n${body}`

  // Self-check: the EMITTED TEXT (comments included) must round-trip the
  // schema — the returned journey comes from the text, not the object.
  const journey = parseJourneyYaml(yaml, "<from-audit scaffold>")
  return { yaml, journey }
}

// ── Fetch orchestrator (the `ibx journey from-audit` engine) ────────────────

export interface FromAuditScaffoldOptions {
  /** Env source (default `process.env`) — needs AUDIT_REDACT_SECRET (+ ORACLE_DATABASE_URL unless `pool`). */
  env?: Record<string, string | undefined>
  /** Inject a pool/double (tests, shared pools). Default: pg Pool from `requireOracleDatabaseUrl(env)`. */
  pool?: OracleQueryable
  /** Bypass the Postgres transcript fetch (e.g. `transcriptFromChatDumpJson` of a Redis-only dump). */
  transcript?: ScaffoldTranscript
  /** Audit row cap (AuditReader default: 500). */
  maxRows?: number
}

export interface FromAuditScaffoldResult extends ScaffoldedJourney {
  /** The derived D-012 namespace (`hashed:xxxxxxxx`) — safe to print. */
  hashedSessionId: string
  auditRows: number
  expectTuples: number
  chatActs: number
}

const TRANSCRIPT_SQL =
  `SELECT c.customer_id AS "customerId", m.role AS "role", m.content AS "content" ` +
  `FROM ibx_domain.conversations c ` +
  `LEFT JOIN ibx_domain.conversation_messages m ON m.conversation_id = c.id ` +
  `WHERE c.session_id = $1 ` +
  `ORDER BY m.sent_at ASC, m.id ASC`

interface TranscriptRow {
  customerId: string | null
  role: string | null
  content: string | null
}

async function fetchTranscript(
  pool: OracleQueryable,
  rawSessionId: string,
): Promise<ScaffoldTranscript | null> {
  const result = await pool.query(TRANSCRIPT_SQL, [rawSessionId])
  const rows = result.rows as TranscriptRow[]
  if (rows.length === 0) return null
  return {
    customerId: rows[0]!.customerId,
    messages: rows
      .filter((r) => r.role !== null && r.content !== null)
      .map((r) => ({ role: r.role as string, content: r.content as string })),
  }
}

/**
 * Fetch transcript + audit slice for a RAW chat session id and scaffold the
 * journey. Reads go exclusively through the SELECT-only oracle plane; the
 * D-012 namespace is re-derived locally from AUDIT_REDACT_SECRET (which is
 * why this runs against the test/ops env that carries the stack's secret).
 */
export async function scaffoldFromAuditSession(
  rawSessionId: string,
  options: FromAuditScaffoldOptions = {},
): Promise<FromAuditScaffoldResult> {
  const sessionId = rawSessionId.trim()
  if (sessionId.length === 0) {
    throw new FromAuditScaffoldError("sessionId must be non-empty (the RAW chat session id)")
  }

  const env = options.env ?? process.env
  const redactSecret = env["AUDIT_REDACT_SECRET"]
  if (redactSecret === undefined) {
    throw new FromAuditScaffoldError(
      "AUDIT_REDACT_SECRET is not set — `ibx journey from-audit` re-derives the hashed " +
        'audit namespace (D-012: intent_audit.session_id = "hashed:" + ' +
        "sha256(rawSessionId + AUDIT_REDACT_SECRET).hex.slice(0, 8)), so it must run " +
        "against the test/ops environment whose env file carries the SAME secret the " +
        "stack's audit sink used (default: <repo>/.env.test, or --env-file <ops-env>). " +
        "The secret is read from the environment and never logged.",
    )
  }
  const hashedSessionId = hashedAuditSessionId(sessionId, redactSecret)

  // One pool serves both the transcript query and the AuditReader; owned
  // pools come from the validated oracle URL and are closed on all paths.
  const ownedPool: pg.Pool | undefined =
    options.pool === undefined
      ? new pg.Pool({ connectionString: requireOracleDatabaseUrl(env), max: 2 })
      : undefined
  const pool: OracleQueryable = options.pool ?? (ownedPool as OracleQueryable)
  const reader = createAuditReader({
    pool,
    env,
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
  })

  try {
    const records = await reader.fetchRecords({ sessionIds: [hashedSessionId] })
    const transcript = options.transcript ?? (await fetchTranscript(pool, sessionId))

    if (transcript === null && records.length === 0) {
      throw new FromAuditScaffoldError(
        `unknown session "${commentSafe(sessionId)}": no ibx_domain.conversations row and no ` +
          `intent_audit rows in its hashed audit namespace ("${hashedSessionId}"). Check the ` +
          "RAW chat session id (`ibx chat list`; e.g. web:sess-…) and that this command runs " +
          "against the stack that served the conversation — AUDIT_REDACT_SECRET must match " +
          "the audit sink's, or the derived namespace scopes to nothing.",
      )
    }
    if (transcript === null) {
      throw new FromAuditScaffoldError(
        `session "${commentSafe(sessionId)}": found ${records.length} intent_audit row(s) in ` +
          `namespace "${hashedSessionId}" but no conversation transcript ` +
          "(ibx_domain.conversations) — the transcript is required to derive chat acts. If " +
          "the conversation only ever lived in Redis, pass " +
          "`--transcript <(ibx chat dump <id> --json)`-style dump output via --transcript.",
      )
    }

    const observed = observedDecisionsFromRecords(records)
    const scaffolded = scaffoldJourneyFromAudit({
      sessionId,
      transcript,
      observed,
      hashedSessionId,
    })
    return {
      ...scaffolded,
      hashedSessionId,
      auditRows: records.length,
      expectTuples: scaffolded.journey.expects.length,
      chatActs: scaffolded.journey.acts.length,
    }
  } finally {
    await reader.close() // no-op for injected pools (reader owns nothing here)
    await ownedPool?.end()
  }
}
