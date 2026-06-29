// Audit read paths — the Adjudicator bridge's three audit-read methods
// (replayEnvelopesByCustomerId / streamAuditByIntentHashPrefix / getOutcomes)
// implemented against the @adjudicate/audit-postgres schema (`intent_audit` +
// `audit_outcomes`). Extracted from claustrum-bootstrap.ts so the bootstrap
// stays a composition root.
//
// Why direct SQL instead of `createPostgresAuditStore`: the package's reader
// covers only the admin-sdk filter shape (intentKind / decisionKind / exact
// intentHash / time window). None of the three port methods fit it —
// customer-scoped replay needs a session_id/payload predicate, the stream
// needs an intent_hash PREFIX match, and outcomes live in `audit_outcomes`
// (joined back to `intent_audit` for customer/kind scoping). We DO reuse the
// package's `rowToRecord` (the single source of truth for row → AuditRecord,
// including the v1–v5 version dispatch) and its `PostgresReader` contract.
//
// FAIL-SAFE BY CONSTRUCTION: these reads feed memory recall (the conductor's
// `recentActions()` path), not the money path. Every method swallows reader /
// row-conversion failures into an empty result (reported via `onError`), so a
// read-path outage degrades recall instead of crashing a turn. Contrast with
// the WRITE path (the audit sink), which fails CLOSED.

import type { AuditRecord } from "@adjudicate/core";
import {
  rowToRecord,
  type IntentAuditRow,
  type PostgresReader,
} from "@adjudicate/audit-postgres";
import type { OutcomeFilter, OutcomeRow } from "@claustrum/core";

// ── Port surface ─────────────────────────────────────────────────────────────

/** The three audit-read methods of the claustrum `Adjudicator` port. */
export interface AuditReadPaths {
  replayEnvelopesByCustomerId(
    customerId: string,
    since?: Date,
    tenantId?: string,
  ): Promise<ReadonlyArray<AuditRecord>>;
  streamAuditByIntentHashPrefix(
    prefix: string,
    tenantId?: string,
  ): AsyncIterable<AuditRecord>;
  getOutcomes(filter: OutcomeFilter): Promise<ReadonlyArray<OutcomeRow>>;
}

export interface AuditReadPathsDeps {
  /** Read-side query interface (the audit-postgres adopter contract). */
  readonly reader: PostgresReader;
  /**
   * Observability hook for swallowed read failures. The methods themselves
   * never throw (fail-safe — see module header); wire this to the structured
   * logger in production so a silent recall degradation is still visible.
   */
  readonly onError?: (err: Error, op: string) => void;
}

/** Wrap a `pg.Pool`-shaped client into the package's `PostgresReader`. */
export interface QueryablePool {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

export function postgresReaderFromPool(pool: QueryablePool): PostgresReader {
  return {
    async query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      const res = await pool.query(sql, [...params]);
      return res.rows as readonly R[];
    },
  };
}

// ── Row plumbing ─────────────────────────────────────────────────────────────

// Full column set incl. `metadata_jsonb` (v5) so the read is lossless — the
// package's own SELECT list predates migration 010 and drops it.
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
  "metadata_jsonb",
].join(", ");

// Bounded reads: recall is a context feed, not an export surface. 500 matches
// the admin-sdk's AuditQuerySchema limit cap; the stream pages by this size.
const REPLAY_ROW_LIMIT = 500;
const STREAM_PAGE_SIZE = 200;

// `intent_hash` is constrained to `^[a-f0-9]{64}$` (migration 001), so a valid
// prefix is hex-only. Anything else cannot match a row — and rejecting it here
// also keeps LIKE metacharacters (%/_) out of the pattern.
const HEX_PREFIX_RE = /^[a-f0-9]{0,64}$/;

