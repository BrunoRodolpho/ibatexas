// Escalation park-expiry sweeper — BKL-114.
//
// Why this exists (queue hygiene, not money safety):
//   An escalation record (rk("escalation:rec:<sessionId>")) can carry parked,
//   approval-pending money intents in `pendingIntents[]`. Each row references a
//   single-use park token whose backing key (rk("escalation:park:<token>"))
//   lives in Redis with a 24h TTL. When that TTL lapses WITHOUT an OWNER
//   decision, Redis silently GCs the park key — but the projection row on the
//   escalation record stays `status: "pending"` FOREVER. The `expired` status
//   already exists in the enum, the route schema, and the admin UI, but NOTHING
//   sets it today. So the escalações inbox shows stale "aguardando aprovação"
//   rows that can never be actioned (their token already 404s on resolve).
//
//   Money is safe either way: a lapsed token is already gone, so a resume/resolve
//   attempt 404s. This sweep only RELABELS a dead projection row so the inbox
//   reflects reality.
//
// The full-namespace SCAN (design-critical):
//   There is NO index of records-that-hold-pending-intents, and rk("escalation:open")
//   is INCOMPLETE for this purpose: resolve() flips a record to `resolved` and
//   removes it from `escalation:open` but LEAVES pendingIntents[] untouched — so a
//   RESOLVED record can still hold a `status: "pending"` row. Therefore we MUST
//   SCAN the full rk("escalation:rec:*") namespace and filter pendingIntents by
//   status, NOT enumerate from escalation:open (which would miss resolved-record
//   pending intents), and NOT try to scan park keys (an absent/lapsed key cannot
//   be scanned for).
//
// The CAS-guard correctness invariant:
//   A CONSUMED park (a successful resolve DEL'd the token) and a LAPSED park (TTL
//   GC) both read as "gone" to this sweeper. So we never blind-write "expired" —
//   `EscalationStore.markIntentExpired` is COMPARE-AND-SET on `status === "pending"`
//   (re-reading current state), a no-op for any row that has since moved to
//   approved/rejected/denied_by_kernel/execute_failed. Without that guard the
//   sweeper could clobber a legitimately-resolved row.
//
// Chassis: BullMQ repeatable job (mirrors defer-timeout-sweeper / dlq-depth-checker).
// CLAUDE.md rules honoured:
//   #7 rk() for every Redis key (record namespace + per-token park key).
//   #4 no user-facing text — a status flip is internal projection state.
//   #9 NOT a governed kernel mutation: this is projection-status hygiene on a
//      lapsed row, system-authored (resolvedBy = "system"), no IntentEnvelope.

import { getRedisClient, rk } from "@ibatexas/tools";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import {
  createEscalationStore,
  type EscalationRecord,
  type EscalationRedis,
  type EscalationStore,
} from "../escalation/escalation-store.js";
import { createQueue, createWorker, type Job } from "./queue.js";

// Low-urgency queue hygiene: a lapsed park is already harmless (404s on
// resolve); we only relabel the projection. 5 min matches the DLQ-depth checker.
const REPEAT_INTERVAL_MS = 5 * 60 * 1000;

// SCAN batch size — small enough to bound memory, large enough to absorb a
// typical escalation namespace in a few round-trips.
const SCAN_COUNT = 100;

// Hard cap so one sweep stays bounded if the record namespace has grown large;
// the next tick picks up the rest.
const MAX_KEYS_PER_SWEEP = 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/** The minimal node-redis v4 surface this sweeper reads (injectable for tests). */
export interface SweeperRedis {
  scanIterator(opts: {
    MATCH: string;
    COUNT: number;
  }): AsyncIterable<string | string[]>;
  get(key: string): Promise<string | null>;
  /** Non-consuming park-existence probe: 0 when absent/lapsed, ≥1 when alive. */
  exists(key: string): Promise<number>;
}

export interface SweepEscalationParkExpiryDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: SweeperRedis;
  /** Injected for tests. Defaults to a store over the shared Redis client. */
  readonly store?: EscalationStore;
  /** Injected clock for the `expired` stamp. Defaults to wall-clock ISO. */
  readonly nowIso?: () => string;
}

export interface EscalationParkSweepResult {
  /** Record keys examined this sweep. */
  readonly scanned: number;
  /** Pending intents flipped pending → expired this sweep. */
  readonly expired: number;
}

/**
 * SCAN the full escalation-record namespace and collect up to
 * MAX_KEYS_PER_SWEEP candidate keys. SCAN errors propagate to the caller, which
 * owns the logging + Sentry tagging.
 */
async function collectRecordKeys(redis: SweeperRedis): Promise<string[]> {
  const keys: string[] = [];
  const pattern = rk("escalation:rec:*");
  for await (const key of redis.scanIterator({
    MATCH: pattern,
    COUNT: SCAN_COUNT,
  })) {
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
    if (keys.length >= MAX_KEYS_PER_SWEEP) break;
  }
  return keys;
}

/**
 * Process one escalation record: for every `pending` intent whose backing park
 * key is ABSENT (lapsed or consumed), CAS-flip it to `expired`. Returns the
 * number of intents expired for this record. Per-record try/catch containment
 * lives in the caller — a malformed record here throws and is skipped there.
 */
