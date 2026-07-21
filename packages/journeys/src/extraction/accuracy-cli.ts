// extraction/accuracy-cli.ts — `ibx journey extraction-accuracy` (FE-T07):
// the full live-run composition, mirroring `run-journey-cli.ts`'s
// relationship to the CLI (thin registration in packages/cli, all
// composition here) and `gates/coverage.ts`'s report/baseline shape.
//
// Steps: load `.env.test` -> resolve the seeded staff + customer rows
// (SEED_STAFF / SEED_CUSTOMERS, packages/domain/src/seed-constants.ts) ->
// mint their cookies -> load the extraction corpus -> split it by each
// file's declared `plane` -> drive the ops-plane files over the ops-chat
// route and the customer-plane files over the customer-chat route
// (accuracy-runner.ts) -> merge both result sets -> score against
// expectPayload (accuracy.ts).
//
// FE-T12 added the customer-plane half (`driveExtractionCorpusOverCustomerChat`)
// — see accuracy-runner.ts's header for the full design (fire-and-forget
// route, confirm-kind semantics, session-scoped isolation).

import { createHash } from "node:crypto"
import { loadExtractionCorpus } from "./load.js"
import type { ExtractionCorpusFile } from "./schema.js"
import {
  computeAccuracyReport,
  type AccuracyCaseResult,
  type AccuracyReport,
  type ComputeAccuracyReportOptions,
  type IsolationFailure,
} from "./accuracy.js"
import {
  driveExtractionCorpusOverOpsChat,
  driveExtractionCorpusOverCustomerChat,
} from "./accuracy-runner.js"
import { createAuditReader, type AuditReader } from "../oracle/audit-reader.js"
import { createDomainReader, type DomainReader } from "../oracle/domain-reader.js"
import { loadTestEnv } from "../harness/test-env.js"
import { seedCheckoutCart, targetCentavosForCase } from "../live/seed-checkout-cart.js"
import { seedCancelableOrder, targetCentavosForCancelCase } from "../live/seed-cancelable-order.js"
import { seedItemCart } from "../live/seed-item-cart.js"
import { seedItemOrder } from "../live/seed-item-order.js"
import {
  mintStaffToken,
  mintCustomerToken,
  cookieHeader,
  type StaffRole,
} from "../clients/auth-fixture.js"

export class ExtractionAccuracyCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExtractionAccuracyCliError"
  }
}

/** The one seeded staff row every ops-chat drive authenticates as (packages/domain/src/seed-constants.ts). */
export const ACCURACY_RUN_STAFF_PHONE = "+5519900000900"

/**
 * All 10 seeded customer rows a customer-chat drive CAN authenticate as
 * (FE-T12 follow-up, team-lead ruling). Literal duplicates of
 * `SEED_CUSTOMERS`' phones (packages/domain/src/seed-constants.ts) — NOT an
 * import — same "duplicate rather than reach past the package boundary"
 * convention as `ACCURACY_RUN_STAFF_PHONE`.
 *
 * Why a POOL, not one identity: the F4 session token-budget guard
 * (`compose-policy-packs.ts`'s `sessionTokenBudgetGuard`) meters
 * `llm:tokens:<channel>:<customerId>` — keyed by `customerId`, NOT
 * `sessionId` — so every case in a customer-plane run accumulates onto
 * whichever ONE customer authenticates, regardless of how many sessionIds
 * `driveExtractionCorpusOverCustomerChat`'s per-case rotation mints. A
 * single shared identity meant every ticket sharing this driver (T11/T13/
 * T14, alongside this one) would meter onto the SAME customer's cumulative
 * total and REFUSE with `token_budget.exhausted` on whichever corpus ran
 * last — a real, live-caught hazard: FE-T12's own calibration exhausted the
 * default 100,000-token budget (the counter read 184,892 after ~90 turns
 * against index 0 alone). `--customer-index` (accuracy-cli.ts's CLI
 * registration) lets each pass pick a DIFFERENT already-seeded, never-
 * shared identity instead of every ticket inventing a divergent scratch
 * workaround (the FE-D07 duplication-class hazard) or resetting anyone's
 * counter.
 */
