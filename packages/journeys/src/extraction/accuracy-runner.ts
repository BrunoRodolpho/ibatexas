// extraction/accuracy-runner.ts — the extraction-accuracy meter's IMPURE
// half (FE-T07, FE-2.3/FE-2.4). Drives each corpus utterance as ONE turn
// against the LIVE model through the REAL production surface: the ops-chat
// route (`POST /api/admin/ops/chat`, apps/api/src/routes/admin/ops-chat.ts —
// never imported, TEST-PLANE ONLY, check-bypass leg 6/7), which composes the
// SAME `buildToolSurface` + persona the FE-T06 golden gate byte-pins. No
// separate persona-driver model is needed here (unlike `ibx journey run`'s
// PersonaDriver, which SIMULATES a human customer) — the corpus utterances
// are already fixed, authored text; this runner is a thin, single-turn HTTP
// client + the SAME audit-reader oracle every other seam reads through.
//
// `order.status.transition` is the only chat-drivable capability wired to
// the ops/staff plane today (FE-T05); the drive path below is therefore
// staff-session-shaped (`admin:<staffId>` actor). A future customer-plane
// capability's corpus would need a customer-session drive path added
// alongside this one — not built speculatively (YAGNI): today's corpus has
// exactly one capability, and it is ops-only.
//
// Test-isolation gotcha (BKL-084): the ops channel persists a PERSISTENT
// per-staffId conversation thread (Redis, `ops:chat:history:<staffId>`) so
// anaphora resolves turn-to-turn. Since only ONE staff row is seeded
// (`SEED_STAFF`, packages/domain/src/seed-constants.ts) and every case must
// authenticate as it, driving 20 corpus cases sequentially would otherwise
// share ONE ops conversation — an unrelated PRIOR case's text could bleed
// into a LATER case's planner context. `clearHistory` (defaulted to a
// direct Redis DEL of that key) resets the thread before each case, the
// ops-plane equivalent of `ibx journey run`'s fresh-ChatClient-session-per-
// attempt isolation.

import { evaluateExpectPayload } from "./expect-payload.js"
import type { ExtractionCorpusFile } from "./schema.js"
import type { AccuracyCaseResult, IsolationFailure } from "./accuracy.js"
import type { AuditReader, RunSessionScope } from "../oracle/audit-reader.js"

export class AccuracyRunnerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AccuracyRunnerError"
  }
}

/** Minimal ops-chat POST response shape (route doc comment — never imported). */
interface OpsChatResponse {
  reply?: string
  decision?: string
  executed?: boolean
}

export interface DriveExtractionCorpusOptions {
  /** SUT api base, e.g. `http://localhost:3001`. */
  apiBaseUrl: string
  /** The `Cookie` header value (staff JWT — `cookieHeader(mintStaffToken(...))`). */
  staffCookie: string
  /** The staff actor's `admin:<staffId>` sessionId (unhashed — used to key `clearHistory`). */
  staffId: string
  /** Reads back the driven turn's materialized IR (the FE-2 primary assertion seam). */
  audit: AuditReader
  /** The audit scope every case's records are read through (e.g. `{sessionIds: [hashedAuditSessionId(...)]}`). */
  scope: RunSessionScope
  /** Injectable fetch (tests default to a scripted double). */
  fetchImpl?: typeof fetch
  /**
   * Clears the ops conversation thread before each case (test isolation —
   * see module header). Optional: a no-op default tolerates an environment
   * without Redis wired, at the cost of the isolation guarantee.
   */
  clearHistory?: (staffId: string) => Promise<void>
  /** Per-case audit-settle poll (mirrors run-journey-cli.ts's AUDIT_SETTLE_*). */
  settleTimeoutMs?: number
  settlePollMs?: number
  /** Mandatory gap after each case, before the next one starts (see the constant's doc). */
  interCaseDelayMs?: number
  onProgress?: (line: string) => void
}

