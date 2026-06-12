// harness/run-journey-cli.ts — `ibx journey run` (T1a-13): the full live
// loop, composed per attempt:
//
//   preflight (T1a-10, mandatory first step)
//     → load + validate the journey (schema v1)
//     → fixture acts (PRECONDITIONS ONLY — resolve seeded rows via the
//       SELECT-only oracle role; never write)
//     → driver acts (chat acts via PersonaDriver + ChatClient with the
//       authFixture cookie; http acts via the constrained executor below)
//     → harness re-executes verify[] with YAML-bound args (audit trajectory
//       via AuditReader/Matcher scoped to the run's HASHED session ids —
//       the T1a-5 live finding; goal-state via the oracle pg plane behind
//       the T1a-6 projection barrier)
//     → JSONL trace written to runs/<runId>/trace.jsonl (gitignored)
//     → cost report from llm.call events × the checked-in price table
//       (driver side captured in-process; SUT side parsed from
//       IBX_EVENTS_FILE — source:"sut", session-scoped).
//
// Composition choices (recorded):
//   * The PersonaDriver gets NO http executor: journey-declared http acts run
//     deterministically as standalone runner acts, so the persona model can
//     never fire a mutation act mid-conversation (it would only ever see
//     "http_executor_missing"). The closed act-tool set stays {chat} in
//     practice for chat acts; http acts are harness-mechanical.
//   * http act paths may carry `:name` segments (e.g.
//     /api/orders/:orderId/cancel), resolved from ctx.vars; `:orderId` falls
//     back to the run's own order (most-recent projection for the run's
//     customer created at/after the attempt start, behind the projection
//     barrier) — the same most-recent ordering the SUT's auto-resolve uses.
//   * Expects-matching ignores noop/smalltalk dispatches by construction:
//     turns that propose zero envelopes write no intent_audit rows, and the
//     trajectory matchers only ever see observed ENVELOPE rows (IN_ORDER
//     additionally tolerates incidental envelopes — plan §5 new fact 18).
//
// Per-attempt budgets: 10-minute wall-clock timeout (abort = red, never a
// hang) and the driver's token ceiling (DriverTokenCeilingError = red).

import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import {
  onEvent,
  emitEvidenceCapture,
  emitJourneyAborted,
  type IbxEventBase,
} from "@ibatexas/tools"

import {
  loadJourneys,
  type ChatAct,
  type FixtureAct,
  type HttpAct,
  type Journey,
} from "../schema/index.js"
import {
  runJourney,
  type ActExecutionResult,
  type ActExecutors,
  type JourneyRunContext,
} from "../runner/run-journey.js"
import { runPreflight, type PreflightResult } from "./preflight.js"
import { loadTestEnv } from "./test-env.js"
import {
  attemptCost,
  loadPriceTable,
  readSutLlmCalls,
  renderCostLine,
  formatUsd,
  type AttemptCost,
  type LlmCallLike,
  type PriceTable,
} from "./cost.js"
import { ChatClient } from "../clients/chat-client.js"
import { cookieHeader, mintCustomerToken } from "../clients/auth-fixture.js"
import {
  PersonaDriver,
  createDriverChatExecutor,
} from "../driver/persona-driver.js"
import { createAnthropicModelProvider } from "../driver/anthropic-provider.js"
import {
  reconcileExpects,
  RECONCILIATION_GATE_ID,
  type ReconciliationReport,
} from "../gates/reconciliation.js"
import {
  createAuditReader,
  verifyFetchedRecords,
  type AuditReader,
} from "../oracle/audit-reader.js"
import {
  matchTrajectory,
  type ExpectedTrajectoryStep,
  type TrajectoryMode,
} from "../oracle/audit-trail-matcher.js"
import {
  createDomainReader,
  hashedAuditSessionId,
  projectionBarrierPrisma,
  type DomainReader,
} from "../oracle/domain-reader.js"
import { requireOracleDatabaseUrl } from "../oracle/oracle-database-url.js"
import {
  awaitProjection,
  ProjectionBarrierTimeoutError,
  type ProjectionBarrierPrisma,
} from "../oracle/projection-barrier.js"

// ── Contract pins ────────────────────────────────────────────────────────────

/** Per-attempt wall-clock budget (plan §7: "Per-attempt timeout 10 min"). */
export const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000