export const ACCURACY_RUN_CUSTOMER_PHONES = [
  "+5519900000001",
  "+5519900000002",
  "+5519900000003",
  "+5519900000004",
  "+5519900000005",
  "+5519900000006",
  "+5519900000007",
  "+5519900000008",
  "+5519900000009",
  "+5519900000010",
] as const

/**
 * Backward-compat alias — index 0, the ORIGINAL (and still default) single
 * identity every existing caller resolves to when `customerIndex` is
 * omitted. Nothing changes for any caller that doesn't pass `--customer-
 * index`/`customerIndex`.
 */
export const ACCURACY_RUN_CUSTOMER_PHONE = ACCURACY_RUN_CUSTOMER_PHONES[0]

/**
 * Pure range-check, split out from `resolveCustomerCookie` so it's testable
 * without a DomainReader/DB: an out-of-range `--customer-index` must fail
 * with a clear, actionable error, not a silent `undefined` phone reaching
 * `domain.customerByPhone`.
 */
export function resolveCustomerPhoneForIndex(customerIndex: number): string {
  const phone = ACCURACY_RUN_CUSTOMER_PHONES[customerIndex]
  if (phone === undefined) {
    throw new ExtractionAccuracyCliError(
      `--customer-index ${customerIndex} out of range — ACCURACY_RUN_CUSTOMER_PHONES has ` +
        `${ACCURACY_RUN_CUSTOMER_PHONES.length} entries (valid indices: 0-${ACCURACY_RUN_CUSTOMER_PHONES.length - 1})`,
    )
  }
  return phone
}

/** Byte-for-byte mirror of the audit sink's salted sessionId hash (see oracle/domain-reader.ts's own copy — duplicated here rather than imported to keep this a single, self-contained composition point). */
function hashedSessionId(sessionId: string, redactSecret: string): string {
  const h = createHash("sha256")
  h.update(sessionId)
  h.update(redactSecret)
  return `hashed:${h.digest("hex").slice(0, 8)}`
}

export interface RunExtractionAccuracyCliOptions {
  /** Extraction-corpus dir override (default: packages/journeys/extraction-corpus/). */
  corpusDir?: string
  /** SUT api base (default: IBX_TEST_API_URL env, else http://localhost:3001). */
  apiBaseUrl?: string
  /** .env.test path override (default <repo>/.env.test; shell env wins per key — loadTestEnv contract). */
  envFile?: string
  /** Waivers file override (default: the committed governance file). */
  waiversPath?: string
  /** Quarantined case keys (`<capability>:<caseId>`) — see accuracy.ts's seam doc. */
  quarantined?: readonly string[]
  /**
   * Which `ACCURACY_RUN_CUSTOMER_PHONES` entry the customer-plane half
   * authenticates as (default: 0, `ACCURACY_RUN_CUSTOMER_PHONE` — unchanged
   * behavior for every existing caller). See that constant's doc for why a
   * pool exists: the token-budget guard metes per customerId, so a ticket
   * whose corpus runs after another's on the SAME index inherits its
   * accumulated usage.
   */
  customerIndex?: number
  /**
   * Opt-in ONLY (default false): resets the resolved customer-plane
   * calibration identity's token-budget counter BEFORE this run drives —
   * see "Opt-in customer-plane token-budget reset" above for the full
   * rationale/constraints (`shouldResetCustomerTokenBudget`,
   * `resetCustomerTokenBudgetCounter`). Never fires mid-pass; a single pass
   * exhausting the budget on its own is report-and-stop, not a trigger for
   * this flag.
   */
  resetCustomerTokenBudget?: boolean
  onProgress?: (line: string) => void
}

