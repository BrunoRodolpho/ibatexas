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

import { createHash, randomUUID } from "node:crypto"
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
 * The one seeded customer row every customer-chat drive authenticates as
 * (FE-T12). A literal duplicate of `SEED_CUSTOMERS[0].phone`
 * (packages/domain/src/seed-constants.ts) — NOT an import — mirroring
 * `ACCURACY_RUN_STAFF_PHONE`'s own convention: `packages/domain`'s public
 * surface (`src/index.ts`) does not re-export `seed-constants.ts`, so every
 * consumer outside `packages/domain` duplicates the value by hand rather
 * than reaching past the package boundary for an internal module.
 */
export const ACCURACY_RUN_CUSTOMER_PHONE = "+5519900000001"

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
): Promise<{ cookie: string; customerId: string }> {
  const customer = await domain.customerByPhone(ACCURACY_RUN_CUSTOMER_PHONE)
  if (customer === null) {
    throw new ExtractionAccuracyCliError(
      `no seeded customer with phone ${ACCURACY_RUN_CUSTOMER_PHONE} — run \`ibx test seed\` (seed-homepage upserts SEED_CUSTOMERS)`,
    )
  }
  const cookie = cookieHeader(mintCustomerToken({ customerId: customer.id, jwtSecret }))
  return { cookie, customerId: customer.id }
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
      const { cookie } = await resolveCustomerCookie(domain, jwtSecret)
      // ONE reused sessionId for the whole customer-plane run (FE-T12 —
      // "structure for reuse", mirrors the ops driver's single reused
      // admin:<staffId> identity). The customer/web actor's sessionId rides
      // the envelope UNPREFIXED (apps/api/src/claustrum/ibatexas-planner.ts:
      // `actor: { sessionId: state.conversationId }`, which IS the raw web
      // session id) — unlike ops's `admin:<staffId>` prefix.
      const sessionId = randomUUID()
      onProgress(
        `customer: resolved seeded ${ACCURACY_RUN_CUSTOMER_PHONE}, session ${sessionId}`,
      )

      const clearHistory = createCustomerHistoryClearer(onProgress)
      const cust = await driveExtractionCorpusOverCustomerChat(customerFiles, {
        apiBaseUrl,
        customerCookie: cookie,
        sessionId,
        audit,
        scope: { sessionIds: [hashedSessionId(sessionId, redactSecret)] },
        clearHistory,
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