/** Audit-oracle settle budget: trajectory polling deadline per verify step. */
const AUDIT_SETTLE_TIMEOUT_MS = 30_000
const AUDIT_SETTLE_POLL_MS = 1_000

/** Projection-barrier budgets (tunable per-journey via verify args later). */
const ORDER_RESOLVE_TIMEOUT_MS = 30_000
const GOAL_STATE_TIMEOUT_MS = 20_000

/** Repo root anchored at this module (src/harness and dist/harness sit at the same depth). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")

// ── Report shapes (the --json contract) ──────────────────────────────────────

export interface TokenSplitReport {
  in: number
  out: number
}

export interface JourneyAttemptReport {
  attempt: number
  runId: string
  pass: boolean
  certifying: boolean
  /** Completed SUT chat turns (chat.turn.end outcome=pass) in this attempt. */
  turns: number
  costUsd: number
  driverCostUsd: number
  sutCostUsd: number
  driverTokens: TokenSplitReport
  sutTokens: TokenSplitReport
  durationMs: number
  tracePath: string
  costLine: string
  error?: string
  verify?: Array<{ invariant: string; ok: boolean; detail: string }>
  /** T1b-1 post-attempt gate: declared expects[] vs observed intent_audit. */
  reconciliation?: ReconciliationReport
}

export interface JourneyRunReport {
  journey: string
  k: number
  pass: boolean
  attempts: JourneyAttemptReport[]
  totalCostUsd: number
  costLine: string
}

export class JourneyRunCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JourneyRunCliError"
  }
}

export interface RunJourneyCliOptions {
  journeyId: string
  /** Sequential attempts; ALL must pass (default 1). */
  k?: number
  /** Journeys dir override (default packages/journeys/journeys/). */
  dir?: string
  /** .env.test path override (default <repo>/.env.test; shell env wins per key). */
  envFile?: string
  /** Runs dir override (default <repo>/runs). */
  runsDir?: string
  /** Progress sink for human output (act/turn/cost lines). */
  onProgress?: (line: string) => void
}

// ── Attempt composition ──────────────────────────────────────────────────────

interface AttemptDeps {
  journey: Journey
  attempt: number
  apiBaseUrl: string
  priceTable: PriceTable
  runsDir: string
  onProgress: (line: string) => void
}

function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Resolve `:name` segments in a declared http-act path from ctx.vars.
 * `:orderId` self-resolves to the run's own order (most-recent projection for
 * the run's customer, created at/after the attempt start) behind the
 * projection barrier — handles the async projector lag after a chat checkout.
 */
async function resolveHttpPath(
  path: string,
  ctx: JourneyRunContext,
  barrier: ProjectionBarrierPrisma,
  runStartedAt: Date,
): Promise<string> {
  const segments = path.split("/")
  const out: string[] = []
  for (const segment of segments) {
    if (!segment.startsWith(":")) {
      out.push(segment)
      continue
    }
    const name = segment.slice(1)
    let value = ctx.vars[name]
    if (value === undefined && name === "orderId") {
      const customerId = ctx.vars["customerId"]
      if (typeof customerId !== "string") {
        throw new JourneyRunCliError(
          "http act needs :orderId but ctx.vars.customerId is unset — declare the seedCustomer fixture act first",
        )
      }
      const settled = await awaitProjection({
        prisma: barrier,
        filter: { customerId, createdAt: { gte: runStartedAt } },
        predicate: (state) => state.projection !== null,
        timeoutMs: ORDER_RESOLVE_TIMEOUT_MS,
        pollMs: 250,
      })
      value = settled.projection?.id
      if (typeof value === "string") {
        ctx.vars["orderId"] = value
        emitEvidenceCapture({
          evidence: "orderId",
          detail: value,
          journey: ctx.journeyId,
          runId: ctx.runId,
        })
      }
    }
    if (typeof value !== "string" || value === "") {
      throw new JourneyRunCliError(
        `http act path ${path}: no ctx.vars value for ":${name}" — earlier acts must surface it`,
      )
    }
    out.push(encodeURIComponent(value))
  }
  return out.join("/")
}

/**
 * Resolve `:name` string values inside a declared http-act body from
 * ctx.vars (same convention as path segments). Non-string leaves and strings
 * not starting with `:` pass through verbatim.
 */