export interface ExtractionAccuracyCliResult {
  report: AccuracyReport
  results: AccuracyCaseResult[]
}

async function resolveStaffCookie(
  domain: DomainReader,
  staffJwtSecret: string,
): Promise<{ cookie: string; staffId: string }> {
  const staff = await domain.staffByPhone(ACCURACY_RUN_STAFF_PHONE)
  if (staff === null) {
    throw new ExtractionAccuracyCliError(
      `no seeded staff with phone ${ACCURACY_RUN_STAFF_PHONE} — run \`ibx test seed\` (seed-domain upserts SEED_STAFF)`,
    )
  }
  if (!staff.active) {
    throw new ExtractionAccuracyCliError(`seeded staff ${staff.id} is INACTIVE`)
  }
  const cookie = cookieHeader(
    mintStaffToken({ staffId: staff.id, role: staff.role as StaffRole, staffJwtSecret }),
  )
  return { cookie, staffId: staff.id }
}

/**
 * FE-T12 — the customer-plane sibling of `resolveStaffCookie`. Resolves the
 * ONE seeded customer row (`ACCURACY_RUN_CUSTOMER_PHONE`) and mints its
 * `token=` cookie via `mintCustomerToken` — the SAME fixture-minting
 * mechanism `resolveStaffCookie` already uses for staff (check-bypass-leg-6
 * sanctioned, `@ibatexas/journeys`-only), never the real Twilio-OTP HTTP
 * round trip (that recipe exists for ad-hoc/manual RCA drives outside this
 * package — see the ibx-rca skill's scripts — not for an automated,
 * repeated corpus meter).
 */
async function resolveCustomerCookie(
  domain: DomainReader,
  jwtSecret: string,
  customerIndex: number,
): Promise<{ cookie: string; customerId: string; phone: string }> {
  const phone = resolveCustomerPhoneForIndex(customerIndex)
  const customer = await domain.customerByPhone(phone)
  if (customer === null) {
    throw new ExtractionAccuracyCliError(
      `no seeded customer with phone ${phone} (index ${customerIndex}) — run \`ibx test seed\` (seed-homepage upserts SEED_CUSTOMERS)`,
    )
  }
  const cookie = cookieHeader(mintCustomerToken({ customerId: customer.id, jwtSecret }))
  return { cookie, customerId: customer.id, phone }
}

/**
 * Ops-history clear (Redis) — see accuracy-runner.ts's isolation note.
 * Review MAJOR (#263) follow-up: this NO LONGER swallows a failure. It
 * warns loudly exactly once (for the human reading progress output — 20
 * identical per-case warnings would drown the log) AND RE-THROWS every
 * time, so the runner's own try/catch attributes it as an
 * `IsolationFailure` per case, which `computeAccuracyReport` turns into a
 * hard `isolation_degraded` problem (`report.ok: false`). A silently-
 * degraded run must never read as trustworthy — the exact live gap a
 * missing `REDIS_URL` produced in an earlier round of this PR (see the
 * PR report's "confirmed-casual" contamination finding).
 *
 * FE-T10 live-caught (money-tier corpora): a REQUEST_CONFIRMATION a case
 * parks survives in the claustrum Session (`claustrum:session:admin:<id>`,
 * apps/api/src/claustrum-bootstrap.ts's `claustrumSessionKey`) — a SEPARATE
 * Redis key from the chat-history one above. `order.status.transition`'s
 * cases never surfaced this (none of its 20 cases park), but EVERY
 * `payment.refund.issue` case does (the BKL-085 UNTRUSTED-taint overlay
 * forces REQUEST_CONFIRMATION for every sub-escalate amount) — so without
 * ALSO clearing this key, the ops confirmation-matcher's pt-BR affirmative
 * lexicon (`ops-system-channel.ts` — "pode", "ok", "isso", "claro", "manda",
 * "beleza"...) can silently resolve the NEXT case's ordinary utterance as a
 * "confirm" of the PRIOR case's still-parked refund (live-caught: "pode
 * devolver 40 reais...?" executed a DIFFERENT, earlier-parked amount).
 * Cleared here too so any confirmation-parking capability (this ticket's
 * money-tier precedent T11-14 reuses) gets the SAME isolation guarantee
 * `order.status.transition` happened to get for free.
 */
