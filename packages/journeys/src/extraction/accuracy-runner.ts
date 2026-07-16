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
// `order.status.transition` was the only chat-drivable capability wired to
// the ops/staff plane at FE-T05; the drive path below (`driveExtractionCorpusOverOpsChat`)
// is therefore staff-session-shaped (`admin:<staffId>` actor).
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
//
// FE-T10 EXTENDED this same gotcha to a SECOND key: a REQUEST_CONFIRMATION a
// case parks lives in the claustrum Session (`claustrum:session:admin:<id>`),
// not the chat-history key above. `order.status.transition`'s 20 cases never
// exposed this (none of them park), but a MONEY-TIER capability's cases
// ALWAYS park (the BKL-085 UNTRUSTED-taint overlay), so `clearHistory`
// callers (accuracy-cli.ts's `createOpsHistoryClearer`) now clear BOTH keys —
// without the second, the ops confirmation-matcher's pt-BR affirmative
// lexicon ("pode", "ok", "isso", "claro", "manda", "beleza"...) can silently
// resolve an UNRELATED later case's ordinary utterance as a "confirm" of a
// still-parked EARLIER case's refund (live-caught during FE-T10's corpus
// authoring). Any FUTURE confirmation-parking capability (T11-14) gets this
// isolation for free through the same `clearHistory` seam.
//
// ── `driveExtractionCorpusOverCustomerChat` (FE-T12 — the customer-plane
//    drive path, SHARED infra for T11/T13/T14's customer-plane capabilities
//    too) ──────────────────────────────────────────────────────────────────
//
// The customer/web plane is a genuinely different route: `POST /api/chat/
// messages` (apps/api/src/routes/chat.ts) is FIRE-AND-FORGET — it returns
// `{messageId, sessionToken?, sessionSecret?}` almost immediately and
// delivers the actual reply asynchronously over SSE
// (`GET /api/chat/stream/:sessionId`). This driver never consumes the SSE
// stream: exactly like `driveExtractionCorpusOverOpsChat` (which ALSO never
// reads `decision`/`reply` off the ops-chat response body for scoring), the
// only signal that matters is the settle-polled `AuditRecord` — so the
// async/sync distinction between the two routes doesn't change the scoring
// mechanism, only the POST helper's response shape and the auth transport
// (a customer JWT `token=` cookie, minted via `@ibatexas/journeys`'
// `mintCustomerToken` — accuracy-cli.ts's `resolveCustomerCookie` — rather
// than the staff `staff_token=` cookie).
//
// CONFIRM-KIND SEMANTICS (team-lead review): `order.checkout.create` and
// `order.cancel` are BOTH confirm/park kinds for every case in their
// corpora (checkout: no money-boundary case reaches EXECUTE without extra
// unmodeled cart/session state; cancel: the auto-resolve-confirm guard fires
// unconditionally under this ticket's schema scope). Every case therefore
// ENDS AT THE PARK: this driver POSTs the utterance ONCE, settle-polls for
// the resulting REQUEST_CONFIRMATION (or ESCALATE/REFUSE) audit record, and
// scores its `languageEngine` sidecar — it NEVER sends a follow-up
// affirmative ("sim"/"pode"/...). No case in scope ever executes a real
// mutation on the shared dev stack.
//
// ISOLATION (FE-D13): unlike the ops plane's single reused `admin:<staffId>`
// identity, the web plane's session-scoped state
// (`session:<sessionId>` — conversation history, apps/api/src/session/
// store.ts; `claustrum:session:<sessionId>` — the parked/deferred envelope,
// apps/api/src/claustrum-bootstrap.ts's `claustrumSessionKey`) is keyed by
// the CLIENT-SUPPLIED `sessionId`, not by `customerId`. `clearHistory` MUST
// clear BOTH keys before every case: a lingering park from case N that case
// N+1's utterance lexically confirms (the same pt-BR affirmative-lexicon
// hazard FE-T10 found on the ops plane) would EXECUTE a real mutation on the
// shared dev stack — the exact hazard this isolation seam exists to close.
// A `clearHistory` failure is NEVER swallowed (mirrors `createOpsHistoryClearer`'s
// loud warn-once + rethrow + `isolationFailures` attribution) — a silently
// degraded customer-plane run must never read as trustworthy either.
//
// SESSION-PER-CASE ROTATION (team-lead ruling, post-live-calibration review):
// this driver originally reused ONE `sessionId` across the whole run
// (mirroring the ops driver's one reused `admin:<staffId>` identity). Live
// calibration disproved that shape: each corpus case is an independent,
// single-turn scenario, so a FRESH session per case is the semantically
// correct calibration unit, not an optimization — it closes the stale-park
// cross-case contamination hazard above categorically (no shared
// `session:<id>`/`claustrum:session:<id>` state can leak between cases when
// every case gets its own id) rather than relying solely on `clearHistory`
// to race it closed. `clearHistory` is KEPT as belt-and-braces (a fresh
// UUID could theoretically collide, and it still guards a mid-run retry of
// the SAME generated id) — it is not made redundant by rotation, just no
// longer the sole isolation mechanism. `sessionId` is therefore generated
// PER CASE inside the loop (see `sessionIdFactory`, default `randomUUID`);
// the caller supplies a `scopeForSession(sessionId)` factory instead of one
// static `scope`, since the audit-reader scope (`hashedSessionId(...)`) must
// be recomputed for each case's fresh id.
//
// KNOWN HARNESS FAILURE SIGNATURE — `token_budget.exhausted`: a live run
// against the seeded calibration customer can REFUSE with
// `refusal_code: 'token_budget.exhausted'` (compose-policy-packs.ts's
// `sessionTokenBudgetGuard`, F4/ADR-120) partway through a long corpus. Do
// NOT mistake this for an extraction miss — check `intent_audit.refusal_code`
// before attributing a run of failures to the model. IMPORTANT: this
// driver's session-per-case rotation does NOT reset that guard's counter —
// `sessionTokenKey(channel, customerId)` (resolve-and-assemble.ts) is keyed
// by `customerId`, not by `sessionId`, so every case in a run still meters
// onto the ONE seeded calibration customer's cumulative total regardless of
// how many fresh sessionIds this driver mints. A long enough run against a
// single seeded customer can still exhaust the budget; this is a REAL
// governance guard doing its job (never patched or exempted for harness
// convenience — team-lead ruling), so the mitigation is bounding a single
// run's total turns per customer, not defeating the counter.