function resolveBodyVars(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string" && value.startsWith(":") && value.length > 1) {
    const name = value.slice(1)
    const resolved = vars[name]
    if (typeof resolved !== "string" || resolved === "") {
      throw new JourneyRunCliError(
        `http act body: no ctx.vars value for "${value}" — earlier acts must surface it`,
      )
    }
    return resolved
  }
  if (Array.isArray(value)) return value.map((item) => resolveBodyVars(item, vars))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveBodyVars(v, vars)]),
    )
  }
  return value
}

/** Extract a dot-path (e.g. `cart.id`) from a parsed JSON value. */
function extractPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function buildExecutors(args: {
  journey: Journey
  runId: string
  runStartedAt: Date
  apiBaseUrl: string
  certifying: boolean
  domain: DomainReader
  barrier: ProjectionBarrierPrisma
  chatSessionIds: Set<string>
  onProgress: (line: string) => void
}): ActExecutors {
  const {
    journey,
    runId,
    runStartedAt,
    apiBaseUrl,
    certifying,
    domain,
    barrier,
    chatSessionIds,
    onProgress,
  } = args

  // Lazy chat composition: the auth cookie needs ctx.vars.customerId, which
  // the journey's fixture act resolves first.
  let driver: PersonaDriver | undefined
  let chatClient: ChatClient | undefined

  function mintCustomerCookie(ctx: JourneyRunContext): string {
    const customerId = ctx.vars["customerId"]
    if (typeof customerId !== "string" || customerId === "") {
      throw new JourneyRunCliError(
        "authenticated act but ctx.vars.customerId is unset — declare the seedCustomer fixture act first",
      )
    }
    const jwtSecret = process.env["JWT_SECRET"]
    if (jwtSecret === undefined || jwtSecret === "") {
      throw new JourneyRunCliError("JWT_SECRET is missing from the env (.env.test)")
    }
    return cookieHeader(mintCustomerToken({ customerId, jwtSecret }))
  }

  const fixture = async (
    act: FixtureAct,
    ctx: JourneyRunContext,
  ): Promise<ActExecutionResult> => {
    if (act.seed === "seedCustomer") {
      const phone = (act.params?.["phone"] ?? ctx.params["customerPhone"]) as
        | string
        | undefined
      if (typeof phone !== "string" || phone === "") {
        return {
          ok: false,
          detail: "seedCustomer: no phone in act.params.phone or journey params.customerPhone",
        }
      }
      // Preconditions resolve via the SELECT-only oracle role — never write.
      // The customer is one of SEED_CUSTOMERS; `ibx test seed` (stack step
      // 4/4) creates the row.
      const customer = await domain.customerByPhone(phone)
      if (customer === null) {
        return {
          ok: false,
          detail: `seedCustomer: no customer with phone ${phone} — run \`ibx test seed\` (the fixture act only resolves seeded rows, it never writes)`,
        }
      }
      ctx.vars["customerId"] = customer.id
      emitEvidenceCapture({
        evidence: "customerId",
        detail: customer.id,
        journey: journey.id,
        runId,
      })
      return { ok: true, detail: `resolved seeded customer ${phone} -> ${customer.id}` }
    }
    if (act.seed === "resolveProductVariant") {
      // Precondition resolve (read-only): catalog handle (+ optional variant
      // title) → variant id, surfaced as ctx.vars.variantId. Journeys never
      // carry raw Medusa ids — this is how an http act gets one at run time.
      const handle = (act.params?.["handle"] ?? ctx.params["productHandle"]) as
        | string
        | undefined
      const variantTitle = act.params?.["variantTitle"] as string | undefined
      if (typeof handle !== "string" || handle === "") {
        return {
          ok: false,
          detail:
            "resolveProductVariant: no handle in act.params.handle or journey params.productHandle",
        }
      }
      const variant = await domain.variantByHandle(handle, variantTitle)
      if (variant === null) {
        return {
          ok: false,
          detail: `resolveProductVariant: no variant for handle "${handle}"${variantTitle !== undefined ? ` title "${variantTitle}"` : ""} — is the catalog seeded?`,
        }
      }
      ctx.vars["variantId"] = variant.id
      emitEvidenceCapture({
        evidence: "variantId",
        detail: variant.id,
        journey: journey.id,
        runId,
      })
      return {
        ok: true,
        detail: `resolved ${handle}${variantTitle !== undefined ? ` (${variantTitle})` : ""} -> ${variant.id}`,
      }
    }
    return {
      ok: false,
      detail: `unknown fixture seed "${act.seed}" (known: seedCustomer, resolveProductVariant)`,
    }
  }

  const chat = async (act: ChatAct, ctx: JourneyRunContext): Promise<ActExecutionResult> => {
    if (driver === undefined) {
      const cookie =
        ctx.params["authenticated"] === true ? mintCustomerCookie(ctx) : undefined
      chatClient = new ChatClient({
        baseUrl: apiBaseUrl,
        ...(cookie !== undefined ? { cookie } : {}),
        turnTimeoutMs: 150_000,
        journeyId: journey.id,
        runId,
      })
      chatSessionIds.add(chatClient.sessionId)
      onProgress(`  chat session ${chatClient.sessionId}`)
      driver = new PersonaDriver({
        journey,
        runId,
        provider: createAnthropicModelProvider(),
        chatTurn: async (message) => {
          const turn = await chatClient!.perTurn(message)
          onProgress(
            `  turn ${turn.turn}: persona ${truncate(message, 80)} -> reply ${turn.replyText.length} chars (${turn.timings.totalMs}ms)`,
          )
          return { replyText: turn.replyText }
        },
        // NO http executor — see the module header (http acts never run
        // through the persona model; they are standalone runner acts).
        certifying,
      })
    }
    return createDriverChatExecutor(driver)(act, ctx) as Promise<ActExecutionResult>
  }

  const http = async (act: HttpAct, ctx: JourneyRunContext): Promise<ActExecutionResult> => {
    const asRole = act.asRole ?? "anonymous"
    if (asRole === "staff") {
      return {
        ok: false,
        detail: "staff http acts are not wired in the T1a-13 harness (customer/anonymous only)",
      }
    }
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (asRole === "customer") headers["cookie"] = mintCustomerCookie(ctx)

    const path = await resolveHttpPath(act.path, ctx, barrier, runStartedAt)
    const body = act.body !== undefined ? resolveBodyVars(act.body, ctx.vars) : undefined
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: act.method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let bodyText = ""
    try {
      bodyText = await response.text()
    } catch {
      /* body read best-effort */
    }
    const ok = response.status >= 200 && response.status < 300

    // Declared response captures: varName → dot-path into the JSON response.
    if (ok && act.capture !== undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(bodyText)
      } catch {
        return {
          ok: false,
          detail: `${act.method} ${path} -> ${response.status} but the response is not JSON (capture declared)`,
        }
      }
      for (const [varName, dotPath] of Object.entries(act.capture)) {
        const value = extractPath(parsed, dotPath)
        if (typeof value !== "string" && typeof value !== "number") {
          return {
            ok: false,
            detail: `${act.method} ${path}: capture "${varName}" found no string/number at "${dotPath}"`,
          }
        }
        ctx.vars[varName] = String(value)
        emitEvidenceCapture({
          evidence: varName,
          detail: String(value),
          journey: journey.id,
          runId,
        })
      }
    }

    onProgress(`  http ${act.method} ${path} -> ${response.status}`)
    return {
      ok,
      detail: `${act.method} ${path} -> ${response.status}${ok ? "" : ` ${truncate(bodyText)}`}`,
    }
  }

  return { chat, http, fixture }
}

