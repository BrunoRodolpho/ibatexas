// DEFER timeout sweeper — task 03 (adjudicate-migration).
//
// Why this exists:
//   Today, when a `defer:pending:{sessionId}` key's TTL expires, the
//   parked envelope is silently deleted by Redis. The customer who was
//   waiting for a PIX confirmation never gets a follow-up; the agent
//   conversation stays in "Estou aguardando confirmação..." forever.
//
// What this job does:
//   Every 60s, SCAN `defer:pending:*` keys via the namespaced `rk()` prefix.
//   For each key whose TTL is at or below `IMMINENT_TTL_SECONDS` (60s by
//   default, configurable via env), publish an `intent.defer.timeout` NATS
//   event with `{sessionId, intentHash, signal, parkedAt}` payload and DEL
//   the key. Subsequent runs see no key — idempotent by construction.
//
// What this job does NOT do:
//   - Send the customer-facing notification. That's a separate subscriber
//     (see deferred follow-up in the task spec) so the same event can be
//     consumed by multiple downstream concerns (notifications, analytics,
//     ops dashboards).
//   - Re-execute the parked envelope. By definition the resume signal
//     never arrived; the envelope's policy intent is to time out, not to
//     succeed silently.
//
// Choice of BullMQ over setInterval:
//   The existing job inventory (pix-expiry-checker, abandoned-cart-checker,
//   etc.) uses BullMQ with `upsertJobScheduler` for repeatable jobs. This
//   matches that pattern exactly so the operational story (Bull Board,
//   shutdown semantics, retries) stays consistent. setInterval would
//   require its own lifecycle management.
//
// CLAUDE.md rules honoured:
//   #7 rk() for all Redis keys (defer:pending:* matches what the responder
//      wrote when parking).
//   #4 No user-facing text here — the NATS event payload is internal; any
//      pt-BR phrasing lives in the downstream notification subscriber.

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { type ParkedEnvelope } from "@adjudicate/runtime";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";

// Repeat cadence. 60s matches the +60s grace the responder adds to the
// parked-envelope TTL — so any key past its signal timeoutMs is caught
// within at most one sweep.
const REPEAT_INTERVAL_MS = 60 * 1000;

// TTL threshold at which we declare a key "imminently expiring" and
// publish the timeout. The runtime parks with
//   TTL = ceil(signal.timeoutMs / 1000) + 60
// so anything at or below 60s remaining is, for the kernel's purposes,
// past the deadline.
const IMMINENT_TTL_SECONDS = Number.parseInt(
  process.env.DEFER_TIMEOUT_IMMINENT_SECONDS ?? "60",
  10,
);

// SCAN batch size — small enough to cap memory, large enough to absorb a
// typical session of O(10) parks in one round-trip.
const SCAN_COUNT = 100;

// Hard limit to keep one sweep bounded if the parked-envelope namespace
// has somehow grown into the thousands. A second sweep will pick up the
// rest 60s later.
const MAX_KEYS_PER_SWEEP = 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

export interface DeferTimeoutEventPayload extends Record<string, unknown> {
  readonly eventType: "intent.defer.timeout";
  readonly sessionId: string;
  readonly intentHash: string;
  readonly signal: string;
  readonly parkedAt: string;
  readonly timestamp: string;
}

/**
 * Core sweep logic — exported for direct unit testing without BullMQ.
 *
 * Returns the count of keys for which a timeout event was published.
 * Idempotent: a key that's already been swept is deleted, so subsequent
 * runs find nothing for it.
 */