async function processRecordKey(
  redis: SweeperRedis,
  store: EscalationStore,
  key: string,
  nowIso: () => string,
  log?: FastifyBaseLogger | null,
): Promise<number> {
  const raw = await redis.get(key);
  if (raw === null) return 0; // vanished between SCAN and GET — nothing to do.

  // Per-record containment: a malformed record must not abort the sweep. Parse
  // here (not in a shared helper) so the throw is caught by the caller's loop.
  const rec = JSON.parse(raw) as EscalationRecord;
  const pending = (rec.pendingIntents ?? []).filter(
    (p) => p.status === "pending",
  );
  if (pending.length === 0) return 0;

  let expired = 0;
  for (const intent of pending) {
    // Non-consuming existence probe. An absent/lapsed key returns 0; a live park
    // returns ≥1. NEVER consume/DEL the park here — resolve owns its lifecycle.
    const present = (await redis.exists(rk(`escalation:park:${intent.token}`))) > 0;
    if (present) continue; // park still alive — the intent is legitimately pending.

    // Park gone. CAS-flip pending → expired (a no-op if the row raced to a
    // terminal status since the scan — see markIntentExpired's load-bearing guard).
    const updated = await store.markIntentExpired(
      rec.sessionId,
      intent.intentHash,
      nowIso(),
    );
    if (updated) {
      expired++;
      log?.debug(
        {
          component: "job.escalation-park-expiry",
          sessionId: rec.sessionId,
          intentHash: intent.intentHash,
          token: intent.token,
        },
        "[escalation-park-expiry-sweeper] lapsed pending intent → expired",
      );
    }
  }
  return expired;
}

/**
 * Core sweep — exported for direct unit testing without BullMQ.
 *
 * Idempotent by construction: an already-`expired` row is filtered out (only
 * `pending` rows are considered), so re-running is a no-op for prior work. This
 * is also why the startup recovery scan is just one immediate call to this
 * function — no dedup markers needed (unlike defer-timeout-sweeper).
 */
export async function sweepEscalationParkExpiry(
  log?: FastifyBaseLogger | null,
  deps: SweepEscalationParkExpiryDeps = {},
): Promise<EscalationParkSweepResult> {
  const effectiveLogger = log ?? logger;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  let redis = deps.redis;
  let store = deps.store;
  if (!redis || !store) {
    let client: Awaited<ReturnType<typeof getRedisClient>>;
    try {
      client = await getRedisClient();
    } catch (err) {
      // Redis-down → 0, never throw (the worker must not take down the server).
      effectiveLogger?.error(
        { err: (err as Error).message },
        "[escalation-park-expiry-sweeper] Redis unavailable — skipping sweep",
      );
      return { scanned: 0, expired: 0 };
    }
    redis ??= client as unknown as SweeperRedis;
    store ??= createEscalationStore(client as unknown as EscalationRedis);
  }

  let keys: string[];
  try {
    keys = await collectRecordKeys(redis);
  } catch (err) {
    effectiveLogger?.error(
      { err: (err as Error).message },
      "[escalation-park-expiry-sweeper] SCAN failed",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", "escalation-park-expiry-sweeper");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
    return { scanned: 0, expired: 0 };
  }

  let scanned = 0;
  let expired = 0;
  for (const key of keys) {
    scanned++;
    try {
      expired += await processRecordKey(redis, store, key, nowIso, effectiveLogger);
    } catch (err) {
      // Per-record error containment (malformed JSON, transient Redis error on a
      // single key). Continue with the rest of the batch — one bad record must
      // never abort the sweep.
      effectiveLogger?.warn(
        { key, err: (err as Error).message },
        "[escalation-park-expiry-sweeper] error processing record — skipping",
      );
      Sentry.withScope((scope) => {
        scope.setTag("job", "escalation-park-expiry-sweeper");
        scope.setTag("source", "background-job");
        scope.setContext("record", { key });
        Sentry.captureException(err);
      });
    }
  }

  effectiveLogger?.info(
    {
      component: "job.escalation-park-expiry",
      event: "sweep",
      scanned,
      expired,
    },
    "[escalation-park-expiry-sweeper] sweep complete",
  );
  return { scanned, expired };
}

/** BullMQ processor — wraps the core logic. */
async function processor(_job: Job): Promise<void> {
  await sweepEscalationParkExpiry();
}

export function startEscalationParkExpirySweeper(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("escalation-park-expiry-sweeper");
  worker = createWorker("escalation-park-expiry-sweeper", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[escalation-park-expiry-sweeper] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "escalation-park-expiry-sweeper");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  // Startup recovery scan — BullMQ's upsertJobScheduler does NOT replay runs
  // missed during worker downtime. Fire one immediate sweep before registering
  // the repeatable job so a park that lapsed while the worker was down is caught
  // now. Fire-and-forget: the sweep is inherently idempotent (CAS-on-pending),
  // so it can run alongside the first steady-state tick without double-work.
  void sweepEscalationParkExpiry(logger).catch((err) => {
    logger?.error(
      { err: (err as Error).message },
      "[escalation-park-expiry-sweeper] startup recovery sweep threw",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", "escalation-park-expiry-sweeper");
      scope.setTag("source", "recovery-scan");
      Sentry.captureException(err);
    });
  });

  void queue.upsertJobScheduler("escalation-park-expiry-repeat", {
    every: REPEAT_INTERVAL_MS,
  });
}

export async function stopEscalationParkExpirySweeper(): Promise<void> {
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