// Local-4B live-run calibration (FE-T07): a single ops-chat turn's model
// inference alone has been observed up to ~10-20s under this environment's
// load (see the PR report's variance note) — a tight settle window produces
// FALSE timeouts (indistinguishable from a genuine extraction miss) rather
// than real signal. 45s tolerates the slow tail while still bounding a run.
const DEFAULT_SETTLE_TIMEOUT_MS = 45_000
const DEFAULT_SETTLE_POLL_MS = 500
// A short MANDATORY gap after each case (independent of clearHistory) lets
// a genuinely slow model turn's audit write fully land before the NEXT
// case's `caseSince` window opens — reduces (does not eliminate) the risk
// of a straggling write from a timed-out case being adopted by the next
// case's poll. A rare surviving leak is exactly the class of gap the
// waiver/quarantine seam (accuracy.ts) exists to tolerate, not eliminate.
const DEFAULT_INTER_CASE_DELAY_MS = 2_000

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** POST one utterance to the ops-chat route. Never throws on a non-2xx — surfaced as a case failure. */
async function postOpsChat(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  cookie: string,
  message: string,
): Promise<{
  ok: boolean
  status: number
  body: OpsChatResponse | undefined
  bodyText: string
}> {
  const res = await fetchImpl(`${apiBaseUrl}/api/admin/ops/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message }),
  })
  let bodyText = ""
  try {
    bodyText = await res.text()
  } catch {
    /* best-effort */
  }
  let body: OpsChatResponse | undefined
  try {
    body =
      bodyText === "" ? undefined : (JSON.parse(bodyText) as OpsChatResponse)
  } catch {
    body = undefined
  }
  return { ok: res.ok, status: res.status, body, bodyText }
}

export interface DriveExtractionCorpusResult {
  results: AccuracyCaseResult[]
  /**
   * Per-case `clearHistory` failures (review MAJOR, #263) — NEVER silently
   * swallowed. A persistent failure (e.g. a missing `REDIS_URL` — the exact
   * live cause found and fixed in this PR) contaminates every case
   * identically, so a same-environment cross-run comparison alone can never
   * catch it. The caller (accuracy-cli.ts) threads these into
   * `computeAccuracyReport`, which turns each one into a hard
   * `isolation_degraded` problem (`report.ok: false`) — never cosmetic.
   */
  isolationFailures: IsolationFailure[]
}

/**
 * Drive every case in `corpus` as ONE ops-chat turn each, in file/declaration
 * order (deterministic — no reordering across a run), scoring each against
 * its authored `expectPayload` via the REAL `evaluateExpectPayload`
 * compiler. Never throws on a per-case failure (an HTTP error, a settle
 * timeout, or a failed expectPayload evaluation all become a `{ok: false}`
 * result) — the ratio-runner contract (FE-2.3): "never breaking on first
 * miss." A `clearHistory` failure does NOT abort the run either (the
 * remaining cases still drive, for diagnostic value) — it is instead
 * collected into `isolationFailures` so the caller can fail the OVERALL
 * report, per the module header's isolation gotcha.
 */
export async function driveExtractionCorpusOverOpsChat(
  corpus: readonly ExtractionCorpusFile[],
  opts: DriveExtractionCorpusOptions,
): Promise<DriveExtractionCorpusResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch)
  const settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  const settlePollMs = opts.settlePollMs ?? DEFAULT_SETTLE_POLL_MS
  const interCaseDelayMs = opts.interCaseDelayMs ?? DEFAULT_INTER_CASE_DELAY_MS
  const onProgress = opts.onProgress ?? (() => undefined)
  const seenIntentHashes = new Set<string>()
  const results: AccuracyCaseResult[] = []
  const isolationFailures: IsolationFailure[] = []

  for (const file of corpus) {
    for (const kase of file.cases) {
      // `finally` guarantees the inter-case settle gap runs exactly once per
      // case, on every exit path (POST failure / settle timeout / scored) —
      // see the constant's doc for why this gap exists.
      try {
        const startedAt = Date.now()
        // A 2s clock-skew slack (mirrors run-journey-cli.ts's own `since`
        // barriers) BEFORE the POST — never after — so the query can never
        // exclude the very record this case is about to produce, while still
        // excluding every genuinely-historical record: this staff's
        // `admin:<staffId>` session has extensive PRIOR activity (other live
        // drives against this same seeded staff), so an unscoped fetch can
        // match a stale record from a past session on the FIRST poll —
        // silently scoring the WRONG case (live-caught: see PR report).
        const caseSince = new Date(startedAt - 2_000).toISOString()
        if (opts.clearHistory !== undefined) {
          try {
            await opts.clearHistory(opts.staffId)
          } catch (err) {
            // NOT swallowed (review MAJOR): recorded so the caller can fail
            // the whole report, even though this case still drives —
            // partial-degraded results stay diagnostically visible, but the
            // report itself can never read as clean.
            isolationFailures.push({
              capability: file.capability,
              caseId: kase.id,
              detail: (err as Error).message,
            })
          }
        }

        const post = await postOpsChat(
          fetchImpl,
          opts.apiBaseUrl,
          opts.staffCookie,
          kase.utterance,
        )
        if (!post.ok) {
          const failure = `ops-chat POST -> HTTP ${post.status}${post.bodyText ? ` — ${truncate(post.bodyText)}` : ""}`
          onProgress(`  ✗ ${file.capability}:${kase.id} — ${failure}`)
          results.push({
            capability: file.capability,
            caseId: kase.id,
            utterance: kase.utterance,
            ok: false,
            failures: [failure],
            durationMs: Date.now() - startedAt,
          })
          continue
        }

        // Settle-poll for the NEW audit record this turn produced (the sink
        // write can lag slightly behind the synchronous HTTP response).
        const deadline = Date.now() + settleTimeoutMs
        let matched:
          | Awaited<ReturnType<AuditReader["fetchRecords"]>>[number]
          | undefined
        for (;;) {
          const records = await opts.audit.fetchRecords(opts.scope, {
            intentKind: file.capability,
            since: caseSince,
          })
          matched = records.find((r) => !seenIntentHashes.has(r.intentHash))
          if (matched !== undefined || Date.now() >= deadline) break
          await new Promise((r) => setTimeout(r, settlePollMs))
        }

        if (matched === undefined) {
          const failure = `no NEW ${file.capability} audit record settled within ${settleTimeoutMs}ms`
          onProgress(`  ✗ ${file.capability}:${kase.id} — ${failure}`)
          results.push({
            capability: file.capability,
            caseId: kase.id,
            utterance: kase.utterance,
            ok: false,
            failures: [failure],
            durationMs: Date.now() - startedAt,
          })
          continue
        }
        seenIntentHashes.add(matched.intentHash)

        const evaluation = evaluateExpectPayload(kase.expectPayload, matched)
        onProgress(
          `  ${evaluation.ok ? "✓" : "✗"} ${file.capability}:${kase.id} — "${truncate(kase.utterance, 60)}" (${matched.decision.kind})`,
        )
        results.push({
          capability: file.capability,
          caseId: kase.id,
          utterance: kase.utterance,
          ok: evaluation.ok,
          failures: evaluation.failures,
          durationMs: Date.now() - startedAt,
        })
      } finally {
        await new Promise((r) => setTimeout(r, interCaseDelayMs))
      }
    }
  }

  return { results, isolationFailures }
}
