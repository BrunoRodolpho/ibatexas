// oracle/audit-reader.ts — read-only AuditReader over `intent_audit` (T1a-7).
//
// The deterministic oracle's view of the kernel's governance trail. Reads go
// EXCLUSIVELY through the SELECT-only `ibx_oracle_ro` role (T1a-9): the
// default factory path builds its pg Pool from `requireOracleDatabaseUrl()`,
// which refuses any URL not connecting as that role — the oracle is
// structurally incapable of mutating SUT state.
//
// Row → AuditRecord conversion reuses `rowToRecord` from
// `@adjudicate/audit-postgres` (the canonical converter, incl. the v1–v5
// version dispatch — P0-2's precedent in apps/api/src/claustrum/
// audit-read-paths.ts). Only the pg-driver normalization (TIMESTAMPTZ → ISO
// string, parsed JSONB → JSON text) is local, because journeys can never
// import apps/api code (check-bypass leg 7). Tamper-evidence comes from
// `verifyAuditRecord` (@adjudicate/core) via `verifyFetchedRecords`.
//
// ── Run-sessionId namespace (binding convention — T1a-13/T1b-1 consume it) ──
//
// Every journey run is identified by a `runId`, and the harness RECORDS every
// sessionId the run touches into the run's session set:
//
//   - chat acts    → the SUT mints the conversation handle (e.g.
//                    `web:sess-<uuid>`); the ChatClient captures it from the
//                    session-secret exchange and the harness records it.
//   - http acts    → the route gateways' actor convention: user-principal
//                    envelopes carry `actor.sessionId = customerId` (staff
//                    routes their staff session handle); the harness records
//                    the identities it authenticated as.
//   - harness-minted identifiers (Phase-3 trigger acts etc.) embed the run
//                    namespace prefix `jrun:<runId>:` (see
//                    `runNamespacePrefix`) so they are prefix-scopable
//                    without recording.
//
// A scope is the union: explicit sessionId set ∪ optional prefix. The reader
// REFUSES unscoped reads (`AuditReaderScopeError`) — rows outside the run's
// namespace are invisible by construction, so concurrent runs and historical
// production rows can never leak into a journey's assertions.

import pg from "pg"
import {
  rowToRecord,
  type IntentAuditRow,
} from "@adjudicate/audit-postgres"
import {
  sha256Canonical,
  verifyAuditRecord,
  type AuditRecord,
  type DecisionKind,
} from "@adjudicate/core"
import { requireOracleDatabaseUrl } from "./oracle-database-url.js"

// ── Run-sessionId namespace ──────────────────────────────────────────────────

/** Prefix marker for harness-minted run-namespaced sessionIds. */
export const RUN_SESSION_NAMESPACE = "jrun:"

/**
 * The run's sessionId namespace prefix: `jrun:<runId>:`. Harness-minted
 * identifiers (never SUT-minted chat handles — those are recorded explicitly)
 * embed this prefix so a single `sessionIdPrefix` scopes them all.
 */
export function runNamespacePrefix(runId: string): string {
  if (runId.length === 0) throw new AuditReaderScopeError("runId must be non-empty")
  return `${RUN_SESSION_NAMESPACE}${runId}:`
}

/**
 * Scope of one journey run: the explicit sessionIds the harness recorded
 * for the run, and/or the run's namespace prefix. At least one is required —
 * an unscoped `intent_audit` read is structurally impossible.
 */
export interface RunSessionScope {
  /** Explicit sessionIds recorded by the harness for this run. */
  sessionIds?: readonly string[]
  /** Run-namespace prefix (e.g. `runNamespacePrefix(runId)`), matched as `LIKE 'prefix%'`. */
  sessionIdPrefix?: string
}

export class AuditReaderScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuditReaderScopeError"
  }
}

function assertScoped(scope: RunSessionScope): void {
  const hasIds = scope.sessionIds !== undefined && scope.sessionIds.length > 0
  const hasPrefix = scope.sessionIdPrefix !== undefined && scope.sessionIdPrefix.length > 0
  if (!hasIds && !hasPrefix) {
    throw new AuditReaderScopeError(
      "AuditReader requires a run-scoped sessionId namespace: pass sessionIds " +
        "(the run's recorded session set) and/or sessionIdPrefix " +
        "(runNamespacePrefix(runId)) — unscoped intent_audit reads are forbidden",
    )
  }
}