import { randomUUID } from "node:crypto"
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

// ── Customer-plane driver (FE-T12) ──────────────────────────────────────────

/** Minimal `/api/chat/messages` POST response shape (route doc comment — never imported). */
interface CustomerChatPostResponse {
  messageId?: string
  sessionToken?: string
  sessionSecret?: string
}

export interface DriveExtractionCorpusOverCustomerChatOptions {
  /** SUT api base, e.g. `http://localhost:3001`. */
  apiBaseUrl: string
  /** The `Cookie` header value (customer JWT — `cookieHeader(mintCustomerToken(...))`). */
  customerCookie: string
  /**
   * Mints a fresh web sessionId for EACH case (module header,
   * "SESSION-PER-CASE ROTATION") — never one id reused for the whole run.
   * Defaults to `randomUUID`; injectable so tests get deterministic,
   * enumerable ids instead of asserting against opaque UUIDs.
   */
  sessionIdFactory?: () => string
  /**
   * Reads back the driven turn's materialized IR (the FE-2 primary
   * assertion seam).
   */
  audit: AuditReader
  /**
   * Computes the audit scope for a given case's freshly-minted sessionId —
   * `(sessionId) => ({sessionIds: [hashedAuditSessionId(sessionId, ...)]})`
   * (the customer/web actor's `sessionId` rides the envelope UNPREFIXED,
   * unlike ops's `admin:<staffId>` — see the module header). A FACTORY,
   * not a static `RunSessionScope`, because rotation means every case's
   * scope differs.
   */
  scopeForSession: (sessionId: string) => RunSessionScope
  /** Injectable fetch (tests default to a scripted double). */
  fetchImpl?: typeof fetch
  /**
   * Clears BOTH the web conversation-history key (`session:<sessionId>`) AND
   * the claustrum parked-envelope key (`claustrum:session:<sessionId>`)
   * before each case — belt-and-braces alongside session-per-case rotation
   * (module header). Optional: a no-op default tolerates an environment
   * without Redis wired, at the cost of the isolation guarantee.
   */
  clearHistory?: (sessionId: string) => Promise<void>
  /** Per-case audit-settle poll (mirrors the ops driver's same-named options). */
  settleTimeoutMs?: number
  settlePollMs?: number
  /** Mandatory gap after each case, before the next one starts (see the ops driver's constant doc — identical rationale). */
  interCaseDelayMs?: number
  onProgress?: (line: string) => void
}