export async function sweepDeferTimeouts(
  log?: FastifyBaseLogger | null,
): Promise<number> {
  const effectiveLogger = log ?? logger;
  let publishedCount = 0;

  let redis: Awaited<ReturnType<typeof getRedisClient>>;
  try {
    redis = await getRedisClient();
  } catch (err) {
    effectiveLogger?.error(
      { err: (err as Error).message },
      "[defer-timeout-sweeper] Redis unavailable — skipping sweep",
    );
    return 0;
  }

  // Collect candidates first via SCAN; do the per-key TTL/DEL work after
  // we've finished iterating so we don't hold the cursor open for too long.
  const candidates: string[] = [];
  const pattern = rk("defer:pending:*");
  try {
    for await (const key of redis.scanIterator({
      MATCH: pattern,
      COUNT: SCAN_COUNT,
    })) {
      if (Array.isArray(key)) {
        candidates.push(...key);
      } else {
        candidates.push(key as string);
      }
      if (candidates.length >= MAX_KEYS_PER_SWEEP) break;
    }
  } catch (err) {
    effectiveLogger?.error(
      { err: (err as Error).message },
      "[defer-timeout-sweeper] SCAN failed",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", "defer-timeout-sweeper");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
    return 0;
  }

  if (candidates.length === 0) {
    effectiveLogger?.debug(
      { run_at: new Date().toISOString() },
      "[defer-timeout-sweeper] No parked envelopes — nothing to sweep",
    );
    return 0;
  }

  for (const key of candidates) {
    try {
      // PTTL would give us millisecond precision but TTL is plenty for a
      // 60s cadence. Returns -1 if no expire, -2 if key missing. We treat
      // -1 (no TTL) as "expired" because parked envelopes must always
      // have a TTL — a missing TTL is itself an invariant violation.
      const ttl = await redis.ttl(key).catch(() => -2);
      if (ttl === -2) {
        // Key vanished between SCAN and TTL — fine, nothing to do.
        continue;
      }
      if (ttl > IMMINENT_TTL_SECONDS) {
        // Still has time; the responder/resolver paths own this one.
        continue;
      }

      // Read the parked envelope so we can pull intentHash + signal +
      // parkedAt for the timeout event. If the read fails or the blob is
      // malformed, we still DEL the key and publish a minimal event so
      // ops can see what got cleaned up.
      const raw = await redis.get(key).catch(() => null);
      const sessionId = parseSessionId(key);
      let intentHash = "";
      let signal = "";
      let parkedAt = "";
      if (raw) {
        try {
          const parked = JSON.parse(raw) as ParkedEnvelope;
          intentHash = parked.envelope?.intentHash ?? "";
          signal = parked.signal ?? "";
          parkedAt = parked.parkedAt ?? "";
        } catch (parseErr) {
          effectiveLogger?.warn(
            { key, err: (parseErr as Error).message },
            "[defer-timeout-sweeper] malformed parked envelope — publishing minimal timeout",
          );
        }
      }

      // Publish the timeout. Subscribers (e.g. notification fan-out)
      // consume `intent.defer.timeout` to drive user-facing follow-ups.
      const payload: DeferTimeoutEventPayload = {
        eventType: "intent.defer.timeout",
        sessionId,
        intentHash,
        signal,
        parkedAt,
        timestamp: new Date().toISOString(),
      };
      try {
        await publishNatsEvent("intent.defer.timeout", payload);
      } catch (publishErr) {
        // publishNatsEvent already swallows NATS errors internally; this
        // path only fires for synchronous misuse. Don't DEL the key if
        // publish failed so the next sweep retries.
        effectiveLogger?.error(
          { key, err: (publishErr as Error).message },
          "[defer-timeout-sweeper] publishNatsEvent failed — leaving key for retry",
        );
        continue;
      }

      // Idempotent cleanup. DEL the parked key so subsequent sweeps don't
      // re-publish for the same session.
      await redis.del(key).catch(() => {
        // Best-effort. Even if DEL fails, the Redis TTL will eventually
        // garbage-collect the key.
      });

      publishedCount++;
      effectiveLogger?.info(
        { sessionId, intentHash, signal, ttl },
        "[defer-timeout-sweeper] published intent.defer.timeout and deleted parked key",
      );
    } catch (err) {
      // Per-key error containment. Continue with the rest of the batch.
      effectiveLogger?.error(
        { key, err: (err as Error).message },
        "[defer-timeout-sweeper] error processing parked key",
      );
      Sentry.withScope((scope) => {
        scope.setTag("job", "defer-timeout-sweeper");
        scope.setTag("source", "background-job");
        scope.setContext("parked", { key });
        Sentry.captureException(err);
      });
    }
  }

  effectiveLogger?.info(
    { published_count: publishedCount, run_at: new Date().toISOString() },
    "[defer-timeout-sweeper] sweep complete",
  );
  return publishedCount;
}

function parseSessionId(key: string): string {
  // rk() prepends `${APP_ENV}:` so the suffix is `defer:pending:{sessionId}`.
  const m = key.match(/defer:pending:(.+)$/);
  return m ? m[1]! : key;
}

/** BullMQ processor — wraps the core logic. */
async function processor(_job: Job): Promise<void> {
  await sweepDeferTimeouts();
}

export function startDeferTimeoutSweeper(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("defer-timeout-sweeper");
  worker = createWorker("defer-timeout-sweeper", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[defer-timeout-sweeper] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "defer-timeout-sweeper");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  // Add the repeatable job (BullMQ deduplicates by repeat key).
  void queue.upsertJobScheduler("defer-timeout-sweeper-repeat", {
    every: REPEAT_INTERVAL_MS,
  });
}

export async function stopDeferTimeoutSweeper(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger = null;
}