/** Escape LIKE metacharacters so a prefix is always a literal prefix match. */
function likePrefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

// ── Reader surface ───────────────────────────────────────────────────────────

export interface FetchAuditRecordsOptions {
  /** Filter on the envelope's intent kind (`intent_audit.kind`). */
  intentKind?: string
  /** Filter on the kernel decision kind (`intent_audit.decision_kind`). */
  decision?: DecisionKind
  /** Inclusive lower bound on `recorded_at`. */
  since?: Date | string
  /** Inclusive upper bound on `recorded_at`. */
  until?: Date | string
  /** Row cap for this fetch (≤ the reader's maxRows, default 500). */
  limit?: number
}

/** Structural pg.Pool subset — tests may inject a double or their own pool. */
export interface OracleQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>
}

export interface AuditReader {
  /**
   * Fetch the run's audit trail (chronological: `recorded_at ASC, id ASC` —
   * trajectory order) as canonical `AuditRecord`s via the package's
   * `rowToRecord`. Rows outside the scope's namespace are invisible.
   */
  fetchRecords(scope: RunSessionScope, opts?: FetchAuditRecordsOptions): Promise<AuditRecord[]>
  /** Ends the pool iff the reader created it (injected pools are the caller's). */
  close(): Promise<void>
}

export interface CreateAuditReaderOptions {
  /** Inject a pool/double (tests). Default: a pg Pool from `requireOracleDatabaseUrl(env)`. */
  pool?: OracleQueryable
  /** Env source for ORACLE_DATABASE_URL (default `process.env`). */
  env?: Record<string, string | undefined>
  /** Hard row cap per fetch (default 500 — the P0-2 replay-cap precedent). */
  maxRows?: number
}

// ── pg-driver row normalization (rowToRecord expects the WRITER shape) ───────

// Full column set incl. metadata_jsonb (v5) — mirrors P0-2's lossless SELECT.
const AUDIT_SELECT_COLUMNS = [
  "intent_hash",
  "session_id",
  "kind",
  "principal",
  "taint",
  "decision_kind",
  "refusal_kind",
  "refusal_code",
  "decision_basis",
  "resource_version",
  "envelope_jsonb",
  "decision_jsonb",
  "recorded_at",
  "duration_ms",
  "partition_month",
  "record_version",
  "plan_jsonb",
  "nonce",
  "supersedes_jsonb",
  "kernel_identity_jsonb",
  "policy_version",
  "kernel_version",
  "audit_hash",
  "signature_jsonb",
].join(", ")

const DEFAULT_MAX_ROWS = 500

/**
 * What the pg driver hands back for one row: TIMESTAMPTZ as `Date` (or
 * string), JSONB as already-parsed values. `rowToRecord` expects the writer
 * shape (ISO string + pre-serialized JSON text), so normalize first.
 */
type RawAuditRow = Omit<
  IntentAuditRow,
  | "recorded_at"
  | "envelope_jsonb"
  | "decision_jsonb"
  | "plan_jsonb"
  | "supersedes_jsonb"
  | "kernel_identity_jsonb"
  | "signature_jsonb"
  | "metadata_jsonb"
> & {
  readonly recorded_at: string | Date
  readonly envelope_jsonb: unknown
  readonly decision_jsonb: unknown
  readonly plan_jsonb: unknown
  readonly supersedes_jsonb: unknown
  readonly kernel_identity_jsonb: unknown
  readonly signature_jsonb: unknown
  readonly metadata_jsonb?: unknown
}

function jsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === "string" ? value : JSON.stringify(value)
}

function isoTimestamp(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`intent_audit.recorded_at is not a parseable timestamp: ${value}`)
  }
  return parsed.toISOString()
}

