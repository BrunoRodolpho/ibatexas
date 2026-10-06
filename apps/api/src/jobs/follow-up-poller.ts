// Follow-up poller
// Runs every 15 minutes via BullMQ repeatable job. Reads due follow-up entries
// from Redis sorted set and publishes follow-up.due NATS events.
// Idempotent across multiple instances.

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { assertDepsBag, createQueue, createWorker, type Job } from "./queue.js";

const REPEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

// ── The Redis client seam (R5 rollout, the dedup family) ─────────────────────
//
// FAIL-CLOSED PICK ANALYSIS (R5-S12's rule):
//   • commands ISSUED here: `zRangeByScore`, `zRem`.
//   • commands consumed DOWNSTREAM: none — the only thing this loop hands off is
//     the PARSED member, to `publishNatsEvent`, which takes no client.
//   • feature detection: none (measured, not assumed — F-22).
// So {issued} ∪ {downstream} = {zRangeByScore, zRem}.
//
// The other end of this queue is `packages/tools/src/intelligence/schedule-follow-up.ts`,
// which `zAdd`s `{score: fireAtMs, value: JSON}` onto the SAME key. Both ends
// now run through the shared in-memory adapter, so this poller's due window is a
// real score comparison rather than a stubbed array of members.

/** The node-redis v4 surface this poller drains. */
export type FollowUpPollerRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "zRangeByScore" | "zRem"
>;

export interface ProcessFollowUpsDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: FollowUpPollerRedis;
}

/**
 * Core job logic — exported for direct testing.
 *
 * `assertDepsBag`: F-32. BullMQ calls a processor as `(job, token)` with a
 * lock-token STRING, and this function's SECOND slot is the deps bag. It is not
 * what `startFollowUpPoller` registers (see the one-argument wrapper below), so
 * the collision is not live today — the guard is what keeps that true, because
 * registering this function directly would otherwise put the token in `deps`,
 * `("tok").redis` would read `undefined`, and every tick would silently fall
 * back to the singleton. See `assertDepsBag` in ./queue.ts for the full note.
 */
export async function processFollowUps(
  log?: FastifyBaseLogger | null,
  deps: ProcessFollowUpsDeps = {},
): Promise<void> {
  assertDepsBag("follow-up-poller", deps);
  const effectiveLogger = log ?? logger;
  const redis: FollowUpPollerRedis = deps.redis ?? (await getRedisClient());
  const scheduledKey = rk("follow-up:scheduled");
  const now = Date.now();

  // Fetch all entries whose fire time has passed
  const due = await redis.zRangeByScore(scheduledKey, 0, now);

  // NOISE-2: log only when there is work (idle ticks were pure heartbeat noise).
  if (due.length > 0) {
    effectiveLogger?.info(
      { component: "job.follow-up", event: "tick", batch_size: due.length },
      "follow-up poller processed batch",
    );
  }

  for (const member of due) {
    let parsed: { customerId: string; reason: string; scheduledAt: string };
    try {
      parsed = JSON.parse(member) as { customerId: string; reason: string; scheduledAt: string };
    } catch {
      // Malformed entry — remove it to avoid stuck processing
      await redis.zRem(scheduledKey, member);
      continue;
    }

    const { customerId, reason } = parsed;

    try {
      await publishNatsEvent("follow-up.due", { customerId, reason });
    } catch (err) {
      effectiveLogger?.error({ customerId, reason, error: String(err) }, "Failed to publish follow-up.due event");
      Sentry.withScope((scope) => {
        scope.setTag("job", "follow-up-poller");
        scope.setTag("source", "background-job");
        scope.setContext("follow_up", { customerId, reason });
        Sentry.captureException(err);
      });
      continue; // Leave in sorted set — will retry next tick
    }

    await redis.zRem(scheduledKey, member);
  }
  // NOISE-2: removed the duplicate "[follow-up-poller] tick complete" line —
  // it carried the same due.length as the tick log above.
}

export function startFollowUpPoller(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("follow-up-poller");
  // A ONE-ARGUMENT wrapper, the family's F-32 registration pattern: BullMQ calls
  // the registered function as `(job, token)`, and the extra token must land
  // nowhere rather than in a deps slot. `processFollowUps` takes `(log, deps)`,
  // so registering it bare would put the Job in `log` and the token in `deps`.
  worker = createWorker("follow-up-poller", (_job: Job) => processFollowUps());

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[follow-up-poller] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "follow-up-poller");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  // Add repeatable job + run immediately to drain any backlog from a restart
  void queue.upsertJobScheduler("follow-up-repeat", {
    every: REPEAT_INTERVAL_MS,
    immediately: true,
  });
}

export async function stopFollowUpPoller(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