export function createOpsHistoryClearer(
  onProgress: (line: string) => void,
): (staffId: string) => Promise<void> {
  let warned = false
  const warnOnce = (detail: string): void => {
    if (warned) return
    warned = true
    onProgress(`⚠ ops-history clear degraded (isolation NOT guaranteed): ${detail}`)
  }
  return async (staffId: string) => {
    try {
      const { getRedisClient, rk } = await import("@ibatexas/tools")
      const redis = await getRedisClient()
      await redis.del(rk(`ops:chat:history:${staffId}`))
      await redis.del(rk(`claustrum:session:admin:${staffId}`))
    } catch (err) {
      warnOnce((err as Error).message)
      throw err
    }
  }
}

/**
 * Customer/web-plane session clear (Redis) — FE-T12, the SAME loud
 * warn-once + re-throw pattern as `createOpsHistoryClearer` (never silently
 * swallowed; the caller attributes it as an `isolation_degraded` problem).
 *
 * Clears BOTH keys the web plane scopes by `sessionId` (NOT `customerId` —
 * see accuracy-runner.ts's module header): `session:<sessionId>` (the
 * conversation-history list, apps/api/src/session/store.ts) and
 * `claustrum:session:<sessionId>` (the parked/deferred envelope,
 * apps/api/src/claustrum-bootstrap.ts's `claustrumSessionKey`) — the
 * customer-plane analog of FE-T10's ops `claustrum:session:admin:<id>` fix:
 * without the second key, a REQUEST_CONFIRMATION `order.checkout.create`/
 * `order.cancel` case parks would survive into the NEXT case, whose
 * ordinary utterance could be lexically misread as a confirmation of the
 * PRIOR case's still-parked mutation — the exact hazard this seam closes.
 */
export function createCustomerHistoryClearer(
  onProgress: (line: string) => void,
): (sessionId: string) => Promise<void> {
  let warned = false
  const warnOnce = (detail: string): void => {
    if (warned) return
    warned = true
    onProgress(`⚠ customer-chat history clear degraded (isolation NOT guaranteed): ${detail}`)
  }
  return async (sessionId: string) => {
    try {
      const { getRedisClient, rk } = await import("@ibatexas/tools")
      const redis = await getRedisClient()
      await redis.del(rk(`session:${sessionId}`))
      await redis.del(rk(`claustrum:session:${sessionId}`))
    } catch (err) {
      warnOnce((err as Error).message)
      throw err
    }
  }
}

/**
 * FE-T12 — the `beforeCase` hook `driveExtractionCorpusOverCustomerChat`
 * calls per case (accuracy-runner.ts). Dispatches by CAPABILITY: only
 * `order.checkout.create` needs a seeded cart (`requireCartItemsForCheckout`/
 * `requireSlotsFilledForCheckout`, pack-orders/src/policies.ts) — every
 * OTHER capability sharing this driver is a no-op here, since the hook
 * receives every case's capability regardless of which file it came from.
 * `targetCentavosForCase` (seed-checkout-cart.ts) maps the 6 named
 * money-boundary case ids to their specific band-straddling total and
 * everything else to the modest R$50,00 default.
 */
export function createCheckoutCartSeeder(
  onProgress: (line: string) => void,
): (sessionId: string, kase: { id: string }, capability: string) => Promise<void> {
  return async (sessionId, kase, capability) => {
    if (capability !== "order.checkout.create") return
    await seedCheckoutCart({
      sessionId,
      targetCentavos: targetCentavosForCase(kase.id),
      onProgress,
    })
  }
}

