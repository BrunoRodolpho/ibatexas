// harness/sim-store.ts — T1b-5: the sim_runs / sim_results writer.
//
// Persistent run records joined to the audit ledger via sessionId — `ibx
// journey run` persists one sim_runs row per ATTEMPT plus one sim_results
// row per declared expects[] entry (reconciled by the T1b-1 gate). The
// hashed envelope/AuditRecord schemas are NEVER touched: sim_runs records
// the run's HASHED session-id namespaces (D-012 — the exact values the
// audit redactor stamps into intent_audit.session_id) so the run's kernel
// decisions are recoverable with a plain SQL join (SIM_RUN_DECISIONS_SQL).
//
// CONTAINMENT (oracle-grade separation): writes go through a DEDICATED
// writer role — ibx_sim_writer, INSERT/UPDATE on sim_* ONLY, provisioned by
// scripts/test-stack/create-sim-writer-role.sql — never through the
// read-only oracle role (T1a-9's RO containment stays intact: the oracle
// still cannot write anything, and the sim writer cannot read or touch any
// SUT table). `requireSimDatabaseUrl` is the single place writer code
// obtains its connection string: it refuses any URL whose user is not the
// sim-writer role, so the store can never be silently pointed at the
// migration/app role (which CAN write everything).

import pg from "pg"
import type { DecisionKind } from "@adjudicate/core"
import type { ReconciliationReport } from "../gates/reconciliation.js"
import type { JourneyExpect } from "../schema/journey.js"

// ── SIM_DATABASE_URL accessor (mirror of oracle-database-url.ts) ─────────────

/** The writer role pinned by scripts/test-stack/create-sim-writer-role.sql. */
export const SIM_DB_ROLE = "ibx_sim_writer"

/** Env var carrying the sim-writer connection string (.env.test). */
export const SIM_DATABASE_URL_ENV = "SIM_DATABASE_URL"

export class SimDatabaseUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SimDatabaseUrlError"
  }
}

/**
 * Returns SIM_DATABASE_URL after validating it names the dedicated sim-writer
 * role. Throws `SimDatabaseUrlError` when the var is missing, not a postgres
 * URL, or connects as any user other than `ibx_sim_writer`.
 */
export function requireSimDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env[SIM_DATABASE_URL_ENV]
  if (raw === undefined || raw === "") {
    throw new SimDatabaseUrlError(
      `${SIM_DATABASE_URL_ENV} is not set — the sim store only connects via the ` +
        `INSERT/UPDATE-on-sim_*-only ${SIM_DB_ROLE} role (see .env.test.example, ` +
        "provisioned by scripts/test-stack/provision-sim-writer-role.sh)",
    )
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new SimDatabaseUrlError(`${SIM_DATABASE_URL_ENV} is not a valid URL`)
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new SimDatabaseUrlError(
      `${SIM_DATABASE_URL_ENV} must be a postgresql:// URL (got protocol "${parsed.protocol}")`,
    )
  }

  const user = decodeURIComponent(parsed.username)
  if (user !== SIM_DB_ROLE) {
    throw new SimDatabaseUrlError(
      `${SIM_DATABASE_URL_ENV} must connect as the dedicated writer role "${SIM_DB_ROLE}" ` +
        `(got "${user}") — containment: the sim store is never allowed the app/migration ` +
        "role, and the read-only oracle role is never allowed writes",
    )
  }

  return raw
}

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface SimRunRow {
  /** The attempt's runId (uuid — the trace/report id). */
  runId: string
  journeyId: string
  /**
   * The attempt's audit-window start — the same instant the verify phase
   * scopes `since` to (runStartedAt, incl. its clock slack), so the
   * SIM_RUN_DECISIONS_SQL window reproduces the run's observed trail.
   */
  startedAt: Date
  finishedAt: Date
  pass: boolean
  /** Attempt ordinal within the k-loop (1-based). */
  attempt: number
  /** The SUT model pin the attempt ran against (ANTHROPIC_MODEL, DR-1). */
  modelId: string
  certifying: boolean
  costUsd: number
  driverTokens: { in: number; out: number }
  sutTokens: { in: number; out: number }
  /** The run's HASHED sessionId namespaces (D-012). */
  sessionIds: readonly string[]
}

export interface SimResultRow {
  /** Index into the journey's declared expects[] (file order, 0-based). */
  seq: number
  expectKind: string
  expectDecision: DecisionKind
  /** true iff the declared (kind, decision) tuple was observed in the run. */
  observed: boolean
  /**
   * The decision actually observed for expectKind: equals expectDecision
   * when observed; the divergent decision when the kind appeared with a
   * different one; null when the kind never appeared (or no reconciliation
   * ran — the attempt failed before the gate).
   */
  decisionObserved: DecisionKind | null
  /** intent_audit.intent_hash of the observed record (null when unobserved). */
  intentHash: string | null
}