/** POST one utterance to the customer/web chat route. Never throws on a non-2xx — surfaced as a case failure.
 *  The route is FIRE-AND-FORGET (see module header) — this never reads `decision`/`reply` off the body, exactly
 *  like `postOpsChat` doesn't either; only `res.ok`/`res.status` matter here. */
async function postCustomerChat(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  cookie: string,
  sessionId: string,
  message: string,
): Promise<{
  ok: boolean
  status: number
  body: CustomerChatPostResponse | undefined
  bodyText: string
}> {
  const res = await fetchImpl(`${apiBaseUrl}/api/chat/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sessionId, message, channel: "web" }),
  })
  let bodyText = ""
  try {
    bodyText = await res.text()
  } catch {
    /* best-effort */
  }
  let body: CustomerChatPostResponse | undefined
  try {
    body =
      bodyText === "" ? undefined : (JSON.parse(bodyText) as CustomerChatPostResponse)
  } catch {
    body = undefined
  }
  return { ok: res.ok, status: res.status, body, bodyText }
}

/**
 * Drive every case in `corpus` as ONE customer/web-chat turn each — the
 * FE-T12 customer-plane sibling of {@link driveExtractionCorpusOverOpsChat}.
 * Same contract (never throws on a per-case failure; a `clearHistory`
 * failure is collected into `isolationFailures`, never swallowed, and does
 * NOT abort the run) and the SAME settle-poll-then-`evaluateExpectPayload`
 * scoring mechanism — see the module header's CONFIRM-KIND SEMANTICS note
 * for why this never sends a follow-up affirmative.
 */
export async function driveExtractionCorpusOverCustomerChat(
  corpus: readonly ExtractionCorpusFile[],
  opts: DriveExtractionCorpusOverCustomerChatOptions,
): Promise<DriveExtractionCorpusResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch)
  const sessionIdFactory = opts.sessionIdFactory ?? randomUUID
  const settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  const settlePollMs = opts.settlePollMs ?? DEFAULT_SETTLE_POLL_MS
  const interCaseDelayMs = opts.interCaseDelayMs ?? DEFAULT_INTER_CASE_DELAY_MS
  const onProgress = opts.onProgress ?? (() => undefined)
  const seenIntentHashes = new Set<string>()
  const results: AccuracyCaseResult[] = []
  const isolationFailures: IsolationFailure[] = []

  for (const file of corpus) {
    for (const kase of file.cases) {
      try {
        const startedAt = Date.now()
        // SESSION-PER-CASE ROTATION (module header): a fresh sessionId (and
        // its derived scope) for EVERY case — never one id reused for the
        // whole run. `seenIntentHashes` is kept as defense-in-depth, but a
        // rotated scope structurally cannot match a PRIOR case's record —
        // different sessionId -> different hashedSessionId -> the audit
        // reader's scope filter excludes it outright.
        const sessionId = sessionIdFactory()
        const scope = opts.scopeForSession(sessionId)
        // Same 2s clock-skew slack as the ops driver, same rationale: never
        // exclude the record THIS case is about to produce.
        const caseSince = new Date(startedAt - 2_000).toISOString()
        if (opts.clearHistory !== undefined) {
          try {
            await opts.clearHistory(sessionId)
          } catch (err) {
            isolationFailures.push({
              capability: file.capability,
              caseId: kase.id,
              detail: (err as Error).message,
            })
          }
        }

        const post = await postCustomerChat(
          fetchImpl,
          opts.apiBaseUrl,
          opts.customerCookie,
          sessionId,
          kase.utterance,
        )
        if (!post.ok) {
          const failure = `customer-chat POST -> HTTP ${post.status}${post.bodyText ? ` — ${truncate(post.bodyText)}` : ""}`
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

        // Settle-poll for the NEW audit record this (async, fire-and-forget)
        // turn produces — see the module header on why the POST response
        // body is never the scoring signal for this route.
        const deadline = Date.now() + settleTimeoutMs
        let matched:
          | Awaited<ReturnType<AuditReader["fetchRecords"]>>[number]
          | undefined
        for (;;) {
          const records = await opts.audit.fetchRecords(scope, {
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
