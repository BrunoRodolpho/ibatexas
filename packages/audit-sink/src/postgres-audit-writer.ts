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
//   - Duplicate insert (Redis dedup miss + NATS-replay): handled by
//     `ON CONFLICT DO NOTHING` (P0-14, see schema note below).
//
// ── P0-14 / audit-2026-05-24 P1-4 schema-alignment note ───────────────
//
// The previous SQL targeted `ON CONFLICT (intent_hash, recorded_at)` — a
// constraint that does NOT exist in the @adjudicate/audit-postgres
// schema. Migration 001 declares:
//   - PRIMARY KEY (id, recorded_at)        // id is BIGSERIAL
//   - INDEX (intent_hash, recorded_at DESC) // NOT UNIQUE
// Migrations 002-008 add columns + a non-unique nonce index. There is no
// unique constraint on `(intent_hash, recorded_at)` anywhere in the
// schema. The original ON CONFLICT clause would throw Postgres error
// 42P10 ("there is no unique or exclusion constraint matching the ON
// CONFLICT specification") on the first INSERT with
// `IBX_AUDIT_POSTGRES_ENABLED=true`.
//
// We use bare `ON CONFLICT DO NOTHING` (no column list / no constraint name).
// This:
//   - is valid SQL — matches any unique constraint violation;
//   - is a no-op today because no unique constraint exists on the table
//     (the `(id, recorded_at)` PK is BIGSERIAL+ts so a fresh INSERT never
//     conflicts);
//   - is forward-compatible: when a `UNIQUE (intent_hash, recorded_at)`
//     constraint lands upstream in the sibling `@adjudicate/audit-postgres`
//     repo (audit-2026-05-24 P1-4, tracked for cross-repo coordination),
//     this writer silently picks up the dedup without code changes here.
//
// ── audit-2026-05-24 P1-4: dedup decision (Option A) ──────────────────
//
// Two paths today write the SAME AuditRecord to the same Postgres table:
//   - The in-process Postgres sink (this writer wired through
//     `intent-audit-wiring.ts`), called inside the responder/kernel hot
//     paths via `getAuditSink().emit(...)`.
//   - The audit-consumer NATS subscriber (`audit-consumer.ts`), which
//     re-consumes records published to `audit.intent.decision.v1` and
//     writes them durably for crash recovery.
//
// Pre-P1-4 each path had its OWN Redis SETNX dedup with DIFFERENT key
// prefixes — neither saw the other. The bare `ON CONFLICT DO NOTHING`
// was a no-op (no unique constraint). Net effect: every audit row was
// persisted twice.
//
// Decision: keep the existing topology (Option A in the audit brief).
//   - The in-process sink is authoritative — it writes in-band with the
//     hot path so the record lands the moment the decision fires.
//   - The audit-consumer is fault-tolerant redundancy — if the API
//     process crashes between NATS publish and the in-process INSERT,
//     NATS at-least-once delivery replays through the consumer.
//   - Both attempt the INSERT. With the upstream UNIQUE constraint in
//     place, the second writer (whichever lands last) is a no-op.
//   - The `onConflictNoOp` hook fires on each silent dedup so ops can
//     gauge how often the redundancy path collides with the primary
//     (`kernel_audit_dedup_total{path}` Prometheus counter).
//
// Layer-1 dedup (Redis SETNX in `audit-consumer.ts`) remains the cheap
// pre-INSERT shortcut for redelivery. Layer-2 dedup at the Postgres
// level is the safety net that catches the race the SETNX can't see.

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

// T1a-13: the previous column list stopped at v3 (19 columns) and silently
// DROPPED the v4/v5 fields the sink supplies on every row —
// kernel_identity_jsonb, policy_version, kernel_version, audit_hash,
// signature_jsonb, metadata_jsonb. audit_hash is the tamper-evidence hash:
// "Dropping this on write/read defeats verifyAuditRecord end-to-end"
// (IntentAuditRow docs, @adjudicate/audit-postgres). Surfaced live by the
// first JOURNEY-001 run: every persisted v5 row failed the
// `audit.record.verified` invariant with a NULL audit_hash. The columns all
// exist in the schema (migrations 008 + 010 — `ibx kernel migrate`).
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
  supersedes_jsonb,
  kernel_identity_jsonb,
  policy_version,
  kernel_version,
  audit_hash,
  signature_jsonb,
  metadata_jsonb
)
VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::timestamptz,
  $14, $15, $16, $17::jsonb, $18, $19::jsonb, $20::jsonb, $21, $22, $23, $24::jsonb,
  $25::jsonb
)
ON CONFLICT DO NOTHING
`.trim()

export interface CreatePostgresAuditWriterOptions {
  /** Prisma client (or any `$executeRawUnsafe`-compatible stub for tests). */
  readonly prisma: PrismaRawExecutor
  /**
   * Optional hook fired on every successful INSERT (or no-op on conflict).
   * Used by the wiring layer to surface lag metrics.
   */
  readonly onInsert?: (row: IntentAuditRow) => void
  /**
   * Audit-2026-05-24 P1-4: fires when the `ON CONFLICT DO NOTHING` clause
   * absorbs a duplicate (the row already exists from a prior INSERT — the
   * `$executeRawUnsafe` return value is 0). Wired to a Prometheus counter
   * by `intent-audit-wiring.ts` / `audit-consumer.ts` so operators can
   * gauge how often the in-process sink and the audit-consumer redundancy
   * path collide. A high collision rate is expected and healthy when the
   * upstream UNIQUE constraint lands; it indicates the layer-2 dedup is
   * working as designed.
   *
   * Until the cross-repo schema migration ships
   * (UNIQUE(intent_hash, recorded_at) on `intent_audit`), this hook will
   * not fire — every INSERT lands a new row because no constraint exists
   * to violate. The metric stays at zero until the constraint goes live;
   * that's the operator's signal for "schema deployed."
   */
  readonly onConflictNoOp?: (row: IntentAuditRow) => void
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
      // Prisma's `$executeRawUnsafe` returns the number of affected rows.
      // With `ON CONFLICT DO NOTHING`, that's 1 for a fresh insert and 0
      // when the constraint absorbs a duplicate. Once the upstream UNIQUE
      // constraint lands (audit-2026-05-24 P1-4), the 0 path fires the
      // dedup observability hook so ops can gauge collision rate.
      const affected = await opts.prisma.$executeRawUnsafe(
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
        // v4/v5 fields (T1a-13 — see the SQL note above). The sink populates
        // them (`?? null`) on every row; audit_hash is the tamper-evidence
        // chain verifyAuditRecord checks.
        row.kernel_identity_jsonb,
        row.policy_version,
        row.kernel_version,
        row.audit_hash,
        row.signature_jsonb,
        row.metadata_jsonb,
      )
      if (affected === 0 && opts.onConflictNoOp) {
        try {
          opts.onConflictNoOp(row)
        } catch {
          // Telemetry must never block audit emission.
        }
      }
      opts.onInsert?.(row)
    },
  }
}