/**
 * Map the journey's declared expects[] + the T1b-1 reconciliation report
 * into sim_results rows. Without a report (the attempt died before the
 * gate ran) every entry is recorded unobserved — the run row still lands,
 * so red attempts are queryable too.
 */
export function buildSimResults(
  expects: readonly JourneyExpect[],
  reconciliation?: ReconciliationReport,
): SimResultRow[] {
  return expects.map((expect, seq) => {
    const expectDecision = expect.decision as DecisionKind
    if (reconciliation === undefined) {
      return {
        seq,
        expectKind: expect.intentKind,
        expectDecision,
        observed: false,
        decisionObserved: null,
        intentHash: null,
      }
    }
    // reconciliation.expected is expects[] in file order (same indexing).
    const tally = reconciliation.expected[seq]
    const observed = tally !== undefined && tally.observedCount > 0
    // Prefer the record this entry EXPLAINED (tuple match); fall back to the
    // first same-kind record (divergent decision — e.g. expected EXECUTE,
    // observed REFUSE) so the divergence is queryable.
    const explaining = reconciliation.observed.find((o) => o.expectIndex === seq)
    const sameKind = explaining ?? reconciliation.observed.find((o) => o.intentKind === expect.intentKind)
    return {
      seq,
      expectKind: expect.intentKind,
      expectDecision,
      observed,
      decisionObserved: sameKind?.decision ?? null,
      intentHash: sameKind?.intentHash ?? null,
    }
  })
}

// ── The documented join (sessionId namespaces → the run's decisions) ─────────

/**
 * Given $1 = sim_runs.run_id, returns the run's kernel decisions from
 * intent_audit by joining through the HASHED session-id namespaces recorded
 * in sim_runs.session_ids, windowed to the attempt ([started_at,
 * finished_at] — the customer namespace accumulates rows across attempts;
 * the window cuts the trail to THIS run, mirroring the verify phase's
 * `since=runStartedAt` scope).
 */
export const SIM_RUN_DECISIONS_SQL = `
  SELECT a.kind AS intent_kind, a.decision_kind, a.intent_hash, a.recorded_at
    FROM sim_runs r
    JOIN intent_audit a
      ON a.session_id IN (SELECT jsonb_array_elements_text(r.session_ids))
     AND a.recorded_at >= r.started_at
     AND a.recorded_at <= r.finished_at
   WHERE r.run_id = $1
   ORDER BY a.recorded_at ASC
`

// ── Writer ───────────────────────────────────────────────────────────────────

/** Structural pg subset — tests may inject a double or their own pool. */
export interface SimQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>
}

export interface SimStore {
  /** INSERT the attempt's sim_runs row + its sim_results rows. */
  writeAttempt(args: {
    run: SimRunRow
    expects: readonly JourneyExpect[]
    reconciliation?: ReconciliationReport
  }): Promise<void>
  /** Ends the pool iff the store created it (injected pools are the caller's). */
  close(): Promise<void>
}

export interface CreateSimStoreOptions {
  /** Inject a pool/double (tests). Default: a pg Pool from `requireSimDatabaseUrl(env)`. */
  pool?: SimQueryable
  /** Env source for SIM_DATABASE_URL (default `process.env`). */
  env?: Record<string, string | undefined>
}

export function createSimStore(opts: CreateSimStoreOptions = {}): SimStore {
  // Containment: the default path validates the role via requireSimDatabaseUrl.
  const ownedPool: pg.Pool | undefined =
    opts.pool === undefined
      ? new pg.Pool({ connectionString: requireSimDatabaseUrl(opts.env), max: 2 })
      : undefined
  const pool: SimQueryable = opts.pool ?? (ownedPool as SimQueryable)

  async function writeAttempt(args: {
    run: SimRunRow
    expects: readonly JourneyExpect[]
    reconciliation?: ReconciliationReport
  }): Promise<void> {
    const { run } = args
    await pool.query(
      `INSERT INTO sim_runs (
         run_id, journey_id, started_at, finished_at, pass, attempt,
         model_id, certifying, cost_usd,
         driver_tokens_in, driver_tokens_out, sut_tokens_in, sut_tokens_out,
         session_ids
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [
        run.runId,
        run.journeyId,
        run.startedAt.toISOString(),
        run.finishedAt.toISOString(),
        run.pass,
        run.attempt,
        run.modelId,
        run.certifying,
        run.costUsd.toFixed(6),
        run.driverTokens.in,
        run.driverTokens.out,
        run.sutTokens.in,
        run.sutTokens.out,
        JSON.stringify([...run.sessionIds]),
      ],
    )

    const results = buildSimResults(args.expects, args.reconciliation)
    for (const r of results) {
      await pool.query(
        `INSERT INTO sim_results (
           run_id, seq, expect_kind, expect_decision, observed,
           decision_observed, intent_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [run.runId, r.seq, r.expectKind, r.expectDecision, r.observed, r.decisionObserved, r.intentHash],
      )
    }
  }

  async function close(): Promise<void> {
    if (ownedPool !== undefined) await ownedPool.end()
  }

  return { writeAttempt, close }
}
