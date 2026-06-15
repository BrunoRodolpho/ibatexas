// Retention cleaner — bounds unbounded growth of the two append-only tables by
// deleting rows older than a configurable retention window (P3-SCALE-RETENTION).
//
// Runs every 24h via a BullMQ repeatable job.
//
// Env vars:
//   RETENTION_DAYS=<n>          OPT-IN. Unset or <= 0 → the Prisma-table sweep is a no-op
//                               (a destructive sweep must be explicitly configured — there
//                               is deliberately NO default retention threshold).
//   TURN_TRACE_RETENTION_DAYS=<n>  OPT-IN, INDEPENDENT knob for the `turn_trace` store
//                               (per responder-trace-admin-plan.md C2 — the trace gets its
//                               OWN, typically shorter, retention than the audit/transcript
//                               tables). Unset or <= 0 → turn_trace is not swept.
//   RETENTION_DRY_RUN=false     true → count + log what WOULD be deleted, delete nothing.
//   RETENTION_BATCH_SIZE=1000   rows deleted per batch (bounds each transaction so a large
//                               first-run backlog never holds one giant DELETE).
//
// Scope:
//   - ConversationMessage  (by sentAt)    — archived transcript content.
//   - OrderEventLog         (by createdAt) — replayable observability layer; NOT the order
//                                            ledger (OrderProjection / OrderStatusHistory
//                                            are the source of truth and are untouched).
//   - turn_trace            (by recorded_at) — the per-LLM-call prompt/completion trace
//                                            (raw pg table, not a Prisma model) — swept by a
//                                            raw DELETE, gated by TURN_TRACE_RETENTION_DAYS.
//   Conversation rows (one per session) are left intact. This time-based bulk sweep
//   complements per-customer LGPD erasure (P0-LGPD-1), it does not replace it.

import { prisma } from "@ibatexas/domain";
import { parseBoolEnv } from "@ibatexas/types";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";

const REPEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;
// Safety stop: at most MAX_BATCHES * batchSize rows per table per run. Leftovers (if any)
// are swept on the next scheduled run — a single run never loops unboundedly.
const MAX_BATCHES = 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/** Retention window in days. 0 (the safe default) disables the cleaner entirely. */
function getRetentionDays(): number {
  const n = Number(process.env.RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Independent retention window (days) for the turn_trace store. 0 = disabled. */
function getTurnTraceRetentionDays(): number {
  const n = Number(process.env.TURN_TRACE_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isDryRun(): boolean {
  // Match dev's hardened env parsing (stale-order-checker): accept 1/TRUE/yes,
  // default false (production-safe). Audit test stubs RETENTION_DRY_RUN='true' → still true.
  return parseBoolEnv(process.env.RETENTION_DRY_RUN, false);
}

function getBatchSize(): number {
  const n = Number(process.env.RETENTION_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BATCH_SIZE;
}

export interface RetentionResult {
  /** true when BOTH knobs are disabled (RETENTION_DAYS <= 0 AND
   * TURN_TRACE_RETENTION_DAYS <= 0) — nothing was touched. */
  skipped: boolean;
  dryRun: boolean;
  conversationMessages: number;
  orderEvents: number;
  /** Rows deleted (or, in dry-run, that WOULD be deleted) from turn_trace. */
  turnTraces: number;
}

/**
 * Delete `turn_trace` rows older than the cutoff (raw pg — turn_trace is not a
 * Prisma model; it is the kernel-shaped table the writer/console share). The
 * table may not exist yet (tracing never ran) → a missing-relation error is
 * caught upstream and treated as 0. In dry-run, returns the count only.
 */
async function purgeTurnTrace(cutoff: Date, dryRun: boolean): Promise<number> {
  if (dryRun) {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM turn_trace WHERE recorded_at < ${cutoff}`;
    return rows[0]?.count ?? 0;
  }
  const deleted = await prisma.$executeRaw`
    DELETE FROM turn_trace WHERE recorded_at < ${cutoff}`;
  return Number(deleted);
}

/**
 * Delete ConversationMessage rows with sentAt < cutoff, in bounded batches. In dry-run,
 * returns the count that WOULD be deleted without deleting. Batches delete strictly by the
 * selected ids — never a blind table-wide deleteMany — so the work per transaction is
 * bounded and predictable.
 */
async function purgeConversationMessages(cutoff: Date, batchSize: number, dryRun: boolean): Promise<number> {
  if (dryRun) {
    return prisma.conversationMessage.count({ where: { sentAt: { lt: cutoff } } });
  }
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await prisma.conversationMessage.findMany({
      where: { sentAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (rows.length === 0) break;
    const res = await prisma.conversationMessage.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    total += res.count;
    if (rows.length < batchSize) break;
  }
  return total;
}

/** Delete OrderEventLog rows with createdAt < cutoff, in bounded batches. See above. */
async function purgeOrderEventLog(cutoff: Date, batchSize: number, dryRun: boolean): Promise<number> {
  if (dryRun) {
    return prisma.orderEventLog.count({ where: { createdAt: { lt: cutoff } } });
  }
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await prisma.orderEventLog.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (rows.length === 0) break;
    const res = await prisma.orderEventLog.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    total += res.count;
    if (rows.length < batchSize) break;
  }
  return total;
}

function reportJobError(table: string, err: unknown, log?: FastifyBaseLogger | null): void {
  log?.error({ table, error: String(err) }, "[retention] purge failed for table");
  Sentry.withScope((scope) => {
    scope.setTag("job", "retention-cleaner");
    scope.setTag("source", "background-job");
    scope.setContext("retention", { table });
    Sentry.captureException(err);
  });
}

/** Core job logic — exported for direct testing. */
export async function cleanupExpiredRecords(log?: FastifyBaseLogger | null): Promise<RetentionResult> {
  const effectiveLogger = log ?? logger;
  const days = getRetentionDays();
  const turnTraceDays = getTurnTraceRetentionDays();

  if (days <= 0 && turnTraceDays <= 0) {
    effectiveLogger?.info(
      "[retention] RETENTION_DAYS and TURN_TRACE_RETENTION_DAYS unset or <= 0 — retention cleaner disabled (no-op)",
    );
    return {
      skipped: true,
      dryRun: false,
      conversationMessages: 0,
      orderEvents: 0,
      turnTraces: 0,
    };
  }

  const dryRun = isDryRun();
  const batchSize = getBatchSize();

  // Each table is purged independently — a failure on one must not block the others.
  let conversationMessages = 0;
  let orderEvents = 0;
  if (days > 0) {
    const cutoff = new Date(Date.now() - days * DAY_MS);
    try {
      conversationMessages = await purgeConversationMessages(cutoff, batchSize, dryRun);
    } catch (err) {
      reportJobError("conversation_messages", err, effectiveLogger);
    }
    try {
      orderEvents = await purgeOrderEventLog(cutoff, batchSize, dryRun);
    } catch (err) {
      reportJobError("order_event_log", err, effectiveLogger);
    }
  }

  // turn_trace has its OWN (typically shorter) retention window.
  let turnTraces = 0;
  if (turnTraceDays > 0) {
    const traceCutoff = new Date(Date.now() - turnTraceDays * DAY_MS);
    try {
      turnTraces = await purgeTurnTrace(traceCutoff, dryRun);
    } catch (err) {
      reportJobError("turn_trace", err, effectiveLogger);
    }
  }

  effectiveLogger?.info(
    {
      retention_days: days,
      turn_trace_retention_days: turnTraceDays,
      dry_run: dryRun,
      conversation_messages: conversationMessages,
      order_events: orderEvents,
      turn_traces: turnTraces,
      run_at: new Date().toISOString(),
    },
    "[retention] cleanup complete",
  );

  return { skipped: false, dryRun, conversationMessages, orderEvents, turnTraces };
}

/** BullMQ processor. */
async function processor(_job: Job): Promise<void> {
  await cleanupExpiredRecords();
}

export function startRetentionCleaner(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("retention-cleaner");
  worker = createWorker("retention-cleaner", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[retention-cleaner] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "retention-cleaner");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  void queue.upsertJobScheduler("retention-repeat", {
    every: REPEAT_INTERVAL_MS,
  });
}

export async function stopRetentionCleaner(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