/**
 * FE-T14 (team-lead ruling: the variantId-bridge live-calibration fix,
 * "item-cart seeder... approved") — `order.item.update`/`order.item.remove`'s
 * sibling seeder, same `beforeCase` capability-dispatch shape as
 * `createCheckoutCartSeeder`. Seeds the SAME fixed 4-item cart
 * (`seed-item-cart.ts`'s `ITEM_CART_PLAN`) for every case regardless of
 * which of the corpus's 4 casual item names (coca/guaraná/hambúrguer/batata
 * frita) that specific case references — see that module's header for the
 * catalog-mapping rationale. Re-seeds a FRESH cart per case (mirroring the
 * checkout seeder's per-case freshness): `driveExtractionCorpusOverCustomerChat`
 * mints a new sessionId per case, and the cart↔session Redis binding means
 * an un-reseeded case would simply find no active cart at all.
 */
export function createItemCartSeeder(
  onProgress: (line: string) => void,
): (sessionId: string, kase: { id: string }, capability: string) => Promise<void> {
  return async (sessionId, _kase, capability) => {
    if (capability !== "order.item.update" && capability !== "order.item.remove") return
    await seedItemCart({ sessionId, onProgress })
  }
}

/**
 * FE-T12 (team-lead ruling: "fix the cancel money-boundary seeding, don't
 * defer — those 2 cases are the live assertion of the cancel ladder's
 * ESCALATE arm, a core AC") — `order.cancel`'s sibling seeder, same
 * `beforeCase` capability-dispatch shape as `createCheckoutCartSeeder`.
 * `order.cancel`'s auto-resolve targets the customer's chronologically
 * MOST-RECENT order (resolve-and-assemble.ts's `resolveOrderId`), so this
 * seeds a FRESH order before EVERY `order.cancel` case — never just once —
 * exactly mirroring the checkout cart seeder's per-case freshness. Ignores
 * `sessionId` entirely (unlike the checkout seeder): the cancel precondition
 * is keyed by CUSTOMER, not by session (see seed-cancelable-order.ts's own
 * header for why a PAID seed via seed-refundable-order.ts is exact-outcome-
 * safe for every case, including the ones the corpus's SETUP notes describe
 * as needing an unpaid order).
 *
 * FE-T14 amend backfill (live-calibration methodology fix, caught before the
 * scoped rerun that exposed it): `order.amend.add_item` shares this EXACT
 * same auto-resolve-to-most-recent-order path (`ORDER_AUTORESOLVE_KINDS`,
 * resolve-and-assemble.ts) — unlike `update_qty`/`remove_item`, add_item
 * never matches against EXISTING line items (it resolves the NEW item via
 * `resolveProductForItem` alone), so it needs only "an order exists," not
 * `seed-item-order.ts`'s heavier real-Medusa-order-with-known-items fixture.
 * Dispatching it through this lighter seeder (rather than leaving it
 * unseeded, or over-provisioning via `createItemOrderSeeder`) mirrors
 * `order.cancel`'s own precondition exactly, since both share the same
 * resolver path.
 */
export function createCancelOrderSeeder(
  customerId: string,
  onProgress: (line: string) => void,
): (sessionId: string, kase: { id: string }, capability: string) => Promise<void> {
  return async (_sessionId, kase, capability) => {
    if (capability !== "order.cancel" && capability !== "order.amend.add_item") return
    await seedCancelableOrder({
      customerId,
      targetCentavos: targetCentavosForCancelCase(kase.id),
      onProgress,
    })
  }
}

