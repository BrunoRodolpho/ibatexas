// Postgres audit writer — Task 19 (M4 Audit & observability).
//
// Adapts `prisma.$executeRawUnsafe` to the `PostgresWriter` contract that
// `@adjudicate/audit-postgres.createPostgresSink` expects. The sink calls
// `insertAudit(row)` once per AuditRecord; this adapter translates the row
// into the canonical INSERT statement.
//
// Why $executeRawUnsafe instead of a typed Prisma model?
//   The brief defers the `IntentAudit` Prisma model + migration to a follow-
//   up (see docs/adjudicate-migration/tasks/19-audit-postgres-sink.md).
//   `audit-postgres` ships its own migration suite (001-008) that creates
//   the `intent_audit` partitioned table. Adopters that own the Prisma
//   schema would normally generate a typed model, but the partitioning +
//   v4 fields make raw SQL the lowest-friction path tonight.
//
// Schema TODO:
//   When the IntentAudit Prisma model lands, swap this implementation for
//   `prisma.intentAudit.create({data: row})`. The wiring point
//   (`createPostgresAuditWriter`) stays the same so callers don't change.
//
// Failure modes:
//   - Postgres unreachable: the INSERT throws. The buffered sink catches,
//     spills to Redis, and the redundancy consumer
//     (`audit-consumer.ts`) eventually drains via NATS replay.
//   - Unique-constraint violation on (intent_hash, recorded_at): the SQL
//     uses ON CONFLICT DO NOTHING so duplicate writes are idempotent.

import type {
  IntentAuditRow,
  PostgresWriter,
} from "@adjudicate/audit-postgres"

/**
 * Minimal Prisma surface needed to insert one audit row. Mirrors
 * `PrismaClient.$executeRawUnsafe` so tests can pass a stub without
 * standing up a real client.
 */
export interface PrismaRawExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
}

const INSERT_INTENT_AUDIT_SQL = `
INSERT INTO intent_audit (
  intent_hash,
  session_id,
  kind,
  principal,
  taint,
  decision_kind,
  refusal_kind,
  refusal_code,
  decision_basis,
  resource_version,
  envelope_jsonb,
  decision_jsonb,
  recorded_at,
  duration_ms,
  partition_month,
  record_version,
  plan_jsonb,
  nonce,
  supersedes_jsonb
)
VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::timestamptz,
  $14, $15, $16, $17::jsonb, $18, $19::jsonb
)
ON CONFLICT (intent_hash, recorded_at) DO NOTHING
`.trim()

export interface CreatePostgresAuditWriterOptions {
  /** Prisma client (or any `$executeRawUnsafe`-compatible stub for tests). */
  readonly prisma: PrismaRawExecutor
  /**
   * Optional hook fired on every successful INSERT (or no-op on conflict).
   * Used by the wiring layer to surface lag metrics.
   */
  readonly onInsert?: (row: IntentAuditRow) => void
}

/**
 * Build a `PostgresWriter` that persists one row per call.
 *
 * Wire into `createPostgresSink({writer})`. The sink calls `insertAudit`
 * exactly once per AuditRecord; rethrown errors propagate to the buffered
 * sink which then spills to Redis.
 */
export function createPostgresAuditWriter(
  opts: CreatePostgresAuditWriterOptions,
): PostgresWriter {
  return {
    async insertAudit(row: IntentAuditRow): Promise<void> {
      await opts.prisma.$executeRawUnsafe(
        INSERT_INTENT_AUDIT_SQL,
        row.intent_hash,
        row.session_id,
        row.kind,
        row.principal,
        row.taint,
        row.decision_kind,
        row.refusal_kind,
        row.refusal_code,
        // Postgres TEXT[] literal: PG accepts a JS array; the driver
        // serializes it. Prisma's $executeRawUnsafe passes through to pg.
        row.decision_basis,
        row.resource_version,
        row.envelope_jsonb,
        row.decision_jsonb,
        row.recorded_at,
        row.duration_ms,
        row.partition_month,
        row.record_version,
        row.plan_jsonb,
        row.nonce,
        row.supersedes_jsonb,
      )
      opts.onInsert?.(row)
    },
  }
}