/**
 * What the pg driver hands back for one `intent_audit` row: TIMESTAMPTZ as
 * `Date` (node-postgres) or string, JSONB as already-parsed objects. The
 * package's `rowToRecord` expects the WRITER shape (`IntentAuditRow`: ISO
 * string + pre-serialized JSON text), so normalize before converting.
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
  readonly recorded_at: string | Date;
  readonly envelope_jsonb: unknown;
  readonly decision_jsonb: unknown;
  readonly plan_jsonb: unknown;
  readonly supersedes_jsonb: unknown;
  readonly kernel_identity_jsonb: unknown;
  readonly signature_jsonb: unknown;
  readonly metadata_jsonb: unknown;
};

function jsonText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

function isoTimestamp(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`intent_audit.recorded_at is not a parseable timestamp: ${v}`);
  }
  return parsed.toISOString();
}

function toIntentAuditRow(raw: RawAuditRow): IntentAuditRow {
  return {
    ...raw,
    recorded_at: isoTimestamp(raw.recorded_at),
    // NOT NULL columns (envelope/decision) never reach the "null" branch on a
    // schema-conformant row; the fallback only keeps the type honest.
    envelope_jsonb: jsonText(raw.envelope_jsonb) ?? "null",
    decision_jsonb: jsonText(raw.decision_jsonb) ?? "null",
    plan_jsonb: jsonText(raw.plan_jsonb),
    supersedes_jsonb: jsonText(raw.supersedes_jsonb),
    kernel_identity_jsonb: jsonText(raw.kernel_identity_jsonb),
    signature_jsonb: jsonText(raw.signature_jsonb),
    metadata_jsonb: jsonText(raw.metadata_jsonb),
  };
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// ── Tenant scope ─────────────────────────────────────────────────────────────

// The intent_audit store is single-tenant (no tenant column — every row
// belongs to THIS deployment's tenant). Per the port contract
// (APIReviewer-001), a multi-tenant caller passing a tenantId must never
// receive another tenant's rows: a scope that is not OUR tenant yields an
// empty result rather than leaking the single tenant's data.
function tenantMismatch(tenantId: string | undefined): boolean {
  return (
    tenantId !== undefined &&
    tenantId !== (process.env.KERNEL_TENANT_ID ?? "ibatexas")
  );
}

// ── Customer scoping predicate ────────────────────────────────────────────────

// A row belongs to `customerId` when either:
//   1. `session_id = customerId` — user-principal envelopes minted by the
//      customer-intent-gateway carry `actor.sessionId = customerId` by app
//      convention (routes/__shared__/customer-intent-gateway.ts; mirrored by
//      resume-dispatcher.ts), and the sink writes actor.sessionId to
//      session_id; or
//   2. the stored envelope payload names the customer — planner/system
//      envelopes carry a conversation handle / "subject:eventId" in
//      actor.sessionId, but their payloads reference the customer they act on.
// Known gap (documented): an LLM-planner envelope whose payload omits
// customerId is not attributable from the audit row alone — recall simply
// skips it.
function customerMatchSql(paramIdx: number): string {
  return (
    `(session_id = $${paramIdx} ` +
    `OR envelope_jsonb #>> '{payload,customerId}' = $${paramIdx})`
  );
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createAuditReadPaths(deps: AuditReadPathsDeps): AuditReadPaths {
  const report = (err: unknown, op: string): void => {
    try {
      deps.onError?.(asError(err), op);
    } catch {
      /* the observability hook must never take down a read */
    }
  };

  /** Per-row conversion with skip-on-corrupt (fail-safe, reported). */
  const toRecords = (rows: readonly RawAuditRow[], op: string): AuditRecord[] => {
    const records: AuditRecord[] = [];
    for (const raw of rows) {
      try {
        records.push(rowToRecord(toIntentAuditRow(raw)));
      } catch (err) {
        report(err, op);
      }
    }
    return records;
  };

  return {
    async replayEnvelopesByCustomerId(customerId, since, tenantId) {
      const id = customerId.trim();
      if (id === "" || tenantMismatch(tenantId)) return [];
      try {
        const params: unknown[] = [id];
        let where = customerMatchSql(1);
        if (since !== undefined) {
          params.push(since.toISOString());
          where += ` AND recorded_at >= $2`;
        }
        params.push(REPLAY_ROW_LIMIT);
        const rows = await deps.reader.query<RawAuditRow>(
          `SELECT ${AUDIT_SELECT_COLUMNS} FROM intent_audit ` +
            `WHERE ${where} ` +
            `ORDER BY recorded_at DESC, intent_hash DESC ` +
            `LIMIT $${params.length}`,
          params,
        );
        return toRecords(rows, "replayEnvelopesByCustomerId");
      } catch (err) {
        report(err, "replayEnvelopesByCustomerId");
        return [];
      }
    },

    async *streamAuditByIntentHashPrefix(prefix, tenantId) {
      if (tenantMismatch(tenantId)) return;
      if (!HEX_PREFIX_RE.test(prefix)) {
        report(
          new Error(`intent-hash prefix is not lowercase hex: ${prefix}`),
          "streamAuditByIntentHashPrefix",
        );
        return;
      }
      // Keyset pagination over the UNIQUE (intent_hash, recorded_at) index
      // (migration 009) — ASC so the cursor is a strict tuple lower bound.
      let cursor: { hash: string; at: string } | null = null;
      for (;;) {
        let rows: readonly RawAuditRow[];
        try {
          const params: unknown[] = [`${prefix}%`];
          let where = "intent_hash LIKE $1";
          if (cursor !== null) {
            params.push(cursor.hash, cursor.at);
            where += " AND (intent_hash, recorded_at) > ($2, $3)";
          }
          params.push(STREAM_PAGE_SIZE);
          rows = await deps.reader.query<RawAuditRow>(
            `SELECT ${AUDIT_SELECT_COLUMNS} FROM intent_audit ` +
              `WHERE ${where} ` +
              `ORDER BY intent_hash ASC, recorded_at ASC ` +
              `LIMIT $${params.length}`,
            params,
          );
        } catch (err) {
          // Fail-safe: end the stream early rather than throw into the turn.
          report(err, "streamAuditByIntentHashPrefix");
          return;
        }
        for (const record of toRecords(rows, "streamAuditByIntentHashPrefix")) {
          yield record;
        }
        if (rows.length < STREAM_PAGE_SIZE) return;
        const last = rows.at(-1)!;
        cursor = { hash: last.intent_hash, at: isoTimestamp(last.recorded_at) };
      }
    },

    async getOutcomes(filter) {
      if (tenantMismatch(filter.tenantId)) return [];
      try {
        const clauses: string[] = [];
        const params: unknown[] = [];
        let i = 1;
        if (filter.observed !== undefined) {
          clauses.push(`o.observed = $${i++}`);
          params.push(filter.observed);
        }
        // Inclusive [since, until] window — APIReviewer-003 boundary convention.
        if (filter.since !== undefined) {
          clauses.push(`o.observed_at >= $${i++}`);
          params.push(filter.since);
        }
        if (filter.until !== undefined) {
          clauses.push(`o.observed_at <= $${i++}`);
          params.push(filter.until);
        }
        // Customer / kind scope lives on intent_audit; EXISTS (not JOIN) so a
        // hash that degenerately appears in multiple audit rows cannot
        // duplicate an outcome row.
        if (filter.customerId !== undefined || filter.intentKind !== undefined) {
          const sub: string[] = ["a.intent_hash = o.intent_hash"];
          if (filter.intentKind !== undefined) {
            sub.push(`a.kind = $${i++}`);
            params.push(filter.intentKind);
          }
          if (filter.customerId !== undefined) {
            sub.push(
              `(a.session_id = $${i} ` +
                `OR a.envelope_jsonb #>> '{payload,customerId}' = $${i})`,
            );
            i++;
            params.push(filter.customerId);
          }
          clauses.push(
            `EXISTS (SELECT 1 FROM intent_audit a WHERE ${sub.join(" AND ")})`,
          );
        }
        params.push(REPLAY_ROW_LIMIT);
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")} ` : "";
        const rows = await deps.reader.query<{
          intent_hash: string;
          observed: string;
          observed_at: string | Date;
          note: string | null;
        }>(
          `SELECT o.intent_hash, o.observed, o.observed_at, o.note ` +
            `FROM audit_outcomes o ${where}` +
            `ORDER BY o.observed_at DESC, o.intent_hash DESC ` +
            `LIMIT $${params.length}`,
          params,
        );
        return rows.map((r) => ({
          intentHash: r.intent_hash,
          // The audit_outcomes CHECK constrains the vocabulary (migration 007).
          observed: r.observed as OutcomeRow["observed"],
          at: isoTimestamp(r.observed_at),
          ...(r.note === null ? {} : { note: r.note }),
        }));
      } catch (err) {
        report(err, "getOutcomes");
        return [];
      }
    },
  };
}