/**
 * FE-T14 (the variantId-bridge fix's "calibrate the 4 dependent files
 * live") — `order.amend.update_qty`/`order.amend.remove_item`'s sibling
 * seeder. UNLIKE `createCancelOrderSeeder`'s reuse of the existing
 * projection-only WS9 fixture (order.cancel's auto-resolve only needs the
 * order's EXISTENCE), these two capabilities' `resolveOrderLineItem` fetches
 * the order straight from MEDUSA for its line items — `seed-item-order.ts`
 * creates a REAL Medusa order (draft-order admin flow) carrying the SAME
 * 4-item vocabulary `createItemCartSeeder` seeds into carts, then writes the
 * matching `order_projections` row directly (see that module's header for
 * the full two-halves rationale). Same "fresh order before EVERY case"
 * posture as `createCancelOrderSeeder` (a case may mutate/remove a line,
 * so reusing one order across cases would let case N's mutation bleed into
 * case N+1's matching) — customer-keyed, ignores `sessionId` entirely.
 */
export function createItemOrderSeeder(
  customerId: string,
  onProgress: (line: string) => void,
): (sessionId: string, kase: { id: string }, capability: string) => Promise<void> {
  return async (_sessionId, _kase, capability) => {
    if (capability !== "order.amend.update_qty" && capability !== "order.amend.remove_item") return
    await seedItemOrder({ customerId, onProgress })
  }
}

/**
 * Composes N `beforeCase` hooks into one, each dispatching by capability
 * (a no-op for a capability it doesn't own) — `driveExtractionCorpusOverCustomerChat`
 * takes exactly ONE `beforeCase`, so a corpus mixing capabilities (this
 * ticket's order.checkout.create + order.cancel) needs its per-capability
 * seeders run in sequence, not just the last one wired in and the others
 * silently dropped.
 */
export function composeBeforeCase(
  ...hooks: ReadonlyArray<(sessionId: string, kase: { id: string }, capability: string) => Promise<void>>
): (sessionId: string, kase: { id: string }, capability: string) => Promise<void> {
  return async (sessionId, kase, capability) => {
    for (const hook of hooks) {
      await hook(sessionId, kase, capability)
    }
  }
}

// ── Opt-in customer-plane token-budget reset (team-lead budget ruling (b)) ──
//
// See accuracy-runner.ts's "KNOWN HARNESS FAILURE SIGNATURE — token_budget.
// exhausted" note: the F4 session token-budget guard
// (compose-policy-packs.ts's sessionTokenBudgetGuard) meters
// `llm:tokens:<channel>:<customerId>` (resolve-and-assemble.ts's
// sessionTokenKey) — keyed by customerId, not sessionId — so it accumulates
// across an ENTIRE run regardless of this driver's per-case session
// rotation. Live-caught: the seeded calibration customer's counter read
// 184,892 against the 100,000 default budget after ~90 turns.
//
// This is harness-state isolation on the EPHEMERAL test stack's own Redis —
// NOT a governance weakening. The guard itself, its threshold
// (SESSION_TOKEN_BUDGET), and every production code path are completely
// untouched; this clears the harness's own accumulated test-usage between
// independent calibration RUNS, the same category of thing
// createCustomerHistoryClearer already does for conversation state, just a
// different key. Constraints (team-lead ruling):
//   1. DELs ONLY sessionTokenKey(channel, <calibration customer>) via the
//      SAME injected getRedisClient/rk mechanism the history clearers use.
//   2. BETWEEN PASSES only, never mid-pass — called once, before
//      driveExtractionCorpusOverCustomerChat starts, never from inside its
//      per-case loop. If a single pass exhausts the budget on its own,
//      that's a report-and-stop signal, never grounds for a mid-pass DEL.
//   3. Opt-in ONLY (default false) — `RunExtractionAccuracyCliOptions.
//      resetCustomerTokenBudget` / the CLI's `--reset-customer-token-budget`
//      flag. `shouldResetCustomerTokenBudget` is the single, pure,
//      unit-tested decision point every caller goes through.
//   4. Logs loudly every time it fires (never a warn-once suppression — this
//      is a deliberate, opt-in action a human chose to take, not a
//      degraded-isolation failure to avoid spamming).