// ── Verify phase (the harness re-executes verify[] with YAML-bound args) ─────

interface VerifyOutcome {
  invariant: string
  ok: boolean
  detail: string
}

const TRAJECTORY_MODES: Record<string, TrajectoryMode> = {
  "audit.trajectory.exact": "EXACT",
  "audit.trajectory.in_order": "IN_ORDER",
  "audit.trajectory.any_order": "ANY_ORDER",
}

async function runVerifyPhase(args: {
  journey: Journey
  ctx: { vars: Record<string, unknown> }
  audit: AuditReader
  domain: DomainReader
  barrier: ProjectionBarrierPrisma
  scopeSessionIds: string[]
  runStartedAt: Date
  onProgress: (line: string) => void
}): Promise<VerifyOutcome[]> {
  const { journey, ctx, audit, domain, barrier, scopeSessionIds, runStartedAt, onProgress } =
    args
  const outcomes: VerifyOutcome[] = []
  const scope = { sessionIds: scopeSessionIds }
  // Time-scope every fetch to the attempt window: the seeded customer is
  // shared across attempts, so the hashed(customerId) namespace accumulates
  // rows from earlier runs — `since` cuts them out of the trajectory.
  const fetchOpts = { since: runStartedAt }
  // `optional: true` entries are reconciliation ALLOWANCES (T1b-1), never
  // trajectory requirements — only required expects become expected steps.
  const expected: ExpectedTrajectoryStep[] = journey.expects
    .filter((e) => e.optional !== true)
    .map((e) => ({
      intentKind: e.intentKind,
      decision: e.decision,
    }))

  async function resolveRunOrderId(): Promise<string> {
    const fromVars = ctx.vars["orderId"]
    if (typeof fromVars === "string" && fromVars !== "") return fromVars
    const customerId = ctx.vars["customerId"]
    if (typeof customerId !== "string") {
      throw new JourneyRunCliError(
        "order.goal-state needs the run's order but ctx.vars.customerId is unset",
      )
    }
    const settled = await awaitProjection({
      prisma: barrier,
      filter: { customerId, createdAt: { gte: runStartedAt } },
      predicate: (state) => state.projection !== null,
      timeoutMs: ORDER_RESOLVE_TIMEOUT_MS,
      pollMs: 250,
    })
    const id = settled.projection?.id
    if (typeof id !== "string") {
      throw new JourneyRunCliError("order.goal-state: run order projection never appeared")
    }
    ctx.vars["orderId"] = id
    return id
  }

  for (const verify of journey.verify) {
    const id = verify.invariant
    try {
      if (id in TRAJECTORY_MODES) {
        // Audit-settle barrier: rows land in-turn, but poll up to the deadline
        // so projector/sink lag can never flake the trajectory assert.
        const mode = TRAJECTORY_MODES[id]!
        const deadline = Date.now() + AUDIT_SETTLE_TIMEOUT_MS
        let last = matchTrajectory(await audit.fetchRecords(scope, fetchOpts), expected, { mode })
        while (!last.ok && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, AUDIT_SETTLE_POLL_MS))
          last = matchTrajectory(await audit.fetchRecords(scope, fetchOpts), expected, { mode })
        }
        outcomes.push({
          invariant: id,
          ok: last.ok,
          detail: last.ok
            ? `matched ${expected.length} step(s) over ${last.observed.length} observed record(s)`
            : last.diff,
        })
      } else if (id === "audit.record.verified") {
        const records = await audit.fetchRecords(scope, fetchOpts)
        const report = verifyFetchedRecords(records)
        outcomes.push({
          invariant: id,
          ok: report.ok,
          detail: report.ok
            ? `${report.verifiedCount + report.redactedVerifiedCount}/${report.total} record(s) verified tamper-evident (${report.redactedVerifiedCount} redaction-aware)`
            : `${report.failures.length} failure(s): ${report.failures
                .map((f) => `${f.intentKind}@${f.at} ${f.reason}`)
                .join("; ")}`,
        })
      } else if (id === "audit.kind-absent") {
        const kind = verify.args?.["intentKind"]
        if (typeof kind !== "string") {
          outcomes.push({ invariant: id, ok: false, detail: "args.intentKind missing" })
          continue
        }
        const records = await audit.fetchRecords(scope, { ...fetchOpts, intentKind: kind })
        outcomes.push({
          invariant: id,
          ok: records.length === 0,
          detail:
            records.length === 0
              ? `no ${kind} envelope in the run namespace`
              : `${records.length} forbidden ${kind} record(s) present`,
        })
      } else if (id === "order.goal-state") {
        const status = verify.args?.["status"]
        if (typeof status !== "string") {
          outcomes.push({ invariant: id, ok: false, detail: "args.status missing" })
          continue
        }
        const orderId = await resolveRunOrderId()
        const settled = await awaitProjection({
          prisma: barrier,
          orderId,
          predicate: (state) =>
            (state.projection?.["fulfillmentStatus"] as string | undefined) === status,
          timeoutMs: GOAL_STATE_TIMEOUT_MS,
          pollMs: 250,
        })
        const row = await domain.orderById(orderId)
        outcomes.push({
          invariant: id,
          ok: true,
          detail:
            `order ${orderId} reached fulfillmentStatus=${status} ` +
            `(version=${row?.version ?? "?"}, barrier ${settled.elapsedMs}ms/${settled.polls} polls)`,
        })
      } else {
        // Registered ids without a T1a-13 binding fail LOUDLY — an invariant
        // must never pass vacuously (reservation/cart goal-state +
        // audit.refusal-basis land with the journeys that need them).
        outcomes.push({
          invariant: id,
          ok: false,
          detail: `invariant "${id}" has no harness binding yet (T1a-13 implements what JOURNEY-001 needs)`,
        })
      }
    } catch (err) {
      const detail =
        err instanceof ProjectionBarrierTimeoutError ? err.message : (err as Error).message
      outcomes.push({ invariant: id, ok: false, detail })
    }
    const last = outcomes.at(-1)!
    onProgress(`  verify ${last.ok ? "PASS" : "FAIL"} ${last.invariant}: ${truncate(last.detail, 200)}`)
  }
  return outcomes
}