function toIntentAuditRow(raw: RawAuditRow): IntentAuditRow {
  return {
    ...raw,
    recorded_at: isoTimestamp(raw.recorded_at),
    // NOT NULL columns never reach the null branch on a schema-conformant row.
    envelope_jsonb: jsonText(raw.envelope_jsonb) ?? "null",
    decision_jsonb: jsonText(raw.decision_jsonb) ?? "null",
    plan_jsonb: jsonText(raw.plan_jsonb),
    supersedes_jsonb: jsonText(raw.supersedes_jsonb),
    kernel_identity_jsonb: jsonText(raw.kernel_identity_jsonb),
    signature_jsonb: jsonText(raw.signature_jsonb),
    metadata_jsonb: jsonText(raw.metadata_jsonb),
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createAuditReader(opts: CreateAuditReaderOptions = {}): AuditReader {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS
  // Containment: the default path validates the role via requireOracleDatabaseUrl.
  const ownedPool: pg.Pool | undefined =
    opts.pool === undefined
      ? new pg.Pool({ connectionString: requireOracleDatabaseUrl(opts.env), max: 4 })
      : undefined
  const pool: OracleQueryable = opts.pool ?? (ownedPool as OracleQueryable)

  async function fetchRecords(
    scope: RunSessionScope,
    fetchOpts: FetchAuditRecordsOptions = {},
  ): Promise<AuditRecord[]> {
    assertScoped(scope)

    const params: unknown[] = []
    const scopeClauses: string[] = []
    if (scope.sessionIds !== undefined && scope.sessionIds.length > 0) {
      params.push([...scope.sessionIds])
      scopeClauses.push(`session_id = ANY($${params.length})`)
    }
    if (scope.sessionIdPrefix !== undefined && scope.sessionIdPrefix.length > 0) {
      params.push(likePrefixPattern(scope.sessionIdPrefix))
      scopeClauses.push(`session_id LIKE $${params.length} ESCAPE '\\'`)
    }
    const where: string[] = [`(${scopeClauses.join(" OR ")})`]

    if (fetchOpts.intentKind !== undefined) {
      params.push(fetchOpts.intentKind)
      where.push(`kind = $${params.length}`)
    }
    if (fetchOpts.decision !== undefined) {
      params.push(fetchOpts.decision)
      where.push(`decision_kind = $${params.length}`)
    }
    if (fetchOpts.since !== undefined) {
      params.push(fetchOpts.since instanceof Date ? fetchOpts.since.toISOString() : fetchOpts.since)
      where.push(`recorded_at >= $${params.length}`)
    }
    if (fetchOpts.until !== undefined) {
      params.push(fetchOpts.until instanceof Date ? fetchOpts.until.toISOString() : fetchOpts.until)
      where.push(`recorded_at <= $${params.length}`)
    }
    params.push(Math.max(1, Math.min(fetchOpts.limit ?? maxRows, maxRows)))
    const limitParam = `$${params.length}`

    const sql =
      `SELECT ${AUDIT_SELECT_COLUMNS} FROM intent_audit ` +
      `WHERE ${where.join(" AND ")} ` +
      `ORDER BY recorded_at ASC, id ASC LIMIT ${limitParam}`

    const result = await pool.query(sql, params)
    return (result.rows as RawAuditRow[]).map((raw) => rowToRecord(toIntentAuditRow(raw)))
  }

  return {
    fetchRecords,
    async close(): Promise<void> {
      await ownedPool?.end()
    },
  }
}

// ── Tamper-evidence (invariant `audit.record.verified`) ─────────────────────

export interface AuditVerificationFailure {
  intentHash: string
  intentKind: string
  at: string
  reason: "tampered" | "envelope_intent_mismatch" | "missing_hash"
  /** Re-derived hash (absent for `missing_hash`). */
  derived?: string
  /** Stored hash (absent for `missing_hash`). */
  stored?: string
}

export interface AuditVerificationReport {
  ok: boolean
  total: number
  /** Records whose tamper-evident hash verified intact. */
  verifiedCount: number
  /**
   * Records whose envelope was PII-redacted by the audit sink (actor.sessionId
   * carries the `hashed:` sentinel) and whose post-redaction auditHash verified
   * intact (T1a-13 — see `redactionAware`). Counted separately from
   * `verifiedCount`; both are passes.
   */
  redactedVerifiedCount: number
  /** Pre-v4 records with no auditHash (failures unless `allowMissingHash`). */
  missingHashCount: number
  failures: AuditVerificationFailure[]
}

export interface VerifyFetchedRecordsOptions {
  /**
   * Tolerate pre-v4 records (no auditHash). Default false — the journeys SUT
   * writes v5 records, so a missing hash on a run-scoped row is itself a
   * red flag and fails the invariant.
   */
  allowMissingHash?: boolean
  /**
   * Default true. The SUT's audit sink REDACTS every envelope actor.sessionId
   * (salted hash, `hashed:` sentinel — packages/audit-sink/audit-redactor.ts)
   * and RECOMPUTES the record's auditHash post-redaction. Such records can
   * never pass `verifyAuditRecord`'s envelope→intentHash self-consistency leg
   * (the intentHash was derived from the UN-redacted envelope — by design),
   * but their whole-record auditHash still proves tamper-evidence. When set,
   * an `envelope_intent_mismatch` on a sentinel-redacted envelope falls back
   * to the auditHash check (the exact strip-and-hash `verifyAuditRecord`
   * performs); unredacted records must still fully verify.
   */
  redactionAware?: boolean
}

/** The audit redactor's sentinel prefix on a redacted actor.sessionId. */
const REDACTION_SENTINEL = "hashed:"

function isRedactedEnvelope(record: AuditRecord): boolean {
  const sessionId = (record.envelope as { actor?: { sessionId?: unknown } }).actor?.sessionId
  return typeof sessionId === "string" && sessionId.startsWith(REDACTION_SENTINEL)
}

/**
 * The whole-record auditHash leg of `verifyAuditRecord`, standalone — strips
 * auditHash + signature + metadata exactly as the kernel does (audit.ts) and
 * compares the canonical sha256. Used for the redaction-aware fallback.
 */
function auditHashVerifies(record: AuditRecord): boolean | null {
  const { auditHash, signature: _signature, metadata: _metadata, ...rest } =
    record as AuditRecord & { signature?: unknown; metadata?: unknown }
  if (auditHash === undefined) return null
  return sha256Canonical(rest) === auditHash
}

/**
 * Run `verifyAuditRecord` (@adjudicate/core — the canonical tamper-evidence
 * check) over a fetched trail. Backs the `audit.record.verified` invariant:
 * every record in the run's namespace must verify intact (redaction-aware by
 * default — see `VerifyFetchedRecordsOptions.redactionAware`).
 */
export function verifyFetchedRecords(
  records: readonly AuditRecord[],
  opts: VerifyFetchedRecordsOptions = {},
): AuditVerificationReport {
  const redactionAware = opts.redactionAware ?? true
  const failures: AuditVerificationFailure[] = []
  let verifiedCount = 0
  let redactedVerifiedCount = 0
  let missingHashCount = 0

  for (const record of records) {
    const verification = verifyAuditRecord(record)
    if (verification.verified === true) {
      verifiedCount += 1
      continue
    }
    if (verification.verified === null) {
      missingHashCount += 1
      if (opts.allowMissingHash !== true) {
        failures.push({
          intentHash: record.intentHash,
          intentKind: record.envelope.kind,
          at: record.at,
          reason: "missing_hash",
        })
      }
      continue
    }
    // Redaction-aware fallback: a sentinel-redacted envelope is EXPECTED to
    // fail intentHash self-consistency; tamper-evidence is the post-redaction
    // auditHash, which the redactor maintains.
    if (
      redactionAware &&
      verification.reason === "envelope_intent_mismatch" &&
      isRedactedEnvelope(record) &&
      auditHashVerifies(record) === true
    ) {
      redactedVerifiedCount += 1
      continue
    }
    failures.push({
      intentHash: record.intentHash,
      intentKind: record.envelope.kind,
      at: record.at,
      reason: verification.reason,
      derived: verification.derived,
      stored: verification.stored,
    })
  }

  return {
    ok: failures.length === 0,
    total: records.length,
    verifiedCount,
    redactedVerifiedCount,
    missingHashCount,
    failures,
  }
}