/** Pure decision: does THIS run reset the counter? Opt-in only — default false/undefined. */
export function shouldResetCustomerTokenBudget(
  options: Pick<RunExtractionAccuracyCliOptions, "resetCustomerTokenBudget">,
): boolean {
  return options.resetCustomerTokenBudget === true
}

/**
 * DELs the ONE customer-plane token-budget key for `customerId` on
 * `channel` (the customer/web chat route always posts `channel: "web"` —
 * see accuracy-runner.ts's `postCustomerChat`). Byte-for-byte mirrors
 * `sessionTokenKey(channel, customerId)`'s key shape
 * (resolve-and-assemble.ts) via the SAME `rk()` helper — duplicated rather
 * than imported (apps/api is out of bounds for this package, check-bypass
 * leg 7). Called AT MOST ONCE per CLI invocation, before driving — never
 * per-case.
 */
export async function resetCustomerTokenBudgetCounter(
  customerId: string,
  channel: string,
  onProgress: (line: string) => void,
): Promise<void> {
  const { getRedisClient, rk } = await import("@ibatexas/tools")
  const redis = await getRedisClient()
  const key = rk(`llm:tokens:${channel}:${customerId}`)
  const deleted = await redis.del(key)
  onProgress(
    `⚠ --reset-customer-token-budget: cleared token-budget counter for customer ${customerId} ` +
      `on channel "${channel}" (${deleted > 0 ? "counter existed" : "counter was already absent"}). ` +
      "Harness-state isolation on this ephemeral stack's own Redis between passes — the guard, its " +
      "threshold, and every production code path are untouched.",
  )
}

/**
 * The full live run: load env + corpus, split by each file's declared
 * `plane`, resolve the seeded staff/customer as needed, drive each half over
 * its own route, merge, score. Callers needing the baseline-regression
 * VERDICT layer `verifyAccuracyBaseline` on top of the returned `report`
 * (mirrors `runJourneyCoverage`'s split between the report and the CLI's own
 * `--verify-file` handling).
 */
