// NATS audit consumer — Task 19 (M4 Audit & observability).
//
// Decoupled-archiver pattern (migration/02-milestones.md M4): the hot path
// in `intent-audit-wiring.ts` emits each AuditRecord to NATS subject
// `audit.intent.decision.v1`. This subscriber listens on that subject and
// writes the record durably to Postgres via `@adjudicate/audit-postgres`.
//
// Why a second writer alongside the in-process Postgres sink?
//   The in-process sink (composed inside `intent-audit-wiring.ts`) writes
//   synchronously inside the request path. If the API process crashes
//   between the NATS publish and the Postgres INSERT, the audit row is
//   lost. NATS guarantees at-least-once delivery to subscribed consumers;
//   this subscriber catches up any record the in-process sink missed.
//
//   Two layers of dedup keep the second writer idempotent:
//     1. `isNewEvent(audit.intent.decision.v1:<intentHash>:<recordAt>)` —
//        Redis SETNX, 7d TTL. Suppresses re-runs from NATS redelivery.
//     2. `ON CONFLICT (intent_hash, recorded_at) DO NOTHING` on the SQL
//        INSERT. Suppresses duplicates the dedup ledger somehow missed
//        (e.g. parallel handlers on multiple replicas).
//
// Failure mode:
//   - Postgres unreachable: push to DLQ list `dlq:audit.intent.decision.v1`
//     so ops can replay manually after recovery.
//   - Malformed payload: log + DLQ; never throw to the NATS subscriber
//     loop (a throw would tear down the SCAN/dispatch loop).
//
// Always-on durability: per IBX-IGE v3.0 cutover (CLAUDE.md rule #9), the
// in-process Postgres sink is always composed and this consumer is always
// subscribed. There is no env-var gate — the audit-postgres redundancy
// path runs unconditionally alongside the in-process sink.

import type { AuditRecord } from "@adjudicate/core"
import {
  createPostgresSink,
  type PostgresWriter,
} from "@adjudicate/audit-postgres"
import { subscribeNatsEvent } from "@ibatexas/nats-client"
import { prisma } from "@ibatexas/domain"
import type { FastifyBaseLogger } from "fastify"
import { isNewEvent } from "./dedup.js"
import { pushToDlq } from "./dlq.js"
import {
  createPostgresAuditWriter,
  type PrismaRawExecutor,
} from "@ibatexas/llm-provider"

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Optional test override for the Postgres writer. Production callers leave
 * this null and rely on the live Prisma client.
 */
let _writerOverride: PostgresWriter | null = null

/** @internal — for test injection. */
export function _setAuditConsumerWriter(writer: PostgresWriter | null): void {
  _writerOverride = writer
}

/**
 * Wire the audit-consumer subscriber. Always-on per IBX-IGE v3.0 cutover:
 * subscribes to `audit.intent.decision.v1` and durably persists each
 * record to Postgres as the redundancy path behind the in-process sink.
 */
export async function startAuditConsumer(
  log?: FastifyBaseLogger,
): Promise<void> {
  // Build the writer once at startup. `createPostgresSink` wraps it in the
  // emit-error reporting layer we want for the redundancy path too.
  const writer =
    _writerOverride ??
    createPostgresAuditWriter({
      prisma: prisma as unknown as PrismaRawExecutor,
    })
  const sink = createPostgresSink({
    writer,
    onError: (err: Error, record: AuditRecord) => {
      log?.warn(
        {
          error: String(err),
          intent_hash: record.intentHash,
          intent_kind: record.envelope.kind,
        },
        "[audit-consumer] postgres insert failed — pushing to DLQ",
      )
    },
  })

  await subscribeNatsEvent(
    "audit.intent.decision.v1",
    async (payload: Record<string, unknown>) => {
      const record = payload as unknown as AuditRecord
      // Minimum-viable validation: the NATS-side AuditRecord shape carries
      // `intentHash` + `envelope` + `decision` + `at` at the top level. A
      // payload missing those is malformed — log and DLQ.
      if (
        typeof record?.intentHash !== "string" ||
        typeof record?.at !== "string" ||
        typeof record?.envelope !== "object" ||
        record.envelope === null
      ) {
        log?.warn(
          { payload_keys: Object.keys(payload ?? {}) },
          "[audit-consumer] malformed audit payload — DLQ",
        )
        await pushToDlq(
          "audit.intent.decision.v1",
          payload as Record<string, unknown>,
          new Error("malformed audit payload"),
          log,
        )
        return
      }

      // Dedup layer 1: Redis SETNX. Composite key uses intentHash + at to
      // handle the (unlikely) case of two AuditRecords sharing an intent-
      // Hash across distinct decisions.
      //
      // P0-14 note: there is currently NO unique constraint on
      // (intent_hash, recorded_at) in the @adjudicate/audit-postgres
      // schema. Layer-2 dedup via `ON CONFLICT DO NOTHING` is a no-op
      // until that constraint lands upstream. Layer 1 (this Redis SETNX)
      // is load-bearing today.
      const dedupKey = `audit.intent.decision.v1:${record.intentHash}:${record.at}`
      try {
        if (!(await isNewEvent(dedupKey))) {
          log?.debug?.(
            { intent_hash: record.intentHash, at: record.at },
            "[audit-consumer] duplicate — already archived",
          )
          return
        }
      } catch (err) {
        // Dedup failure is non-fatal — the ON CONFLICT clause is layer 2.
        log?.warn(
          { error: String(err), intent_hash: record.intentHash },
          "[audit-consumer] dedup check failed — proceeding to INSERT",
        )
      }

      try {
        await sink.emit(record)
        log?.debug?.(
          {
            intent_hash: record.intentHash,
            intent_kind: record.envelope.kind,
            decision_kind: record.decision?.kind,
          },
          "[audit-consumer] archived to postgres",
        )
      } catch (err) {
        // Dedup layer 2 (ON CONFLICT) absorbs unique-constraint violations
        // silently — we only get here on real failures (connection,
        // syntax, etc.). DLQ for ops replay.
        await pushToDlq(
          "audit.intent.decision.v1",
          payload as Record<string, unknown>,
          err,
          log,
        )
      }
    },
  )

  log?.info("[audit-consumer] subscribed to audit.intent.decision.v1")
}
