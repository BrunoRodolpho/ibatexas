// Retention cleaner — bounds unbounded growth of the two append-only tables by
// deleting rows older than a configurable retention window (P3-SCALE-RETENTION).
//
// Runs every 24h via a BullMQ repeatable job.
//
// Env vars:
//   RETENTION_DAYS=<n>          OPT-IN. Unset or <= 0 → the cleaner is a no-op (a
//                               destructive sweep must be explicitly configured — there
//                               is deliberately NO default retention threshold).
//   RETENTION_DRY_RUN=false     true → count + log what WOULD be deleted, delete nothing.
//   RETENTION_BATCH_SIZE=1000   rows deleted per batch (bounds each transaction so a large
//                               first-run backlog never holds one giant DELETE).
//
// Scope:
//   - ConversationMessage  (by sentAt)    — archived transcript content.
//   - OrderEventLog         (by createdAt) — replayable observability layer; NOT the order
//                                            ledger (OrderProjection / OrderStatusHistory
//                                            are the source of truth and are untouched).
//   Conversation rows (one per session) are left intact. This time-based bulk sweep
//   complements per-customer LGPD erasure (P0-LGPD-1), it does not replace it.

import { prisma } from "@ibatexas/domain";
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

function isDryRun(): boolean {
  return process.env.RETENTION_DRY_RUN === "true";
}

function getBatchSize(): number {
  const n = Number(process.env.RETENTION_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BATCH_SIZE;
}

export interface RetentionResult {
  /** true when the cleaner was disabled (RETENTION_DAYS <= 0) — nothing was touched. */
  skipped: boolean;
  dryRun: boolean;
  conversationMessages: number;
  orderEvents: number;
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

  if (days <= 0) {
    effectiveLogger?.info(
      "[retention] RETENTION_DAYS unset or <= 0 — retention cleaner disabled (no-op)",
    );
    return { skipped: true, dryRun: false, conversationMessages: 0, orderEvents: 0 };
  }

  const cutoff = new Date(Date.now() - days * DAY_MS);
  const dryRun = isDryRun();
  const batchSize = getBatchSize();

  // Each table is purged independently — a failure on one must not block the other.
  let conversationMessages = 0;
  try {
    conversationMessages = await purgeConversationMessages(cutoff, batchSize, dryRun);
  } catch (err) {
    reportJobError("conversation_messages", err, effectiveLogger);
  }

  let orderEvents = 0;
  try {
    orderEvents = await purgeOrderEventLog(cutoff, batchSize, dryRun);
  } catch (err) {
    reportJobError("order_event_log", err, effectiveLogger);
  }

  effectiveLogger?.info(
    {
      retention_days: days,
      cutoff: cutoff.toISOString(),
      dry_run: dryRun,
      conversation_messages: conversationMessages,
      order_events: orderEvents,
      run_at: new Date().toISOString(),
    },
    "[retention] cleanup complete",
  );

  return { skipped: false, dryRun, conversationMessages, orderEvents };
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