// ── One attempt ──────────────────────────────────────────────────────────────

async function runAttempt(deps: AttemptDeps): Promise<JourneyAttemptReport> {
  const { journey, attempt, apiBaseUrl, priceTable, runsDir, onProgress } = deps
  const runId = randomUUID()
  const startedAtMs = Date.now()
  // 2s clock slack: the projection rows are stamped by the DB clock.
  const runStartedAt = new Date(startedAtMs - 2_000)
  const tracePath = join(runsDir, runId, "trace.jsonl")

  const events: IbxEventBase[] = []
  const unsubscribe = onEvent((event) => {
    events.push(event)
  })

  const chatSessionIds = new Set<string>()
  /** ctx.vars threaded through acts AND into the verify phase. */
  const vars: Record<string, unknown> = {}
  let pool: pg.Pool | undefined
  let pass = false
  let certifying = false
  let error: string | undefined
  let verifyOutcomes: VerifyOutcome[] | undefined
  let reconciliation: ReconciliationReport | undefined

  try {
    // Mandatory preflight — run ONCE here (the trace records every check);
    // the runner re-uses the memoized result as its first step.
    const preflightResult: PreflightResult = await runPreflight({
      journeyId: journey.id,
      runId,
    })
    certifying = preflightResult.certifying

    pool = new pg.Pool({
      connectionString: requireOracleDatabaseUrl(process.env),
      max: 4,
    })
    const domain = createDomainReader({ pool })
    const audit = createAuditReader({ pool })
    const barrier = projectionBarrierPrisma(pool)

    const executors = buildExecutors({
      journey,
      runId,
      runStartedAt,
      apiBaseUrl,
      certifying,
      domain,
      barrier,
      chatSessionIds,
      onProgress,
    })

    const result = await runJourney(journey, executors, {
      runId,
      vars,
      preflight: async () => preflightResult,
    })

    if (!result.ok) {
      error = result.error ?? "act_failed"
    } else {
      // ── Verify[] re-execution — scoped to the run's HASHED session ids ──
      // (audit-redactor hashes every actor.sessionId; chat acts land under
      // hashed(chat sessionId), customer http acts under hashed(customerId)).
      const redactSecret = process.env["AUDIT_REDACT_SECRET"] ?? ""
      const scopeSessionIds = [
        ...[...chatSessionIds].map((s) => hashedAuditSessionId(s, redactSecret)),
        ...(typeof vars["customerId"] === "string"
          ? [hashedAuditSessionId(vars["customerId"] as string, redactSecret)]
          : []),
      ]
      verifyOutcomes = await runVerifyPhase({
        journey,
        ctx: { vars },
        audit,
        domain,
        barrier,
        scopeSessionIds,
        runStartedAt,
        onProgress,
      })

      // ── T1b-1 reconciliation gate (post-attempt, mandatory) ─────────────
      // Every observed envelope in the run's namespaces must be explained by
      // an expects[] entry (required or optional allowance) — unexplained
      // envelopes are drift and fail the attempt; verify[] goal-state asserts
      // must trace to audited EXECUTE/REWRITE decisions (no fixture-forged
      // assertions). Rows settled during the verify phase's audit barrier;
      // one fresh fetch reconciles the final trail. An empty scope (no chat
      // sessions, no customer) reconciles over [] — with state-asserting
      // verify[] entries that is itself the forged-assertion failure.
      try {
        const reconciliationRecords =
          scopeSessionIds.length > 0
            ? await audit.fetchRecords({ sessionIds: scopeSessionIds }, { since: runStartedAt })
            : []
        reconciliation = reconcileExpects({
          journeyId: journey.id,
          expects: journey.expects,
          verify: journey.verify,
          records: reconciliationRecords,
        })
        verifyOutcomes.push({
          invariant: RECONCILIATION_GATE_ID,
          ok: reconciliation.ok,
          detail: reconciliation.ok
            ? `${reconciliation.observed.length} observed envelope(s) all explained ` +
              `(${reconciliation.observed.filter((o) => o.explanation === "optional").length} by optional allowances` +
              `${reconciliation.supersededCount > 0 ? `, ${reconciliation.supersededCount} superseded intermediate(s) dropped` : ""})`
            : reconciliation.report,
        })
      } catch (err) {
        verifyOutcomes.push({
          invariant: RECONCILIATION_GATE_ID,
          ok: false,
          detail: `reconciliation fetch failed: ${(err as Error).message}`,
        })
      }
      const gateOutcome = verifyOutcomes.at(-1)!
      onProgress(
        `  verify ${gateOutcome.ok ? "PASS" : "FAIL"} ${gateOutcome.invariant}: ${truncate(gateOutcome.detail, 200)}`,
      )

      pass = verifyOutcomes.every((o) => o.ok)
      if (!pass) {
        error = verifyOutcomes
          .filter((o) => !o.ok)
          .map((o) => `${o.invariant}: ${o.detail}`)
          .join(" | ")
      }
    }
  } catch (err) {
    error = `${(err as Error).name}: ${(err as Error).message}`
  } finally {
    unsubscribe()
    await pool?.end().catch(() => undefined)
  }

  // ── Cost report (driver in-process; SUT from IBX_EVENTS_FILE) ──────────────
  const driverCalls = events.filter(
    (e): e is IbxEventBase & LlmCallLike =>
      e.type === "llm.call" && e.runId === runId && e.source !== "sut",
  )
  const eventsFile = process.env["IBX_EVENTS_FILE"]
  const sutCalls =
    eventsFile !== undefined && eventsFile !== ""
      ? (readSutLlmCalls(eventsFile, chatSessionIds) as Array<IbxEventBase & LlmCallLike>)
      : []
  let cost: AttemptCost
  try {
    cost = attemptCost(priceTable, driverCalls, sutCalls)
  } catch (err) {
    // A pricing failure is a RED attempt — never a silent $0 line.
    cost = {
      driver: { calls: driverCalls.length, tokens: { in: 0, out: 0 }, costUsd: 0 },
      sut: { calls: sutCalls.length, tokens: { in: 0, out: 0 }, costUsd: 0 },
      totalUsd: 0,
    }
    pass = false
    error = `${error !== undefined ? `${error} | ` : ""}cost: ${(err as Error).message}`
  }

  const turns = events.filter(
    (e) => e.type === "chat.turn.end" && e.runId === runId && e.outcome === "pass",
  ).length
  const durationMs = Date.now() - startedAtMs

  // ── Trace file: every in-process event + the run's SUT llm.call events ─────
  try {
    mkdirSync(dirname(tracePath), { recursive: true })
    const lines = [
      ...events.map((e) => JSON.stringify(e)),
      ...sutCalls.map((e) => JSON.stringify(e)),
      ...(verifyOutcomes ?? []).map((o) =>
        JSON.stringify({
          type: "verify.outcome",
          timestamp: new Date().toISOString(),
          journey: journey.id,
          runId,
          invariant: o.invariant,
          outcome: o.ok ? "pass" : "fail",
          detail: o.detail,
        }),
      ),
    ]
    writeFileSync(tracePath, `${lines.join("\n")}\n`)
  } catch {
    onProgress(`  warning: trace write failed (${tracePath})`)
  }

  const costLine = renderCostLine(`attempt ${attempt}`, cost)
  return {
    attempt,
    runId,
    pass,
    certifying,
    turns,
    costUsd: cost.totalUsd,
    driverCostUsd: cost.driver.costUsd,
    sutCostUsd: cost.sut.costUsd,
    driverTokens: cost.driver.tokens,
    sutTokens: cost.sut.tokens,
    durationMs,
    tracePath,
    costLine,
    ...(error !== undefined ? { error } : {}),
    ...(verifyOutcomes !== undefined ? { verify: verifyOutcomes } : {}),
    ...(reconciliation !== undefined ? { reconciliation } : {}),
  }
}

