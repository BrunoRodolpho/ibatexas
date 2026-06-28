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
// Suite/k-loop budget (T1b-8): cumulative measured cost is charged into a
// DollarBudget after each attempt; spend ≥ cap aborts everything left as
// `aborted-by-budget` (RED, reported — see budget.ts + run-suite-cli.ts).

import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import {
  closeRedisClient,
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
import {
  acquireJourneyLock,
  JourneyLockTimeoutError,
  type JourneyLockHandle,
} from "../runner/journey-lock.js"
import { runPreflight, type PreflightResult } from "./preflight.js"
import { loadTestEnv } from "./test-env.js"
import {
  ABORTED_BY_BUDGET,
  createDollarBudget,
  NIGHTLY_BUDGET_ENV,
  renderBudgetLine,
  resolveBudgetCapUsd,
  type BudgetReport,
  type DollarBudget,
  type RunCompletionStatus,
} from "./budget.js"
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
import {
  cookieHeader,
  mintCustomerToken,
  mintStaffToken,
  STAFF_ROLES,
  type StaffRole,
} from "../clients/auth-fixture.js"
import { awaitPaidState, firePaidStateWebhook } from "../clients/paid-state-fixture.js"
import {
  PersonaDriver,
  createDriverChatExecutor,
} from "../driver/persona-driver.js"
import { createAnthropicModelProvider } from "../driver/anthropic-provider.js"
import { createOllamaModelProvider } from "../driver/ollama-provider.js"
import {
  reconcileExpects,
  RECONCILIATION_GATE_ID,
  type ReconciliationReport,
} from "../gates/reconciliation.js"
import { createSimStore } from "./sim-store.js"
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
  /**
   * T1b-8: "completed" = the attempt actually ran (pass or fail);
   * "aborted-by-budget" = the suite dollar cap was reached before this
   * attempt started — it never ran and is reported, never silently dropped.
   */
  status: RunCompletionStatus
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
  /** T1b-8: "aborted-by-budget" when ANY attempt was budget-truncated. */
  status: RunCompletionStatus
  attempts: JourneyAttemptReport[]
  totalCostUsd: number
  costLine: string
  /** T1b-8: the dollar cap + cumulative spend at report time. */
  budget: BudgetReport
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
  /**
   * T1b-8 dollar cap (`--budget-usd`): overrides `IBX_NIGHTLY_BUDGET_USD`
   * (default $50). Ignored when `budget` is supplied.
   */
  budgetUsd?: number
  /**
   * T1b-8 shared accumulator: the SUITE runner passes one `DollarBudget`
   * instance spanning every journey, so cumulative spend aborts mid-suite
   * AND mid-k-loop. Single-journey runs build their own from `budgetUsd`.
   */
  budget?: DollarBudget
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
 *
 * T1b-0: `excludeOrderId` (the customer's latest order id BEFORE this
 * attempt, captured at seedCustomer-resolve time) hardens the fallback
 * against the back-to-back-attempt race: the runStartedAt window carries a
 * 2s clock slack, so attempt N's filter can match attempt N-1's just-created
 * order while attempt N's own projection is still in projector flight — the
 * barrier would return the STALE most-recent instead of waiting (live k=2
 * JOURNEY-005 failure: "Pedido já é deste tipo." on attempt 1's order).
 * Excluding the pre-attempt latest makes the barrier poll until the run's
 * OWN order is the most recent.
 */
async function resolveHttpPath(
  path: string,
  ctx: JourneyRunContext,
  barrier: ProjectionBarrierPrisma,
  runStartedAt: Date,
  excludeOrderId: () => string | null,
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
      const stale = excludeOrderId()
      const settled = await awaitProjection({
        prisma: barrier,
        filter: { customerId, createdAt: { gte: runStartedAt } },
        predicate: (state) =>
          state.projection !== null && state.projection.id !== stale,
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

/**
 * Apply a declared http-act's response captures (varName → dot-path) into
 * ctx.vars, emitting evidence per capture. Returns a failure
 * `ActExecutionResult` to short-circuit the http executor, or `null` when
 * there is nothing to capture / every capture resolved.
 */
function applyHttpCaptures(args: {
  ok: boolean
  act: HttpAct
  ctx: JourneyRunContext
  bodyText: string
  responseStatus: number
  path: string
  journeyId: string
  runId: string
}): ActExecutionResult | null {
  const { ok, act, ctx, bodyText, responseStatus, path, journeyId, runId } = args
  if (!ok || act.capture === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return {
      ok: false,
      detail: `${act.method} ${path} -> ${responseStatus} but the response is not JSON (capture declared)`,
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
      journey: journeyId,
      runId,
    })
  }
  return null
}

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

// T2-2a: staff acts mint the `staff_token` cookie for the SEEDED ACTIVE
// staff row the seedStaff fixture resolved (the API re-checks the row per
// request — middleware/auth.ts; the authFixture replicates issueStaffJwtToken
// exactly, fingerprint-gated).
function mintStaffCookie(ctx: JourneyRunContext): string {
  const staffId = ctx.vars["staffId"]
  const staffRole = ctx.vars["staffRole"]
  if (typeof staffId !== "string" || staffId === "" || typeof staffRole !== "string") {
    throw new JourneyRunCliError(
      "staff http act but ctx.vars.staffId/staffRole are unset — declare the seedStaff fixture act first",
    )
  }
  if (!STAFF_ROLES.includes(staffRole as StaffRole)) {
    throw new JourneyRunCliError(
      `staff http act: ctx.vars.staffRole "${staffRole}" is not one of ${STAFF_ROLES.join("|")}`,
    )
  }
  const staffJwtSecret = process.env["STAFF_JWT_SECRET"]
  if (staffJwtSecret === undefined || staffJwtSecret === "") {
    throw new JourneyRunCliError("STAFF_JWT_SECRET is missing from the env (.env.test)")
  }
  return cookieHeader(
    mintStaffToken({ staffId, role: staffRole as StaffRole, staffJwtSecret }),
  )
}

/**
 * Shared deps threaded into each fixture seed handler. `orderIdState.value` is
 * the customer's pre-attempt latest order id (T1b-0) — written by seedCustomer
 * and read by the :orderId barriers; a mutable holder so the module-local
 * handlers share the single attempt-scoped slot the executor closure owns.
 */
interface FixtureContext {
  domain: DomainReader
  barrier: ProjectionBarrierPrisma
  journey: Journey
  runId: string
  apiBaseUrl: string
  runStartedAt: Date
  orderIdState: { value: string | null }
}

async function fixtureSeedCustomer(
  act: FixtureAct,
  ctx: JourneyRunContext,
  fctx: FixtureContext,
): Promise<ActExecutionResult> {
  const { domain, journey, runId, orderIdState } = fctx
  // T2-2a: `phonePool` — an ordered list of seeded phones; the fixture
  // resolves the FIRST phone that still exists. Built for the LGPD
  // erasure journey: an anonymized customer's phone becomes the
  // `anonymized:` sentinel (customerByPhone → null), so each attempt
  // rotates to the next un-erased pool entry. Resolve-only as ever —
  // pool exhaustion fails loudly (the per-stack attempt budget IS the
  // pool size; a fresh `ibx test seed` stack resets it).
  const pool = act.params?.["phonePool"]
  const candidates: string[] = Array.isArray(pool)
    ? pool.filter((p): p is string => typeof p === "string" && p !== "")
    : []
  const phone = (act.params?.["phone"] ?? ctx.params["customerPhone"]) as
    | string
    | undefined
  if (candidates.length === 0) {
    if (typeof phone !== "string" || phone === "") {
      return {
        ok: false,
        detail:
          "seedCustomer: no phone in act.params.phone/phonePool or journey params.customerPhone",
      }
    }
    candidates.push(phone)
  }
  // Preconditions resolve via the SELECT-only oracle role — never write.
  // The customer is one of SEED_CUSTOMERS; `ibx test seed` (stack step
  // 4/4) creates the row.
  let customer: Awaited<ReturnType<typeof domain.customerByPhone>> = null
  let resolvedPhone: string | undefined
  for (const candidate of candidates) {
    customer = await domain.customerByPhone(candidate)
    if (customer !== null) {
      resolvedPhone = candidate
      break
    }
  }
  if (customer === null || resolvedPhone === undefined) {
    return {
      ok: false,
      detail:
        candidates.length > 1
          ? `seedCustomer: no resolvable customer left in phonePool [${candidates.join(", ")}] — every pool entry is missing or already anonymized; bring up a freshly seeded stack (the pool size is the per-stack attempt budget)`
          : `seedCustomer: no customer with phone ${candidates[0]} — run \`ibx test seed\` (the fixture act only resolves seeded rows, it never writes)`,
    }
  }
  ctx.vars["customerId"] = customer.id
  // Pre-attempt latest order (may be a previous attempt's, created inside
  // this attempt's 2s-slack window) — the :orderId barrier excludes it.
  orderIdState.value = (await domain.latestOrderForCustomer(customer.id))?.id ?? null
  emitEvidenceCapture({
    evidence: "customerId",
    detail: customer.id,
    journey: journey.id,
    runId,
  })
  return {
    ok: true,
    detail: `resolved seeded customer ${resolvedPhone} -> ${customer.id}`,
  }
}

async function fixtureResolveProductVariant(
  act: FixtureAct,
  ctx: JourneyRunContext,
  fctx: FixtureContext,
): Promise<ActExecutionResult> {
  const { domain, journey, runId } = fctx
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
    const titleNote = variantTitle === undefined ? "" : ` title "${variantTitle}"`
    return {
      ok: false,
      detail: `resolveProductVariant: no variant for handle "${handle}"${titleNote} — is the catalog seeded?`,
    }
  }
  ctx.vars["variantId"] = variant.id
  emitEvidenceCapture({
    evidence: "variantId",
    detail: variant.id,
    journey: journey.id,
    runId,
  })
  const titleSuffix = variantTitle === undefined ? "" : ` (${variantTitle})`
  return {
    ok: true,
    detail: `resolved ${handle}${titleSuffix} -> ${variant.id}`,
  }
}

async function fixtureSeedStaff(
  act: FixtureAct,
  ctx: JourneyRunContext,
  fctx: FixtureContext,
): Promise<ActExecutionResult> {
  const { domain, journey, runId } = fctx
  // T2-2a: resolve a SEEDED ACTIVE staff row (read-only — seed-tables.ts
  // upserts SEED_STAFF in the seed-domain step; this fixture never
  // writes). Staff auth re-checks the active row per request
  // (middleware/auth.ts), so a minted-but-unseeded staff token is
  // rejected regardless of signature validity. Surfaces
  // ctx.vars.staffId/staffRole for the staff http executor AND adds the
  // hashed(`admin:<staffId>`) audit namespace to the run scope (the
  // admin reservation routes stamp actor.sessionId = `admin:${staffId}`).
  const phone = (act.params?.["phone"] ?? ctx.params["staffPhone"]) as
    | string
    | undefined
  const role = (act.params?.["role"] ?? ctx.params["staffRole"] ?? "MANAGER") as string
  if (typeof phone !== "string" || phone === "") {
    return {
      ok: false,
      detail: "seedStaff: no phone in act.params.phone or journey params.staffPhone",
    }
  }
  if (!STAFF_ROLES.includes(role as StaffRole)) {
    return {
      ok: false,
      detail: `seedStaff: role must be one of ${STAFF_ROLES.join("|")} (got "${role}")`,
    }
  }
  const staff = await domain.staffByPhone(phone)
  if (staff === null) {
    return {
      ok: false,
      detail: `seedStaff: no staff with phone ${phone} — run \`ibx test seed\` (seed-domain upserts SEED_STAFF; the fixture only resolves seeded rows, it never writes)`,
    }
  }
  if (!staff.active) {
    return {
      ok: false,
      detail: `seedStaff: staff ${staff.id} is INACTIVE — the API re-checks the active row on every request`,
    }
  }
  if (staff.role !== role) {
    return {
      ok: false,
      detail: `seedStaff: seeded row role is ${staff.role}, journey asked for ${role} — honest journeys mint the seeded role`,
    }
  }
  ctx.vars["staffId"] = staff.id
  ctx.vars["staffRole"] = staff.role
  emitEvidenceCapture({
    evidence: "staffId",
    detail: staff.id,
    journey: journey.id,
    runId,
  })
  return { ok: true, detail: `resolved seeded staff ${phone} -> ${staff.id} (${staff.role})` }
}

async function fixtureResolveTimeSlot(
  act: FixtureAct,
  ctx: JourneyRunContext,
  fctx: FixtureContext,
): Promise<ActExecutionResult> {
  const { domain, journey, runId } = fctx
  // T2-2a: read-only resolve of the earliest seeded FUTURE time slot
  // (date >= tomorrow — keeps requireSlotInFuture trivially satisfied)
  // with capacity for the party. Surfaced as ctx.vars.timeSlotId so the
  // journey file never carries a raw slot id and never computes dates.
  const partySizeRaw = act.params?.["partySize"] ?? ctx.params["partySize"]
  const partySize =
    typeof partySizeRaw === "number" && Number.isInteger(partySizeRaw) && partySizeRaw > 0
      ? partySizeRaw
      : 2
  const slot = await domain.futureTimeSlot(partySize)
  if (slot === null) {
    return {
      ok: false,
      detail: `resolveTimeSlot: no future time slot with >= ${partySize} free covers — run \`ibx test seed\` (seed-domain seeds 30 days of slots)`,
    }
  }
  ctx.vars["timeSlotId"] = slot.id
  emitEvidenceCapture({
    evidence: "timeSlotId",
    detail: slot.id,
    journey: journey.id,
    runId,
  })
  return {
    ok: true,
    detail: `resolved future slot ${slot.id} (${slot.date.toISOString().split("T")[0]} ${slot.startTime}, ${slot.maxCovers - slot.reservedCovers} covers free)`,
  }
}

async function fixtureResolveHistoricalOrderItem(
  act: FixtureAct,
  ctx: JourneyRunContext,
  fctx: FixtureContext,
): Promise<ActExecutionResult> {
  const { domain, journey, runId } = fctx
  // T2-2a: read-only resolve of the customer's SEEDED order history
  // (customer_order_items — `ibx test seed`'s seed-orders step) for a
  // pinned catalog handle. Proves the reorder journey's history
  // precondition AND surfaces the HISTORICAL variantId — the re-order
  // assembles exactly what the customer bought before.
  const handle = (act.params?.["handle"] ?? ctx.params["productHandle"]) as
    | string
    | undefined
  const customerId = ctx.vars["customerId"]
  if (typeof customerId !== "string" || customerId === "") {
    return {
      ok: false,
      detail:
        "resolveHistoricalOrderItem: ctx.vars.customerId unset — declare the seedCustomer fixture act first",
    }
  }
  if (typeof handle !== "string" || handle === "") {
    return {
      ok: false,
      detail:
        "resolveHistoricalOrderItem: no handle in act.params.handle or journey params.productHandle",
    }
  }
  const item = await domain.historicalOrderItemByHandle(customerId, handle)
  if (item === null) {
    return {
      ok: false,
      detail: `resolveHistoricalOrderItem: no seeded order-history row for handle "${handle}" — run \`ibx test seed\` (seed-orders creates the history; the fixture only resolves)`,
    }
  }
  ctx.vars["variantId"] = item.variantId
  emitEvidenceCapture({
    evidence: "variantId",
    detail: item.variantId,
    journey: journey.id,
    runId,
  })
  return {
    ok: true,
    detail: `resolved historical ${handle} (order ${item.medusaOrderId}, ${item.orderedAt.toISOString().split("T")[0]}) -> ${item.variantId}`,
  }
}

async function fixtureAwaitRunOrder(
  act: FixtureAct,
  ctx: JourneyRunContext,
  fctx: FixtureContext,
): Promise<ActExecutionResult> {
  const { barrier, journey, runId, runStartedAt, orderIdState } = fctx
  // T2-2a: read-only BARRIER — waits for the run's OWN order projection
  // (same stale-exclusion contract as the http-act `:orderId` binding)
  // and, with `requireEventLog: true`, for at least one
  // order_event_log row. The LGPD journey needs this ordering: the
  // erasure scrubs event-log payloads ONCE at DELETE time, so a
  // projector-lagged log row written AFTER the scrub would stay
  // un-anonymized forever and fail the invariant for the wrong reason.
  const customerId = ctx.vars["customerId"]
  if (typeof customerId !== "string") {
    return {
      ok: false,
      detail: "awaitRunOrder: ctx.vars.customerId unset — declare seedCustomer first",
    }
  }
  let orderId = ctx.vars["orderId"]
  if (typeof orderId !== "string" || orderId === "") {
    const stale = orderIdState.value
    const settled = await awaitProjection({
      prisma: barrier,
      filter: { customerId, createdAt: { gte: runStartedAt } },
      predicate: (state) => state.projection !== null && state.projection.id !== stale,
      timeoutMs: ORDER_RESOLVE_TIMEOUT_MS,
      pollMs: 250,
    })
    orderId = settled.projection?.id
    if (typeof orderId !== "string") {
      return { ok: false, detail: "awaitRunOrder: the run's order projection never appeared" }
    }
    ctx.vars["orderId"] = orderId
    emitEvidenceCapture({
      evidence: "orderId",
      detail: orderId,
      journey: journey.id,
      runId,
    })
  }
  if (act.params?.["requireEventLog"] === true) {
    const deadline = Date.now() + ORDER_RESOLVE_TIMEOUT_MS
    let rows = await barrier.orderEventLog.findMany({ where: { orderId } })
    while (rows.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      rows = await barrier.orderEventLog.findMany({ where: { orderId } })
    }
    if (rows.length === 0) {
      return {
        ok: false,
        detail: `awaitRunOrder: no order_event_log row appeared for order ${orderId} within ${ORDER_RESOLVE_TIMEOUT_MS}ms`,
      }
    }
    return {
      ok: true,
      detail: `order ${orderId} settled with ${rows.length} event-log row(s)`,
    }
  }
  return { ok: true, detail: `order ${orderId} projection settled` }
}

async function fixturePaidState(
  _act: FixtureAct,
  ctx: JourneyRunContext,
  fctx: FixtureContext,
): Promise<ActExecutionResult> {
  const { domain, barrier, journey, runId, apiBaseUrl, runStartedAt, orderIdState } = fctx
  // ── T2-1 paid-state fixture — kernel-routed, NEVER projection-forged ──
  // Drives the run's order to payment=paid through the REAL
  // signature-verified Stripe webhook route (locally signed with the test
  // plane's STRIPE_WEBHOOK_SECRET → buildEnvelope(system actor) →
  // adjudicate → projection). The resulting envelopes are SYSTEM-actor
  // rows hashing OUTSIDE the run namespace (D-015) — reconciliation is
  // unaffected and the asserted paid state has audited envelopes.
  const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"]
  if (webhookSecret === undefined || webhookSecret === "") {
    return {
      ok: false,
      detail: "paidState: STRIPE_WEBHOOK_SECRET is missing from the env (.env.test)",
    }
  }
  // Resolve the run's OWN order — same barrier + stale-exclusion contract
  // as the http-act `:orderId` binding (resolveHttpPath): the order must
  // have been created by EARLIER acts through the public storefront
  // surface; this fixture never creates orders.
  let orderId = ctx.vars["orderId"]
  if (typeof orderId !== "string" || orderId === "") {
    const customerId = ctx.vars["customerId"]
    if (typeof customerId !== "string") {
      return {
        ok: false,
        detail:
          "paidState: ctx.vars.orderId/customerId unset — declare seedCustomer and the storefront checkout acts first",
      }
    }
    const stale = orderIdState.value
    const settled = await awaitProjection({
      prisma: barrier,
      filter: { customerId, createdAt: { gte: runStartedAt } },
      predicate: (state) => state.projection !== null && state.projection.id !== stale,
      timeoutMs: ORDER_RESOLVE_TIMEOUT_MS,
      pollMs: 250,
    })
    orderId = settled.projection?.id
    if (typeof orderId !== "string") {
      return { ok: false, detail: "paidState: the run's order projection never appeared" }
    }
    ctx.vars["orderId"] = orderId
    emitEvidenceCapture({
      evidence: "orderId",
      detail: orderId,
      journey: journey.id,
      runId,
    })
  }
  // Event amount MUST equal the order total (capturePayment's stale-PI
  // guard); the active payment row's amount IS that total.
  const payment = await domain.activePaymentByOrderId(orderId)
  if (payment === null) {
    return {
      ok: false,
      detail: `paidState: order ${orderId} has no active payment row — was the checkout act kernel-EXECUTEd?`,
    }
  }
  if (payment.status === "paid") {
    return { ok: true, detail: `paidState: order ${orderId} payment already paid — no-op` }
  }
  const customerId = ctx.vars["customerId"]
  const fired = await firePaidStateWebhook({
    baseUrl: apiBaseUrl,
    webhookSecret,
    orderId,
    amountInCentavos: payment.amountInCentavos,
    ...(typeof customerId === "string" ? { customerId } : {}),
  })
  const settled = await awaitPaidState(domain, orderId)
  ctx.vars["stripeEventId"] = fired.eventId
  ctx.vars["paymentIntentId"] = fired.paymentIntentId
  emitEvidenceCapture({
    evidence: "stripeEventId",
    detail: fired.eventId,
    journey: journey.id,
    runId,
  })
  return {
    ok: true,
    detail:
      `paidState: signed webhook ${fired.eventId} drove order ${orderId} payment ` +
      `${payment.status} -> ${settled.status} (kernel payment.status.reconcile; system namespace)`,
  }
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
}): { executors: ActExecutors; preAttemptLatestOrderId: () => string | null } {
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

  // T1b-0: the customer's latest order id BEFORE this attempt (captured when
  // the seedCustomer fixture resolves) — the :orderId barrier excludes it so
  // a back-to-back attempt can never bind to its predecessor's order (see
  // resolveHttpPath). Held OUTSIDE ctx.vars: the persona kickoff serializes
  // ctx.vars and must never see raw order ids it didn't observe. A mutable
  // holder so the module-local fixture handlers share the one attempt slot.
  const orderIdState: { value: string | null } = { value: null }

  const fixtureEnv = (): FixtureContext => ({
    domain,
    barrier,
    journey,
    runId,
    apiBaseUrl,
    runStartedAt,
    orderIdState,
  })

  const fixture = async (
    act: FixtureAct,
    ctx: JourneyRunContext,
  ): Promise<ActExecutionResult> => {
    const fctx = fixtureEnv()
    switch (act.seed) {
      case "seedCustomer":
        return fixtureSeedCustomer(act, ctx, fctx)
      case "resolveProductVariant":
        return fixtureResolveProductVariant(act, ctx, fctx)
      case "seedStaff":
        return fixtureSeedStaff(act, ctx, fctx)
      case "resolveTimeSlot":
        return fixtureResolveTimeSlot(act, ctx, fctx)
      case "resolveHistoricalOrderItem":
        return fixtureResolveHistoricalOrderItem(act, ctx, fctx)
      case "awaitRunOrder":
        return fixtureAwaitRunOrder(act, ctx, fctx)
      case "paidState":
        return fixturePaidState(act, ctx, fctx)
      default:
        return {
          ok: false,
          detail:
            `unknown fixture seed "${act.seed}" (known: seedCustomer, seedStaff, ` +
            `resolveProductVariant, resolveTimeSlot, resolveHistoricalOrderItem, ` +
            `awaitRunOrder, paidState)`,
        }
    }
  }

  const chat = async (act: ChatAct, ctx: JourneyRunContext): Promise<ActExecutionResult> => {
    if (driver === undefined) {
      const cookie =
        ctx.params["authenticated"] === true ? mintCustomerCookie(ctx) : undefined
      chatClient = new ChatClient({
        baseUrl: apiBaseUrl,
        ...(cookie === undefined ? {} : { cookie }),
        turnTimeoutMs: 150_000,
        journeyId: journey.id,
        runId,
      })
      chatSessionIds.add(chatClient.sessionId)
      onProgress(`  chat session ${chatClient.sessionId}`)
      driver = new PersonaDriver({
        journey,
        runId,
        // Driver provider gate (plan C1): IBX_DRIVER_PROVIDER=ollama routes the
        // persona driver to the local Nemotron /v1 endpoint; default Anthropic.
        provider:
          process.env.IBX_DRIVER_PROVIDER === "ollama"
            ? createOllamaModelProvider()
            : createAnthropicModelProvider(),
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
    // content-type only when a body is actually sent — fastify 400s an
    // empty body under an explicit application/json content-type (T2-2a:
    // the body-less staff transition POSTs tripped this).
    const headers: Record<string, string> = {}
    if (act.body !== undefined) headers["content-type"] = "application/json"
    if (asRole === "customer") headers["cookie"] = mintCustomerCookie(ctx)
    if (asRole === "staff") headers["cookie"] = mintStaffCookie(ctx)

    const path = await resolveHttpPath(
      act.path,
      ctx,
      barrier,
      runStartedAt,
      () => orderIdState.value,
    )
    const body = act.body === undefined ? undefined : resolveBodyVars(act.body, ctx.vars)
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: act.method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    let bodyText = ""
    try {
      bodyText = await response.text()
    } catch {
      /* body read best-effort */
    }
    // T2-2b: a declared expectStatus PINS the status (exact match) — the
    // executable-spec contract for routes whose correct behaviour is
    // non-2xx (gateway REQUEST_CONFIRMATION/DEFER → 202, ESCALATE → 503).
    // Absent → the original 2xx-pass contract.
    const ok =
      act.expectStatus === undefined
        ? response.status >= 200 && response.status < 300
        : response.status === act.expectStatus

    // Declared response captures: varName → dot-path into the JSON response.
    const captureFailure = applyHttpCaptures({
      ok,
      act,
      ctx,
      bodyText,
      responseStatus: response.status,
      path,
      journeyId: journey.id,
      runId,
    })
    if (captureFailure !== null) return captureFailure

    onProgress(`  http ${act.method} ${path} -> ${response.status}`)
    const okSuffix = ok ? "" : ` ${truncate(bodyText)}`
    return {
      ok,
      detail: `${act.method} ${path} -> ${response.status}${okSuffix}`,
    }
  }

  return {
    executors: { chat, http, fixture },
    preAttemptLatestOrderId: () => orderIdState.value,
  }
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

type VerifyEntry = Journey["verify"][number]

/** Shared deps threaded into each per-invariant verify handler. */
interface VerifyContext {
  audit: AuditReader
  domain: DomainReader
  barrier: ProjectionBarrierPrisma
  scope: { sessionIds: string[] }
  fetchOpts: { since: Date }
  expected: ExpectedTrajectoryStep[]
  runStartedAt: Date
  ctx: { vars: Record<string, unknown> }
  /** T1b-0: pre-attempt latest order id — excluded by the :orderId fallback. */
  preAttemptLatestOrderId: () => string | null
}

/**
 * A verify handler's outcome. `silent: true` preserves the original
 * arg-missing fast-paths that pushed an outcome but skipped the progress
 * line (the loop only logs when `silent` is unset).
 */
interface VerifyResult {
  outcome: VerifyOutcome
  silent?: boolean
}

async function resolveRunOrderId(vctx: VerifyContext): Promise<string> {
  const { ctx, barrier, runStartedAt, preAttemptLatestOrderId } = vctx
  const fromVars = ctx.vars["orderId"]
  if (typeof fromVars === "string" && fromVars !== "") return fromVars
  const customerId = ctx.vars["customerId"]
  if (typeof customerId !== "string") {
    throw new JourneyRunCliError(
      "order.goal-state needs the run's order but ctx.vars.customerId is unset",
    )
  }
  const stale = preAttemptLatestOrderId()
  const settled = await awaitProjection({
    prisma: barrier,
    filter: { customerId, createdAt: { gte: runStartedAt } },
    predicate: (state) => state.projection !== null && state.projection.id !== stale,
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

async function verifyTrajectory(verify: VerifyEntry, vctx: VerifyContext): Promise<VerifyResult> {
  const { audit, scope, fetchOpts, expected } = vctx
  const id = verify.invariant
  // Audit-settle barrier: rows land in-turn, but poll up to the deadline
  // so projector/sink lag can never flake the trajectory assert.
  const mode = TRAJECTORY_MODES[id]!
  const deadline = Date.now() + AUDIT_SETTLE_TIMEOUT_MS
  let last = matchTrajectory(await audit.fetchRecords(scope, fetchOpts), expected, { mode })
  while (!last.ok && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, AUDIT_SETTLE_POLL_MS))
    last = matchTrajectory(await audit.fetchRecords(scope, fetchOpts), expected, { mode })
  }
  return {
    outcome: {
      invariant: id,
      ok: last.ok,
      detail: last.ok
        ? `matched ${expected.length} step(s) over ${last.observed.length} observed record(s)`
        : last.diff,
    },
  }
}

async function verifyAuditRecord(verify: VerifyEntry, vctx: VerifyContext): Promise<VerifyResult> {
  const { audit, scope, fetchOpts } = vctx
  const records = await audit.fetchRecords(scope, fetchOpts)
  const report = verifyFetchedRecords(records)
  return {
    outcome: {
      invariant: verify.invariant,
      ok: report.ok,
      detail: report.ok
        ? `${report.verifiedCount + report.redactedVerifiedCount}/${report.total} record(s) verified tamper-evident (${report.redactedVerifiedCount} redaction-aware)`
        : `${report.failures.length} failure(s): ${report.failures
            .map((f) => `${f.intentKind}@${f.at} ${f.reason}`)
            .join("; ")}`,
    },
  }
}

async function verifyKindAbsent(verify: VerifyEntry, vctx: VerifyContext): Promise<VerifyResult> {
  const { audit, scope, fetchOpts } = vctx
  const id = verify.invariant
  const kind = verify.args?.["intentKind"]
  if (typeof kind !== "string") {
    return { outcome: { invariant: id, ok: false, detail: "args.intentKind missing" }, silent: true }
  }
  const records = await audit.fetchRecords(scope, { ...fetchOpts, intentKind: kind })
  return {
    outcome: {
      invariant: id,
      ok: records.length === 0,
      detail:
        records.length === 0
          ? `no ${kind} envelope in the run namespace`
          : `${records.length} forbidden ${kind} record(s) present`,
    },
  }
}

/**
 * T1b-0 — additional YAML-bound goal-state args. These must NEVER pass
 * vacuously: an order amend's HTTP route answers 200 even when the inner tool
 * reports failure, so `containsItemHandle` (Medusa line items — the write-side
 * truth) is the load-bearing assert for JOURNEY-002, and `orderType`
 * (projection delivery_type, updated synchronously by switchTypeFromEnvelope)
 * for JOURNEY-005.
 */
async function evaluateOrderGoalArgs(args: {
  verify: VerifyEntry
  domain: DomainReader
  orderId: string
  deliveryType: string | null | undefined
}): Promise<{
  goalFailures: string[]
  observedHandles: string[] | undefined
  orderType: unknown
  containsItemHandle: unknown
}> {
  const { verify, domain, orderId, deliveryType } = args
  const goalFailures: string[] = []
  const orderType = verify.args?.["orderType"]
  if (orderType !== undefined) {
    if (typeof orderType !== "string") {
      goalFailures.push("args.orderType must be a string")
    } else if (deliveryType !== orderType) {
      goalFailures.push(
        `orderType: expected "${orderType}", projection has "${deliveryType ?? "null"}"`,
      )
    }
  }
  const containsItemHandle = verify.args?.["containsItemHandle"]
  let observedHandles: string[] | undefined
  if (containsItemHandle !== undefined) {
    if (typeof containsItemHandle === "string") {
      observedHandles = await domain.orderItemHandles(orderId)
      if (!observedHandles.includes(containsItemHandle)) {
        goalFailures.push(
          `containsItemHandle: "${containsItemHandle}" not among the order's ` +
            `Medusa line items [${observedHandles.join(", ")}]`,
        )
      }
    } else {
      goalFailures.push("args.containsItemHandle must be a string")
    }
  }
  return { goalFailures, observedHandles, orderType, containsItemHandle }
}

async function verifyOrderGoalState(
  verify: VerifyEntry,
  vctx: VerifyContext,
): Promise<VerifyResult> {
  const { barrier, domain } = vctx
  const id = verify.invariant
  const status = verify.args?.["status"]
  if (typeof status !== "string") {
    return { outcome: { invariant: id, ok: false, detail: "args.status missing" }, silent: true }
  }
  const orderId = await resolveRunOrderId(vctx)
  const settled = await awaitProjection({
    prisma: barrier,
    orderId,
    predicate: (state) =>
      (state.projection?.["fulfillmentStatus"] as string | undefined) === status,
    timeoutMs: GOAL_STATE_TIMEOUT_MS,
    pollMs: 250,
  })
  const row = await domain.orderById(orderId)

  const { goalFailures, observedHandles, orderType, containsItemHandle } =
    await evaluateOrderGoalArgs({ verify, domain, orderId, deliveryType: row?.deliveryType })

  const orderTypeNote = typeof orderType === "string" ? `, orderType=${orderType}` : ""
  const handleNote =
    typeof containsItemHandle === "string"
      ? `, contains ${containsItemHandle} of [${(observedHandles ?? []).join(", ")}]`
      : ""
  const successDetail =
    `order ${orderId} reached fulfillmentStatus=${status} ` +
    `(version=${row?.version ?? "?"}, barrier ${settled.elapsedMs}ms/${settled.polls} polls` +
    `${orderTypeNote}${handleNote})`
  const detail =
    goalFailures.length > 0 ? `order ${orderId}: ${goalFailures.join("; ")}` : successDetail
  return { outcome: { invariant: id, ok: goalFailures.length === 0, detail } }
}

async function verifyPaymentGoalState(
  verify: VerifyEntry,
  vctx: VerifyContext,
): Promise<VerifyResult> {
  const { domain } = vctx
  const id = verify.invariant
  // T2-2b: the run's own order's ACTIVE payment row must reach
  // args.status (and, when declared, args.method) on the oracle plane.
  // Same reader the paid-state fixture barriers on
  // (domain.activePaymentByOrderId — createdAt-desc, terminal-status
  // excluded, the SUT's getActiveByOrderId semantics), polled up to
  // the goal-state budget so projector/BullMQ lag can never flake it.
  // Never vacuous: a missing active payment row is a FAILURE.
  const status = verify.args?.["status"]
  if (typeof status !== "string") {
    return { outcome: { invariant: id, ok: false, detail: "args.status missing" }, silent: true }
  }
  const method = verify.args?.["method"]
  if (method !== undefined && typeof method !== "string") {
    return {
      outcome: { invariant: id, ok: false, detail: "args.method must be a string" },
      silent: true,
    }
  }
  const orderId = await resolveRunOrderId(vctx)
  const deadline = Date.now() + GOAL_STATE_TIMEOUT_MS
  let row = await domain.activePaymentByOrderId(orderId)
  const matches = (): boolean =>
    row !== null && row.status === status && (method === undefined || row.method === method)
  while (!matches() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    row = await domain.activePaymentByOrderId(orderId)
  }
  const methodNote = method === undefined ? "" : ` method=${method}`
  let detail: string
  if (row === null) {
    detail = `order ${orderId} has NO active payment row (expected status=${status}${methodNote})`
  } else if (matches()) {
    detail = `order ${orderId} active payment reached status=${row.status} method=${row.method} (${row.amountInCentavos} centavos)`
  } else {
    detail = `order ${orderId} active payment is status=${row.status} method=${row.method}, expected status=${status}${methodNote}`
  }
  return { outcome: { invariant: id, ok: matches(), detail } }
}

async function verifyReservationGoalState(
  verify: VerifyEntry,
  vctx: VerifyContext,
): Promise<VerifyResult> {
  const { domain, ctx } = vctx
  const id = verify.invariant
  // T2-2a: the run's OWN reservation (ctx.vars.reservationId — captured
  // by the reservation-create http act) must reach args.status. The
  // staff transitions are synchronous in the admin routes, but poll up
  // to the goal-state budget so a slow stack can never flake this.
  const status = verify.args?.["status"]
  if (typeof status !== "string") {
    return { outcome: { invariant: id, ok: false, detail: "args.status missing" }, silent: true }
  }
  const reservationId = ctx.vars["reservationId"]
  if (typeof reservationId !== "string" || reservationId === "") {
    return {
      outcome: {
        invariant: id,
        ok: false,
        detail: "ctx.vars.reservationId unset — the reservation-create http act must capture it",
      },
      silent: true,
    }
  }
  const deadline = Date.now() + GOAL_STATE_TIMEOUT_MS
  let row = await domain.reservationById(reservationId)
  while (row?.status !== status && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    row = await domain.reservationById(reservationId)
  }
  let detail: string
  if (row === null) {
    detail = `reservation ${reservationId} not found`
  } else if (row.status === status) {
    detail = `reservation ${reservationId} reached status=${status} (partySize=${row.partySize})`
  } else {
    detail = `reservation ${reservationId} status=${row.status}, expected ${status}`
  }
  return { outcome: { invariant: id, ok: row?.status === status, detail } }
}

async function verifyEventLogAnonymized(
  verify: VerifyEntry,
  vctx: VerifyContext,
): Promise<VerifyResult> {
  const { barrier } = vctx
  const id = verify.invariant
  // T2-2a (LGPD): EVERY order_event_log row for the run's own order
  // carries the scrub payload {anonymized: true} — and at least one
  // row exists (non-vacuous; the awaitRunOrder fixture barriers on the
  // log row BEFORE the erasure act so a projector-lagged row can never
  // dodge the scrub). This is the exact behavior anonymizeCustomer
  // writes (customer.service.ts surface 5) and the projection barrier
  // already tolerates.
  const orderId = await resolveRunOrderId(vctx)
  const rows = await barrier.orderEventLog.findMany({ where: { orderId } })
  const notAnonymized = rows.filter((row) => {
    const payload = row.payload as Record<string, unknown> | null
    return !(payload !== null && typeof payload === "object" && payload["anonymized"] === true)
  })
  let detail: string
  if (rows.length === 0) {
    detail = `order ${orderId} has NO event-log rows — the assert would be vacuous (barrier on awaitRunOrder requireEventLog before erasing)`
  } else if (notAnonymized.length === 0) {
    detail = `all ${rows.length} event-log row(s) for order ${orderId} carry {anonymized: true}`
  } else {
    detail = `${notAnonymized.length}/${rows.length} event-log row(s) for order ${orderId} NOT anonymized (e.g. ${notAnonymized[0]?.eventType})`
  }
  return {
    outcome: { invariant: id, ok: rows.length > 0 && notAnonymized.length === 0, detail },
  }
}

async function verifyCustomerAnonymize(
  verify: VerifyEntry,
  vctx: VerifyContext,
): Promise<VerifyResult> {
  const { domain, ctx } = vctx
  const id = verify.invariant
  // T2-2a (LGPD): the customer row is scrubbed exactly as
  // anonymizeCustomer specifies — sentinel phone, fixed name, null
  // email/cpf. Synchronous by the DELETE route's 200, so a single
  // oracle read suffices.
  const customerId = ctx.vars["customerId"]
  if (typeof customerId !== "string" || customerId === "") {
    return {
      outcome: {
        invariant: id,
        ok: false,
        detail: "ctx.vars.customerId unset — declare the seedCustomer fixture act first",
      },
      silent: true,
    }
  }
  const row = await domain.customerLgpdById(customerId)
  const failures: string[] = []
  if (row === null) {
    failures.push("customer row missing (anonymize keeps the row — it must exist)")
  } else {
    if (row.name !== "Usuário Removido") failures.push(`name="${row.name ?? "null"}"`)
    if (!row.phone.startsWith("anonymized:")) failures.push("phone not the anonymized: sentinel")
    if (row.email !== null) failures.push("email not null")
    if (row.cpf !== null) failures.push("cpf not null")
  }
  return {
    outcome: {
      invariant: id,
      ok: failures.length === 0,
      detail:
        failures.length === 0
          ? `customer ${customerId} scrubbed (sentinel phone, name "Usuário Removido", email/cpf null)`
          : `customer ${customerId} NOT fully scrubbed: ${failures.join("; ")}`,
    },
  }
}

/** Dispatch a single verify entry to its handler (registered ids fail loudly). */
async function evaluateVerify(verify: VerifyEntry, vctx: VerifyContext): Promise<VerifyResult> {
  const id = verify.invariant
  if (id in TRAJECTORY_MODES) return verifyTrajectory(verify, vctx)
  if (id === "audit.record.verified") return verifyAuditRecord(verify, vctx)
  if (id === "audit.kind-absent") return verifyKindAbsent(verify, vctx)
  if (id === "order.goal-state") return verifyOrderGoalState(verify, vctx)
  if (id === "payment.goal-state") return verifyPaymentGoalState(verify, vctx)
  if (id === "reservation.goal-state") return verifyReservationGoalState(verify, vctx)
  if (id === "order.event-log.anonymized") return verifyEventLogAnonymized(verify, vctx)
  if (id === "customer.anonymize.goal-state") return verifyCustomerAnonymize(verify, vctx)
  // Registered ids without a T1a-13 binding fail LOUDLY — an invariant
  // must never pass vacuously (cart goal-state + audit.refusal-basis
  // land with the journeys that need them).
  return {
    outcome: {
      invariant: id,
      ok: false,
      detail: `invariant "${id}" has no harness binding yet (T1a-13 implements what JOURNEY-001 needs)`,
    },
  }
}

async function runVerifyPhase(args: {
  journey: Journey
  ctx: { vars: Record<string, unknown> }
  audit: AuditReader
  domain: DomainReader
  barrier: ProjectionBarrierPrisma
  scopeSessionIds: string[]
  runStartedAt: Date
  /** T1b-0: pre-attempt latest order id — excluded by the :orderId fallback. */
  preAttemptLatestOrderId: () => string | null
  onProgress: (line: string) => void
}): Promise<VerifyOutcome[]> {
  const { journey, ctx, audit, domain, barrier, scopeSessionIds, runStartedAt, onProgress } =
    args
  const outcomes: VerifyOutcome[] = []
  const vctx: VerifyContext = {
    audit,
    domain,
    barrier,
    scope: { sessionIds: scopeSessionIds },
    // Time-scope every fetch to the attempt window: the seeded customer is
    // shared across attempts, so the hashed(customerId) namespace accumulates
    // rows from earlier runs — `since` cuts them out of the trajectory.
    fetchOpts: { since: runStartedAt },
    // `optional: true` entries are reconciliation ALLOWANCES (T1b-1), never
    // trajectory requirements — only required expects become expected steps.
    expected: journey.expects
      .filter((e) => e.optional !== true)
      .map((e) => ({ intentKind: e.intentKind, decision: e.decision })),
    runStartedAt,
    ctx,
    preAttemptLatestOrderId: args.preAttemptLatestOrderId,
  }

  for (const verify of journey.verify) {
    const id = verify.invariant
    let result: VerifyResult
    try {
      result = await evaluateVerify(verify, vctx)
    } catch (err) {
      const detail =
        err instanceof ProjectionBarrierTimeoutError ? err.message : (err as Error).message
      result = { outcome: { invariant: id, ok: false, detail } }
    }
    outcomes.push(result.outcome)
    if (result.silent !== true) {
      const { ok, invariant, detail } = result.outcome
      onProgress(`  verify ${ok ? "PASS" : "FAIL"} ${invariant}: ${truncate(detail, 200)}`)
    }
  }
  return outcomes
}

// ── One attempt ──────────────────────────────────────────────────────────────

/**
 * The run's HASHED audit-namespace set (D-012): the audit redactor hashes
 * every actor.sessionId before the intent_audit row lands — chat acts under
 * hashed(chat sessionId), customer http acts under hashed(customerId).
 *
 * T2-2a extensions (explicit, never blanket — widening every run's scope
 * would surface foreign-namespace envelopes in OTHER journeys' gates):
 *   * staff acts: the admin reservation routes stamp actor.sessionId =
 *     `admin:${staffId}` — included whenever a seedStaff fixture resolved
 *     ctx.vars.staffId (only staff-act journeys do).
 *   * params.auditScopeCustomerTool: true — opt-in for the
 *     `customer:${customerId}` namespace some user-principal routes/tools
 *     stamp. Declared per journey, so kernel rows landing there become part
 *     of THAT run's reconciled trail only.
 */
function computeHashedRunSessionIds(
  chatSessionIds: Set<string>,
  vars: Record<string, unknown>,
  journey: Journey,
): string[] {
  const redactSecret = process.env["AUDIT_REDACT_SECRET"] ?? ""
  const ids = [
    ...[...chatSessionIds].map((s) => hashedAuditSessionId(s, redactSecret)),
    ...(typeof vars["customerId"] === "string"
      ? [hashedAuditSessionId(vars["customerId"] as string, redactSecret)]
      : []),
  ]
  if (
    journey.params?.["auditScopeCustomerTool"] === true &&
    typeof vars["customerId"] === "string"
  ) {
    ids.push(hashedAuditSessionId(`customer:${vars["customerId"] as string}`, redactSecret))
  }
  if (typeof vars["staffId"] === "string") {
    ids.push(hashedAuditSessionId(`admin:${vars["staffId"] as string}`, redactSecret))
  }
  return ids
}

/**
 * Verify[] re-execution scoped to the run's HASHED session ids, plus the
 * mandatory T1b-1 reconciliation gate. Returns the gathered outcomes plus the
 * derived pass/error so the caller stays a thin orchestrator.
 */
async function runVerifyAndReconcile(args: {
  journey: Journey
  vars: Record<string, unknown>
  audit: AuditReader
  domain: DomainReader
  barrier: ProjectionBarrierPrisma
  runStartedAt: Date
  preAttemptLatestOrderId: () => string | null
  scopeSessionIds: string[]
  onProgress: (line: string) => void
}): Promise<{
  verifyOutcomes: VerifyOutcome[]
  reconciliation: ReconciliationReport | undefined
  pass: boolean
  error: string | undefined
}> {
  const {
    journey,
    vars,
    audit,
    domain,
    barrier,
    runStartedAt,
    preAttemptLatestOrderId,
    scopeSessionIds,
    onProgress,
  } = args
  const verifyOutcomes = await runVerifyPhase({
    journey,
    ctx: { vars },
    audit,
    domain,
    barrier,
    scopeSessionIds,
    runStartedAt,
    preAttemptLatestOrderId,
    onProgress,
  })

  // ── T1b-1 reconciliation gate (post-attempt, mandatory) ─────────────
  // Every observed envelope in the run's namespaces must be explained by
  // an expects[] entry (required or optional allowance) — unexplained
  // envelopes are drift and fail the attempt; verify[] goal-state asserts
  // must trace to audited EXECUTE/REWRITE decisions (no fixture-forged
  // assertions). An empty scope (no chat sessions, no customer) reconciles
  // over [] — with state-asserting verify[] entries that is itself the
  // forged-assertion failure.
  let reconciliation: ReconciliationReport | undefined
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
    const optionalCount = reconciliation.observed.filter(
      (o) => o.explanation === "optional",
    ).length
    const supersededNote =
      reconciliation.supersededCount > 0
        ? `, ${reconciliation.supersededCount} superseded intermediate(s) dropped`
        : ""
    verifyOutcomes.push({
      invariant: RECONCILIATION_GATE_ID,
      ok: reconciliation.ok,
      detail: reconciliation.ok
        ? `${reconciliation.observed.length} observed envelope(s) all explained ` +
          `(${optionalCount} by optional allowances${supersededNote})`
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

  const pass = verifyOutcomes.every((o) => o.ok)
  let error: string | undefined
  if (!pass) {
    error = verifyOutcomes
      .filter((o) => !o.ok)
      .map((o) => `${o.invariant}: ${o.detail}`)
      .join(" | ")
  }
  return { verifyOutcomes, reconciliation, pass, error }
}

/**
 * Cost report (driver in-process; SUT from IBX_EVENTS_FILE). A pricing failure
 * is a RED attempt — never a silent $0 line — so it surfaces `failed: true`
 * (the caller forces pass=false) and folds the message into `error`.
 */
function computeAttemptCost(args: {
  priceTable: PriceTable
  driverCalls: Array<IbxEventBase & LlmCallLike>
  sutCalls: Array<IbxEventBase & LlmCallLike>
  priorError: string | undefined
}): { cost: AttemptCost; error: string | undefined; failed: boolean } {
  const { priceTable, driverCalls, sutCalls, priorError } = args
  try {
    return {
      cost: attemptCost(priceTable, driverCalls, sutCalls),
      error: priorError,
      failed: false,
    }
  } catch (err) {
    const cost: AttemptCost = {
      driver: { calls: driverCalls.length, tokens: { in: 0, out: 0 }, costUsd: 0 },
      sut: { calls: sutCalls.length, tokens: { in: 0, out: 0 }, costUsd: 0 },
      totalUsd: 0,
    }
    const costErrorPrefix = priorError === undefined ? "" : `${priorError} | `
    return { cost, error: `${costErrorPrefix}cost: ${(err as Error).message}`, failed: true }
  }
}

/** Trace file: every in-process event + the run's SUT llm.call events. */
function writeTraceFile(args: {
  tracePath: string
  events: IbxEventBase[]
  sutCalls: Array<IbxEventBase & LlmCallLike>
  verifyOutcomes: VerifyOutcome[] | undefined
  journeyId: string
  runId: string
  onProgress: (line: string) => void
}): void {
  const { tracePath, events, sutCalls, verifyOutcomes, journeyId, runId, onProgress } = args
  try {
    mkdirSync(dirname(tracePath), { recursive: true })
    const lines = [
      ...events.map((e) => JSON.stringify(e)),
      ...sutCalls.map((e) => JSON.stringify(e)),
      ...(verifyOutcomes ?? []).map((o) =>
        JSON.stringify({
          type: "verify.outcome",
          timestamp: new Date().toISOString(),
          journey: journeyId,
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
}

/**
 * T1b-5 sim store: persistent run record joined to intent_audit, written
 * through the DEDICATED ibx_sim_writer role. Bookkeeping, not a gate: a write
 * failure warns LOUDLY but never flips the attempt outcome.
 */
async function persistSimRun(args: {
  runId: string
  journey: Journey
  runStartedAt: Date
  pass: boolean
  attempt: number
  certifying: boolean
  cost: AttemptCost
  sessionIds: string[]
  reconciliation: ReconciliationReport | undefined
  onProgress: (line: string) => void
}): Promise<void> {
  const {
    runId,
    journey,
    runStartedAt,
    pass,
    attempt,
    certifying,
    cost,
    sessionIds,
    reconciliation,
    onProgress,
  } = args
  try {
    const simStore = createSimStore()
    try {
      await simStore.writeAttempt({
        run: {
          runId,
          journeyId: journey.id,
          // The attempt's audit-window start (same instant the verify scope
          // uses) so the documented join reproduces the observed trail.
          startedAt: runStartedAt,
          finishedAt: new Date(),
          pass,
          attempt,
          modelId: process.env["ANTHROPIC_MODEL"] ?? "unknown",
          certifying,
          costUsd: cost.totalUsd,
          driverTokens: cost.driver.tokens,
          sutTokens: cost.sut.tokens,
          sessionIds,
        },
        expects: journey.expects,
        ...(reconciliation === undefined ? {} : { reconciliation }),
      })
    } finally {
      await simStore.close()
    }
  } catch (err) {
    onProgress(
      `  warning: sim-store write failed — run record not persisted (${(err as Error).message})`,
    )
  }
}

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

    const { executors, preAttemptLatestOrderId } = buildExecutors({
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

    if (result.ok) {
      // ── Verify[] re-execution — scoped to the run's HASHED session ids ──
      // (audit-redactor hashes every actor.sessionId; chat acts land under
      // hashed(chat sessionId), customer http acts under hashed(customerId)).
      const scopeSessionIds = computeHashedRunSessionIds(chatSessionIds, vars, journey)
      const vr = await runVerifyAndReconcile({
        journey,
        vars,
        audit,
        domain,
        barrier,
        runStartedAt,
        preAttemptLatestOrderId,
        scopeSessionIds,
        onProgress,
      })
      verifyOutcomes = vr.verifyOutcomes
      reconciliation = vr.reconciliation
      pass = vr.pass
      if (vr.error !== undefined) error = vr.error
    } else {
      error = result.error ?? "act_failed"
    }
  } catch (err) {
    error = `${(err as Error).name}: ${(err as Error).message}`
  } finally {
    unsubscribe()
    await pool?.end().catch(() => undefined)
  }

  const driverCalls = events.filter(
    (e): e is IbxEventBase & LlmCallLike =>
      e.type === "llm.call" && e.runId === runId && e.source !== "sut",
  )
  const eventsFile = process.env["IBX_EVENTS_FILE"]
  const sutCalls =
    eventsFile !== undefined && eventsFile !== ""
      ? (readSutLlmCalls(eventsFile, chatSessionIds) as Array<IbxEventBase & LlmCallLike>)
      : []
  const costResult = computeAttemptCost({ priceTable, driverCalls, sutCalls, priorError: error })
  const cost = costResult.cost
  error = costResult.error
  if (costResult.failed) pass = false

  const turns = events.filter(
    (e) => e.type === "chat.turn.end" && e.runId === runId && e.outcome === "pass",
  ).length
  const durationMs = Date.now() - startedAtMs

  writeTraceFile({
    tracePath,
    events,
    sutCalls,
    verifyOutcomes,
    journeyId: journey.id,
    runId,
    onProgress,
  })

  await persistSimRun({
    runId,
    journey,
    runStartedAt,
    pass,
    attempt,
    certifying,
    cost,
    sessionIds: computeHashedRunSessionIds(chatSessionIds, vars, journey),
    reconciliation,
    onProgress,
  })

  const costLine = renderCostLine(`attempt ${attempt}`, cost)
  return {
    attempt,
    runId,
    pass,
    status: "completed",
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
    ...(error === undefined ? {} : { error }),
    ...(verifyOutcomes === undefined ? {} : { verify: verifyOutcomes }),
    ...(reconciliation === undefined ? {} : { reconciliation }),
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
        status: "completed", // it RAN (and timed out) — not budget-truncated
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

// ── Budget-aware k-loop (T1b-8) ──────────────────────────────────────────────

/** The attempt record reported for a budget-truncated (never-run) attempt. */
export function abortedByBudgetAttemptReport(
  attempt: number,
  budget: DollarBudget,
): JourneyAttemptReport {
  const detail =
    `cumulative suite cost ${formatUsd(budget.spentUsd)} >= cap ${formatUsd(budget.capUsd)} ` +
    `(cap source: ${budget.source}; --budget-usd / ${NIGHTLY_BUDGET_ENV})`
  return {
    attempt,
    runId: ABORTED_BY_BUDGET,
    pass: false,
    status: ABORTED_BY_BUDGET,
    certifying: false,
    turns: 0,
    costUsd: 0,
    driverCostUsd: 0,
    sutCostUsd: 0,
    driverTokens: { in: 0, out: 0 },
    sutTokens: { in: 0, out: 0 },
    durationMs: 0,
    tracePath: "",
    costLine: `cost[attempt ${attempt}]: ${ABORTED_BY_BUDGET} (${detail})`,
    error: `${ABORTED_BY_BUDGET}: ${detail}`,
  }
}

/**
 * Run up to `k` sequential attempts, charging each attempt's MEASURED cost
 * (`llm.call` events × the checked-in price table — already aggregated into
 * the attempt report's `costUsd`) into the shared `DollarBudget` after the
 * attempt finishes. Once cumulative spend ≥ cap, every remaining attempt is
 * reported `aborted-by-budget` (pass=false → RED) instead of running —
 * never silent truncation. Exported as the unit-test seam for the T1b-8
 * abort semantics (`runJourneyCli` composes it with the real attempt fn).
 */
export async function runAttemptsWithBudget(args: {
  journeyId: string
  k: number
  budget: DollarBudget
  runAttempt: (attempt: number) => Promise<JourneyAttemptReport>
  onProgress?: (line: string) => void
}): Promise<{ attempts: JourneyAttemptReport[]; abortedByBudget: boolean }> {
  const { journeyId, k, budget, runAttempt } = args
  const onProgress = args.onProgress ?? (() => undefined)
  const attempts: JourneyAttemptReport[] = []
  let abortedByBudget = false

  for (let attempt = 1; attempt <= k; attempt++) {
    if (budget.exceeded()) {
      const aborted = abortedByBudgetAttemptReport(attempt, budget)
      if (!abortedByBudget) {
        // First truncated attempt of THIS journey → one journey.aborted event
        // (reason "dollar_cap" — the emitter contract for T1b-8).
        abortedByBudget = true
        emitJourneyAborted({
          journey: journeyId,
          runId: ABORTED_BY_BUDGET,
          reason: "dollar_cap",
          detail: aborted.error ?? renderBudgetLine(budget),
        })
        onProgress(`${journeyId}: ${renderBudgetLine(budget)}`)
      }
      attempts.push(aborted)
      onProgress(`${journeyId} attempt ${attempt}/${k}: ${ABORTED_BY_BUDGET}`)
      continue
    }
    const report = await runAttempt(attempt)
    attempts.push(report)
    budget.charge(report.costUsd)
  }

  return { attempts, abortedByBudget }
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

  // ── T1b-7 per-run journey lock ─────────────────────────────────────────
  // One Redis lock per JOURNEY id (SET NX EX, UUID-token value, Lua
  // conditional release — runner/journey-lock.ts): concurrent runs of the
  // SAME journey serialize — the second run WAITS for the holder (with a
  // progress line), failing with a clear message past the deadline; runs
  // of DIFFERENT journeys never contend. Serialization protects the run's
  // shared stack state: the seeded customer row, the hashed(customerId)
  // audit namespace the verify phase scopes to (D-012), and the
  // order-cancel route's 5/10min/customer rate-limit budget (D-014).
  // REDIS_URL comes from the harness env (.env.test, loaded above).
  let lock: JourneyLockHandle
  try {
    lock = await acquireJourneyLock(journey.id, { onWait: onProgress })
  } catch (err) {
    throw new JourneyRunCliError(
      err instanceof JourneyLockTimeoutError
        ? err.message
        : `journey lock: acquire failed for ${journey.id} — ${(err as Error).message}`,
    )
  }

  try {
    return await runLockedJourney({ journey, k, options, onProgress })
  } finally {
    await lock.release()
    // The lock's shared Redis client must never pin the event loop open
    // after the run (`ibx journey run` exits via exitCode, not process.exit).
    await closeRedisClient().catch(() => undefined)
  }
}

/** The lock-guarded body of `runJourneyCli` — attempts, budget, report. */
async function runLockedJourney(args: {
  journey: Journey
  k: number
  options: RunJourneyCliOptions
  onProgress: (line: string) => void
}): Promise<JourneyRunReport> {
  const { journey, k, options, onProgress } = args
  const priceTable = loadPriceTable()
  const apiBaseUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001"
  const runsDir = options.runsDir ?? join(REPO_ROOT, "runs")

  // T1b-8 dollar budget: the suite passes ONE shared accumulator; a
  // standalone run builds its own (--budget-usd > IBX_NIGHTLY_BUDGET_USD >
  // $50 default). Cumulative cost is charged after EACH attempt; once
  // spend ≥ cap, the remaining attempts are reported aborted-by-budget.
  const budget = options.budget ?? createDollarBudget(resolveBudgetCapUsd(options.budgetUsd))

  const { attempts, abortedByBudget } = await runAttemptsWithBudget({
    journeyId: journey.id,
    k,
    budget,
    onProgress,
    runAttempt: async (attempt) => {
      onProgress(`${journey.id} attempt ${attempt}/${k} starting`)
      const report = await runAttemptWithTimeout({
        journey,
        attempt,
        apiBaseUrl,
        priceTable,
        runsDir,
        onProgress,
      })
      const errorNote =
        report.error === undefined ? "" : ` — ${truncate(report.error, 300)}`
      onProgress(
        `${journey.id} attempt ${attempt}/${k}: ${report.pass ? "PASS" : "FAIL"} ` +
          `(turns=${report.turns}, ${(report.durationMs / 1000).toFixed(1)}s` +
          `${report.certifying ? ", certifying" : ", NON-certifying"})` +
          `${errorNote}`,
      )
      onProgress(report.costLine)
      return report
    },
  })

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
    status: abortedByBudget ? ABORTED_BY_BUDGET : "completed",
    attempts,
    totalCostUsd,
    costLine,
    budget: budget.snapshot(),
  }
}
