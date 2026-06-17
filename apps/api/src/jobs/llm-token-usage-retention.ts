// llm_token_usage retention cleaner (item C — UltraReview #94-16).
//
// The `llm_token_usage` cost-telemetry table is append-only (one row per turn)
// and otherwise grows unbounded. This bounds it with a daily BullMQ repeatable
// job that deletes rows older than a retention window.
//
// Env vars:
//   LLM_TOKEN_USAGE_RETENTION_DAYS=<n>  DEDICATED knob, DEFAULTS to 30 days when
//                               unset (aligned to the console learning-stream
//                               window). DELIBERATELY not RETENTION_DAYS — that
//                               one is opt-in/no-default, which would leave this
//                               table unbounded by default and defeat #94-16.
//                               Set <= 0 to OPT OUT explicitly (logged loudly).
//   RETENTION_DRY_RUN=false     true → count + log what WOULD be deleted only.
//   RETENTION_BATCH_SIZE=1000   rows deleted per batch (bounds each transaction).
//
// Retention column is `createdAt` (the DB insert clock, @default(now())) — NOT
// the caller-supplied `recordedAt`. Telemetry only; this complements (does not
// replace) per-customer LGPD erasure.

import { prisma } from "@ibatexas/domain";
import { parseBoolEnv } from "@ibatexas/types";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";

const REPEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;
// Safety stop: at most MAX_BATCHES * batchSize rows per run; leftovers sweep next run.
const MAX_BATCHES = 1000;
// #94-16: a DEFAULT (not opt-in) window so the table can't grow unbounded when
// the env var is unset — aligned to the 30-day learning-stream window.
const DEFAULT_RETENTION_DAYS = 30;

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/**
 * Retention window (days) for llm_token_usage. Defaults to 30 when unset/malformed;
 * an explicit value <= 0 disables the sweep (opt-out, logged loudly).
 */
function getRetentionDays(): number {
  const raw = process.env.LLM_TOKEN_USAGE_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS; // malformed → safe default
  if (n <= 0) return 0; // explicit opt-out
  return Math.floor(n);
}

function isDryRun(): boolean {
  return parseBoolEnv(process.env.RETENTION_DRY_RUN, false);
}

function getBatchSize(): number {
  const n = Number(process.env.RETENTION_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BATCH_SIZE;
}

export interface LlmTokenUsageRetentionResult {
  /** true when the cleaner is disabled (LLM_TOKEN_USAGE_RETENTION_DAYS <= 0). */
  skipped: boolean;
  dryRun: boolean;
  /** Rows deleted (or, in dry-run, that WOULD be deleted) from llm_token_usage. */
  llmTokenUsage: number;
}

/**
 * Delete llm_token_usage rows with createdAt < cutoff, in bounded batches. In
 * dry-run, returns the count that WOULD be deleted without deleting. Batches by
 * selected ids — never a blind table-wide deleteMany — so each transaction is
 * bounded and predictable.
 */
async function purgeLlmTokenUsage(
  cutoff: Date,
  batchSize: number,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    return prisma.llmTokenUsage.count({ where: { createdAt: { lt: cutoff } } });
  }
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await prisma.llmTokenUsage.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (rows.length === 0) break;
    const res = await prisma.llmTokenUsage.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    total += res.count;
    if (rows.length < batchSize) break;
  }
  return total;
}

function reportJobError(err: unknown, log?: FastifyBaseLogger | null): void {
  log?.error(
    { table: "llm_token_usage", error: String(err) },
    "[llm-token-usage-retention] purge failed",
  );
  Sentry.withScope((scope) => {
    scope.setTag("job", "llm-token-usage-retention");
    scope.setTag("source", "background-job");
    Sentry.captureException(err);
  });
}

/** Core job logic — exported for direct testing. */
export async function cleanupExpiredLlmTokenUsage(
  log?: FastifyBaseLogger | null,
): Promise<LlmTokenUsageRetentionResult> {
  const effectiveLogger = log ?? logger;
  const days = getRetentionDays();

  if (days <= 0) {
    effectiveLogger?.warn(
      "[llm-token-usage-retention] LLM_TOKEN_USAGE_RETENTION_DAYS explicitly disabled (<= 0) — the llm_token_usage table will grow UNBOUNDED",
    );
    return { skipped: true, dryRun: false, llmTokenUsage: 0 };
  }

  const dryRun = isDryRun();
  const batchSize = getBatchSize();
  const cutoff = new Date(Date.now() - days * DAY_MS);

  let deleted = 0;
  try {
    deleted = await purgeLlmTokenUsage(cutoff, batchSize, dryRun);
  } catch (err) {
    reportJobError(err, effectiveLogger);
  }

  effectiveLogger?.info(
    {
      retention_days: days,
      dry_run: dryRun,
      llm_token_usage: deleted,
      run_at: new Date().toISOString(),
    },
    "[llm-token-usage-retention] cleanup complete",
  );

  return { skipped: false, dryRun, llmTokenUsage: deleted };
}

/** BullMQ processor. */
async function processor(_job: Job): Promise<void> {
  await cleanupExpiredLlmTokenUsage();
}

export function startLlmTokenUsageRetention(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("llm-token-usage-retention");
  worker = createWorker("llm-token-usage-retention", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[llm-token-usage-retention] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "llm-token-usage-retention");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  void queue.upsertJobScheduler("llm-token-usage-retention-repeat", {
    every: REPEAT_INTERVAL_MS,
  });
}

export async function stopLlmTokenUsageRetention(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
