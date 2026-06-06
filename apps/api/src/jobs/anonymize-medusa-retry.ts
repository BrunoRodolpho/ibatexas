// anonymize-medusa-retry.ts — audit-2026-05-24 H3 Wave B.
//
// ── Why this job exists ───────────────────────────────────────────────────
//
// Wave-B's compensation chain runs:
//
//   anonymizeCustomer  →  emits  customer.anonymize.medusa.pending
//                            ↓
//   subscriber consumes        →  Medusa POST /admin/customers/:id
//                            ↓                        ↓
//                       .confirmed              .failed (transient)
//
// When the subscriber's Medusa call fails (Medusa outage, 5xx, network
// blip), the per-customer Redis entry under
// `rk('anonymize:medusa:pending:{customerId}')` remains and the
// pending-index Redis set still contains the customerId. This BullMQ
// repeatable job sweeps that index every 5 minutes; for each entry
// older than `MIN_AGE_BEFORE_RETRY_MS` (and not already cleared by a
// .confirmed) it re-publishes the NATS pending event so the subscriber
// gets another pass.
//
// After `MEDUSA_ANONYMIZE_MAX_ATTEMPTS` attempts the chain emits
// `customer.anonymize.medusa.exhausted` (CRITICAL operator alert) and
// the per-customer entry is left in place pending manual intervention.
// The 7-day TTL on the entry caps unbounded growth if an operator never
// resolves it.
//
// ── Idempotency ───────────────────────────────────────────────────────────
//
// Same as the subscriber: the Medusa POST is idempotent via stable
// `Idempotency-Key` header. Republishing the pending event N times
// against an already-scrubbed Medusa customer is a no-op.
//
// ── Distributed-lock guard ────────────────────────────────────────────────
//
// Mirrors `outbox-retry`: a single SETNX lock guards the per-tick sweep
// so multiple API replicas don't double-publish. TTL is 4.5 minutes —
// shorter than the 5-minute repeat interval so the lock never outlasts
// a cycle. Lua conditional DEL on release per CLAUDE.md rule #10.
//
// ── PII discipline ────────────────────────────────────────────────────────
//
// The job reads Redis-tracked entries (UUID customerId, UUID medusaId,
// intent-hash strings, ISO timestamps) and publishes them as-is.
// No name / email / phone / cpf flows through this path.

import crypto from "node:crypto";
import { getRedisClient, rk } from "@ibatexas/tools";
import {
  bumpMedusaAnonymizePendingAttempt,
  clearMedusaAnonymizePending,
  listMedusaAnonymizePendingCustomerIds,
  readMedusaAnonymizePending,
  type MedusaAnonymizePendingEntry,
} from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { buildAuditRecord, BASIS_CODES } from "@adjudicate/core";
import { getAuditSink } from "@ibatexas/audit-sink";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";
import {
  MEDUSA_ANONYMIZE_MAX_ATTEMPTS,
  type MedusaAnonymizePayload,
} from "../subscribers/__shared__/medusa-anonymize-kinds.js";

/** 5-minute repeat cadence — matches SYNTHESIS recommendation. */
const REPEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Minimum age before re-publishing. Prevents an instant re-sweep right
 * after the subscriber records the entry on receive. 2 minutes gives
 * the subscriber enough wall-time to land its Medusa call (even on a
 * slow morning).
 */
const MIN_AGE_BEFORE_RETRY_MS = 2 * 60 * 1000;

/** Distributed-lock TTL for the sweep — outlives one tick. */
const LOCK_TTL_SECONDS = 4 * 60 + 30;

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/**
 * Core sweep logic — exported for direct testing. Iterates the pending
 * index, skips entries that aren't stale yet, re-publishes pending
 * events for the rest, and emits `.exhausted` when an entry hits the
 * attempt cap.
 *
 * Returns a summary so tests can assert per-customer outcomes.
 */
export interface SweepOutcome {
  readonly customerId: string;
  readonly kind:
    | "republished"
    | "skipped_not_stale"
    | "exhausted"
    | "missing"
    | "error";
  readonly attempt?: number;
}