/** Wrap an attempt in the 10-minute wall-clock budget — abort red, never hang. */
async function runAttemptWithTimeout(deps: AttemptDeps): Promise<JourneyAttemptReport> {
  const attemptPromise = runAttempt(deps)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<JourneyAttemptReport>((resolveTimeout) => {
    timer = setTimeout(() => {
      emitJourneyAborted({
        journey: deps.journey.id,
        runId: "attempt-timeout",
        reason: "attempt_timeout",
        detail: `attempt ${deps.attempt} exceeded ${ATTEMPT_TIMEOUT_MS}ms`,
      })
      resolveTimeout({
        attempt: deps.attempt,
        runId: "attempt-timeout",
        pass: false,
        certifying: false,
        turns: 0,
        costUsd: 0,
        driverCostUsd: 0,
        sutCostUsd: 0,
        driverTokens: { in: 0, out: 0 },
        sutTokens: { in: 0, out: 0 },
        durationMs: ATTEMPT_TIMEOUT_MS,
        tracePath: "",
        costLine: `cost[attempt ${deps.attempt}]: aborted (attempt_timeout)`,
        error: `attempt_timeout: exceeded ${ATTEMPT_TIMEOUT_MS}ms`,
      })
    }, ATTEMPT_TIMEOUT_MS)
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    const winner = await Promise.race([attemptPromise, timeoutPromise])
    // Detach the loser so a late rejection never surfaces as unhandled.
    attemptPromise.catch(() => undefined)
    return winner
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ── Entry point (`ibx journey run` calls this) ───────────────────────────────

export async function runJourneyCli(options: RunJourneyCliOptions): Promise<JourneyRunReport> {
  const k = options.k ?? 1
  if (!Number.isInteger(k) || k < 1) {
    throw new JourneyRunCliError(`--k must be a positive integer (got ${String(options.k)})`)
  }
  const onProgress = options.onProgress ?? (() => undefined)

  // Env contract: .env.test is AUTHORITATIVE for the run (override semantics
  // — the ibx CLI preloads the dev .env via dotenv, which must never leak
  // into the test plane; see test-env.ts). Missing file is tolerated — the
  // preflight refuses with a named error if the contract is incomplete.
  const envFile = options.envFile ?? join(REPO_ROOT, ".env.test")
  try {
    const loaded = loadTestEnv(envFile)
    onProgress(
      `env: ${envFile} (${loaded.injected.length} injected, ${loaded.overridden.length} overridden, ${loaded.identical.length} identical)`,
    )
  } catch {
    onProgress(`env: ${envFile} not readable — relying on the shell environment`)
  }

  const journeys = await loadJourneys(options.dir)
  const journey = journeys.find((j) => j.id === options.journeyId)
  if (journey === undefined) {
    throw new JourneyRunCliError(
      `journey "${options.journeyId}" not found in the registry (${journeys.length} journeys loaded)`,
    )
  }

  const priceTable = loadPriceTable()
  const apiBaseUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001"
  const runsDir = options.runsDir ?? join(REPO_ROOT, "runs")

  const attempts: JourneyAttemptReport[] = []
  for (let attempt = 1; attempt <= k; attempt++) {
    onProgress(`${journey.id} attempt ${attempt}/${k} starting`)
    const report = await runAttemptWithTimeout({
      journey,
      attempt,
      apiBaseUrl,
      priceTable,
      runsDir,
      onProgress,
    })
    attempts.push(report)
    onProgress(
      `${journey.id} attempt ${attempt}/${k}: ${report.pass ? "PASS" : "FAIL"} ` +
        `(turns=${report.turns}, ${(report.durationMs / 1000).toFixed(1)}s` +
        `${report.certifying ? ", certifying" : ", NON-certifying"})` +
        `${report.error !== undefined ? ` — ${truncate(report.error, 300)}` : ""}`,
    )
    onProgress(report.costLine)
  }

  const totalCostUsd = attempts.reduce((sum, a) => sum + a.costUsd, 0)
  const totalDriver = attempts.reduce((s, a) => s + a.driverCostUsd, 0)
  const totalSut = attempts.reduce((s, a) => s + a.sutCostUsd, 0)
  const costLine =
    `cost[total]: ${formatUsd(totalCostUsd)} across ${attempts.length} attempt(s) ` +
    `(driver ${formatUsd(totalDriver)}; sut ${formatUsd(totalSut)})`

  return {
    journey: journey.id,
    k,
    pass: attempts.length === k && attempts.every((a) => a.pass),
    attempts,
    totalCostUsd,
    costLine,
  }
}
