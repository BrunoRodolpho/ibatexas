// extraction/accuracy-cli.ts — `ibx journey extraction-accuracy` (FE-T07):
// the full live-run composition, mirroring `run-journey-cli.ts`'s
// relationship to the CLI (thin registration in packages/cli, all
// composition here) and `gates/coverage.ts`'s report/baseline shape.
//
// Steps: load `.env.test` -> resolve the ONE seeded staff row (SEED_STAFF,
// packages/domain/src/seed-constants.ts) -> mint its staff cookie -> load
// the extraction corpus -> drive every case over the ops-chat route
// (accuracy-runner.ts) -> score against expectPayload (accuracy.ts).
//
// Only `order.status.transition` (ops-plane) exists today — see
// accuracy-runner.ts's header for why a customer-plane drive path isn't
// built here yet.

import { createHash } from "node:crypto"
import { loadExtractionCorpus } from "./load.js"
import type { ExtractionCorpusFile } from "./schema.js"
import {
  computeAccuracyReport,
  type AccuracyCaseResult,
  type AccuracyReport,
  type ComputeAccuracyReportOptions,
} from "./accuracy.js"
import { driveExtractionCorpusOverOpsChat } from "./accuracy-runner.js"
import { createAuditReader, type AuditReader } from "../oracle/audit-reader.js"
import { createDomainReader, type DomainReader } from "../oracle/domain-reader.js"
import { loadTestEnv } from "../harness/test-env.js"
import { mintStaffToken, cookieHeader, type StaffRole } from "../clients/auth-fixture.js"

export class ExtractionAccuracyCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExtractionAccuracyCliError"
  }
}

/** The one seeded staff row every ops-chat drive authenticates as (packages/domain/src/seed-constants.ts). */
export const ACCURACY_RUN_STAFF_PHONE = "+5519900000900"

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

/** Best-effort ops-history clear (Redis) — see accuracy-runner.ts's isolation note. Never throws: a failure only costs the isolation guarantee, must never break the run. */
async function bestEffortClearOpsHistory(
  onProgress: (line: string) => void,
): Promise<(staffId: string) => Promise<void>> {
  let warned = false
  const warnOnce = (detail: string): void => {
    // Loud exactly ONCE (not per-case — 20 identical warnings would drown
    // the progress log) — live-caught gap: a silently-swallowed clear
    // degrades corpus isolation without any operator-visible signal (see
    // the PR report's "confirmed-casual" cross-case contamination finding,
    // caused by a missing REDIS_URL in an early run).
    if (warned) return
    warned = true
    onProgress(`⚠ ops-history clear degraded (isolation NOT guaranteed): ${detail}`)
  }
  try {
    const { getRedisClient, rk } = await import("@ibatexas/tools")
    return async (staffId: string) => {
      try {
        const redis = await getRedisClient()
        await redis.del(rk(`ops:chat:history:${staffId}`))
      } catch (err) {
        warnOnce((err as Error).message)
      }
    }
  } catch (err) {
    warnOnce((err as Error).message)
    return async () => undefined
  }
}

/**
 * The full live run: load env + corpus, resolve the seeded staff, drive
 * every corpus case over the ops-chat route, score it. Callers needing the
 * baseline-regression VERDICT layer `verifyAccuracyBaseline` on top of the
 * returned `report` (mirrors `runJourneyCoverage`'s split between the report
 * and the CLI's own `--verify-file` handling).
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
  const staffJwtSecret = process.env["STAFF_JWT_SECRET"]
  if (staffJwtSecret === undefined || staffJwtSecret === "") {
    throw new ExtractionAccuracyCliError("STAFF_JWT_SECRET is missing from the env (.env.test)")
  }

  const corpus: ExtractionCorpusFile[] = await loadExtractionCorpus(options.corpusDir)
  onProgress(
    `corpus: ${corpus.length} file(s), ${corpus.reduce((n, f) => n + f.cases.length, 0)} case(s) total`,
  )

  const domain = createDomainReader()
  const audit: AuditReader = createAuditReader()
  try {
    const { cookie, staffId } = await resolveStaffCookie(domain, staffJwtSecret)
    onProgress(`staff: resolved seeded ${ACCURACY_RUN_STAFF_PHONE} -> ${staffId}`)

    const clearHistory = await bestEffortClearOpsHistory(onProgress)
    const results = await driveExtractionCorpusOverOpsChat(corpus, {
      apiBaseUrl,
      staffCookie: cookie,
      staffId,
      audit,
      scope: { sessionIds: [hashedSessionId(`admin:${staffId}`, redactSecret)] },
      clearHistory,
      onProgress,
    })

    const computeOptions: ComputeAccuracyReportOptions = { results }
    if (options.waiversPath !== undefined) computeOptions.waiversPath = options.waiversPath
    if (options.quarantined !== undefined) computeOptions.quarantined = options.quarantined
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