export async function sweepMedusaAnonymizeRetry(
  log?: FastifyBaseLogger | null,
): Promise<ReadonlyArray<SweepOutcome>> {
  const effectiveLog = log ?? logger;
  const redis = await getRedisClient();

  // Per-cycle SETNX lock — prevents multi-replica double-publish.
  const lockKey = rk("lock:anonymize-medusa-retry");
  const lockValue = crypto.randomUUID();
  const acquired = await redis.set(lockKey, lockValue, {
    EX: LOCK_TTL_SECONDS,
    NX: true,
  });
  if (acquired === null) {
    effectiveLog?.info(
      "[anonymize-medusa-retry] Another instance is sweeping — skipping",
    );
    return [];
  }

  const outcomes: SweepOutcome[] = [];
  try {
    const customerIds = await listMedusaAnonymizePendingCustomerIds();
    if (customerIds.length === 0) return outcomes;

    effectiveLog?.info(
      { count: customerIds.length },
      "[anonymize-medusa-retry] sweep starting",
    );

    const now = Date.now();
    for (const customerId of customerIds) {
      try {
        const entry = await readMedusaAnonymizePending(customerId);
        if (!entry) {
          // Entry was cleared between the index-read and the per-entry
          // read — most likely the subscriber's confirmed-path cleared
          // it. Drop the stale index member.
          await clearMedusaAnonymizePending(customerId);
          outcomes.push({ customerId, kind: "missing" });
          continue;
        }

        if (entry.attempt >= MEDUSA_ANONYMIZE_MAX_ATTEMPTS) {
          // Cap hit — emit .exhausted audit record + log CRITICAL.
          emitExhaustedAudit(entry, effectiveLog);
          effectiveLog?.error(
            {
              customerId,
              medusaId: entry.medusaId,
              attempts: entry.attempt,
            },
            "[anonymize-medusa-retry] CRITICAL: max attempts reached — manual operator intervention required",
          );
          Sentry.withScope((scope) => {
            scope.setTag("job", "anonymize-medusa-retry");
            scope.setTag("source", "background-job");
            scope.setLevel("error");
            scope.setContext("pending-entry", { ...entry });
            Sentry.captureMessage(
              `[anonymize-medusa-retry] exhausted retry budget for customer ${customerId}`,
            );
          });
          // Leave the entry in Redis so the operator's recovery query
          // surfaces it. The 7-day TTL will GC it if no one acts.
          outcomes.push({
            customerId,
            kind: "exhausted",
            attempt: entry.attempt,
          });
          continue;
        }

        const ageMs = now - entry.lastAttemptAt;
        if (ageMs < MIN_AGE_BEFORE_RETRY_MS) {
          outcomes.push({
            customerId,
            kind: "skipped_not_stale",
            attempt: entry.attempt,
          });
          continue;
        }

        // Bump the attempt counter BEFORE publish so a concurrent
        // sweep that races us will see the higher count.
        const bumped = await bumpMedusaAnonymizePendingAttempt(customerId);
        const attempt = bumped?.attempt ?? entry.attempt + 1;

        const payload: MedusaAnonymizePayload = {
          customerId: entry.customerId,
          medusaId: entry.medusaId,
          parkedIntentHash: entry.parkedIntentHash,
          parkedAt: entry.parkedAt,
          attempt,
        };
        await publishNatsEvent(
          "customer.anonymize.medusa.pending",
          payload as unknown as Record<string, unknown>,
        );

        effectiveLog?.info(
          { customerId, medusaId: entry.medusaId, attempt },
          "[anonymize-medusa-retry] re-published pending event",
        );
        outcomes.push({ customerId, kind: "republished", attempt });
      } catch (perEntryErr) {
        effectiveLog?.error(
          { customerId, err: (perEntryErr as Error).message },
          "[anonymize-medusa-retry] per-entry error — continuing sweep",
        );
        Sentry.withScope((scope) => {
          scope.setTag("job", "anonymize-medusa-retry");
          scope.setTag("source", "background-job");
          scope.setContext("customer", { customerId });
          Sentry.captureException(perEntryErr);
        });
        outcomes.push({ customerId, kind: "error" });
      }
    }
  } finally {
    // Conditional Lua release — only delete if we still own it.
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      { keys: [lockKey], arguments: [lockValue] },
    );
  }
  return outcomes;
}

function emitExhaustedAudit(
  entry: MedusaAnonymizePendingEntry,
  log?: FastifyBaseLogger | null,
): void {
  try {
    const envelope = buildSystemEnvelope({
      kind: "customer.anonymize.medusa.exhausted" as const,
      payload: {
        customerId: entry.customerId,
        medusaId: entry.medusaId,
        attempts: entry.attempt,
      },
      sourceSubject: "job:anonymize-medusa-retry",
      eventId: `${entry.parkedIntentHash}:exhausted`,
    });
    const record = buildAuditRecord({
      envelope,
      decision: {
        kind: "EXECUTE",
        basis: [
          {
            category: "business",
            code: BASIS_CODES.business.RULE_VIOLATED,
            detail: {
              rule: "medusa_scrub_retry_exhausted",
              kind: "customer.anonymize.medusa.exhausted",
              attempts: entry.attempt,
              maxAttempts: MEDUSA_ANONYMIZE_MAX_ATTEMPTS,
            },
          },
        ],
      },
      durationMs: 0,
      supersedes: {
        predecessorIntentHash: entry.parkedIntentHash,
        predecessorAt: entry.parkedAt,
        reason: "defer_resumed",
      },
    });
    void getAuditSink()
      .emit(record)
      .catch((err: unknown) => {
        log?.warn(
          {
            customerId: entry.customerId,
            err: (err as Error).message,
          },
          "[anonymize-medusa-retry] exhausted audit emit failed",
        );
      });
  } catch (err) {
    log?.warn(
      {
        customerId: entry.customerId,
        err: (err as Error).message,
      },
      "[anonymize-medusa-retry] exhausted audit record build failed",
    );
  }
}

/** BullMQ processor wrapper — runs one sweep per tick. */
async function processor(_job: Job): Promise<void> {
  await sweepMedusaAnonymizeRetry();
}

export function startAnonymizeMedusaRetry(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("anonymize-medusa-retry");
  worker = createWorker("anonymize-medusa-retry", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(
      { error: String(err) },
      "[anonymize-medusa-retry] Interval run failed",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", "anonymize-medusa-retry");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  // Run immediately on startup, then every REPEAT_INTERVAL_MS + jitter.
  // Jitter (0-15s) prevents thundering herd on multi-replica restart.
  const jitter = Math.floor(Math.random() * 15_000);
  void queue.upsertJobScheduler("anonymize-medusa-retry-repeat", {
    every: REPEAT_INTERVAL_MS + jitter,
    immediately: true,
  });
}

export async function stopAnonymizeMedusaRetry(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}

// Internals re-exported for unit tests.
export const _anonymizeMedusaRetryInternals = {
  REPEAT_INTERVAL_MS,
  MIN_AGE_BEFORE_RETRY_MS,
  LOCK_TTL_SECONDS,
} as const;