export async function runExtractionAccuracyCli(
  options: RunExtractionAccuracyCliOptions = {},
): Promise<ExtractionAccuracyCliResult> {
  const onProgress = options.onProgress ?? (() => undefined)

  if (options.envFile !== undefined) {
    const loaded = loadTestEnv(options.envFile)
    onProgress(
      `env: ${options.envFile} (${loaded.injected.length} injected, ${loaded.overridden.length} overridden, ${loaded.identical.length} identical)`,
    )
  }

  const apiBaseUrl = options.apiBaseUrl ?? process.env["IBX_TEST_API_URL"] ?? "http://localhost:3001"
  const redactSecret = process.env["AUDIT_REDACT_SECRET"] ?? ""

  const corpus: ExtractionCorpusFile[] = await loadExtractionCorpus(options.corpusDir)
  onProgress(
    `corpus: ${corpus.length} file(s), ${corpus.reduce((n, f) => n + f.cases.length, 0)} case(s) total`,
  )

  // FE-T12 — split by the EXPLICIT per-file `plane` declaration (never
  // inferred). Each half only requires its OWN secret/seeded identity, so an
  // ops-only or customer-only corpus never demands a credential it doesn't
  // need (mirrors today's STAFF_JWT_SECRET-only requirement exactly).
  const opsFiles = corpus.filter((f) => f.plane === "ops")
  const customerFiles = corpus.filter((f) => f.plane === "customer")

  const domain = createDomainReader()
  const audit: AuditReader = createAuditReader()
  try {
    const results: AccuracyCaseResult[] = []
    const isolationFailures: IsolationFailure[] = []

    if (opsFiles.length > 0) {
      const staffJwtSecret = process.env["STAFF_JWT_SECRET"]
      if (staffJwtSecret === undefined || staffJwtSecret === "") {
        throw new ExtractionAccuracyCliError("STAFF_JWT_SECRET is missing from the env (.env.test)")
      }
      const { cookie, staffId } = await resolveStaffCookie(domain, staffJwtSecret)
      onProgress(`staff: resolved seeded ${ACCURACY_RUN_STAFF_PHONE} -> ${staffId}`)

      const clearHistory = createOpsHistoryClearer(onProgress)
      const ops = await driveExtractionCorpusOverOpsChat(opsFiles, {
        apiBaseUrl,
        staffCookie: cookie,
        staffId,
        audit,
        scope: { sessionIds: [hashedSessionId(`admin:${staffId}`, redactSecret)] },
        clearHistory,
        onProgress,
      })
      results.push(...ops.results)
      isolationFailures.push(...ops.isolationFailures)
    }

    if (customerFiles.length > 0) {
      const jwtSecret = process.env["JWT_SECRET"]
      if (jwtSecret === undefined || jwtSecret === "") {
        throw new ExtractionAccuracyCliError("JWT_SECRET is missing from the env (.env.test)")
      }
      const customerIndex = options.customerIndex ?? 0
      const { cookie, customerId, phone } = await resolveCustomerCookie(domain, jwtSecret, customerIndex)
      onProgress(`customer: resolved seeded ${phone} (index ${customerIndex})`)

      // Opt-in ONLY, BETWEEN passes, never mid-pass — see "Opt-in
      // customer-plane token-budget reset" above for the full rationale.
      if (shouldResetCustomerTokenBudget(options)) {
        await resetCustomerTokenBudgetCounter(customerId, "web", onProgress)
      }

      // FE-T12 (team-lead ruling, post-live-calibration review): a FRESH
      // sessionId is minted PER CASE by the driver itself
      // (`sessionIdFactory`, default `randomUUID` — accuracy-runner.ts's
      // "SESSION-PER-CASE ROTATION" note), never one id reused for the
      // whole run. This CLI only supplies the scope-derivation function —
      // the customer/web actor's sessionId rides the envelope UNPREFIXED
      // (apps/api/src/claustrum/ibatexas-planner.ts:
      // `actor: { sessionId: state.conversationId }`, which IS the raw web
      // session id) — unlike ops's `admin:<staffId>` prefix.
      const clearHistory = createCustomerHistoryClearer(onProgress)
      const beforeCase = composeBeforeCase(
        createCheckoutCartSeeder(onProgress),
        createCancelOrderSeeder(customerId, onProgress),
        createItemCartSeeder(onProgress),
        createItemOrderSeeder(customerId, onProgress),
      )
      const cust = await driveExtractionCorpusOverCustomerChat(customerFiles, {
        apiBaseUrl,
        customerCookie: cookie,
        audit,
        scopeForSession: (sessionId) => ({
          sessionIds: [hashedSessionId(sessionId, redactSecret)],
        }),
        clearHistory,
        beforeCase,
        onProgress,
      })
      results.push(...cust.results)
      isolationFailures.push(...cust.isolationFailures)
    }

    const computeOptions: ComputeAccuracyReportOptions = { results }
    if (options.waiversPath !== undefined) computeOptions.waiversPath = options.waiversPath
    if (options.quarantined !== undefined) computeOptions.quarantined = options.quarantined
    if (isolationFailures.length > 0) computeOptions.isolationFailures = isolationFailures
    const report = await computeAccuracyReport(computeOptions)

    return { report, results }
  } finally {
    await domain.close().catch(() => undefined)
    await audit.close().catch(() => undefined)
    // Live-caught (FE-T07 PR report): `bestEffortClearOpsHistory` lazily
    // creates a cached Redis client (@ibatexas/tools) that otherwise stays
    // open forever — the process never exits on its own (its event loop
    // stays alive on the dangling connection) even though the actual run
    // completed and printed its report. Closing it is always safe: a
    // no-op when no client was ever created.
    try {
      const { closeRedisClient } = await import("@ibatexas/tools")
      await closeRedisClient()
    } catch {
      /* best-effort */
    }
  }
}
