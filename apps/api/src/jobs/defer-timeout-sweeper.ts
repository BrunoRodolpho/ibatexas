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
// ── P1-E: Startup recovery scan + heartbeat ──────────────────────────────
//
// BullMQ's `upsertJobScheduler` does NOT replay missed runs. If the
// worker is down for >TTL on parked envelopes, Redis GCs the keys
// before any sweep fires — `intent.defer.timeout` is never published —
// the anonymize-grace-resolver (LGPD obligation enforcer) never runs,
// and the customer notification never goes out.
//
// The fix:
//   1. `runRecoveryScan()` on worker startup. Finds any expired-or-
//      imminently-expiring parked envelopes and publishes their timeouts
//      idempotently (SETNX `recovery:fired:{intentHash}` marker dedups
//      against subsequent normal sweeps).
//   2. Heartbeat key `heartbeat:defer-sweeper` updated every tick (60s
//      TTL). Downstream ops monitoring queries this for liveness; a
//      missing heartbeat indicates worker outage.
//
// ── audit-2026-05-24 P0-2: sweeper-vs-resolver mutex ─────────────────────
//
// Before publishing `intent.defer.timeout` for any parked envelope, the
// sweeper now SETNX'es the same `defer:resuming:{deferResumeHash}` key the
// defer-resolver claims when dispatching a resume. This serializes the two
// paths so a parked envelope at the TTL boundary cannot have BOTH a
// destructive timeout-handler fire AND a resume dispatch — exactly the
// double-execution class for intents whose timeout-side executor matches
// the resume-side executor (LGPD anonymize; any future PIX-timeout
// consumer per P1-7). The mutex's 60s TTL is the safety net for crashes
// between SETNX and publish; on commit the sweeper explicitly DELs it.
//
// CLAUDE.md rules honoured:
//   #7 rk() for all Redis keys (defer:pending:* matches what the responder
//      wrote when parking).
//   #4 No user-facing text here — the NATS event payload is internal; any
//      pt-BR phrasing lives in the downstream notification subscriber.

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { deferResumeHash, type ParkedEnvelope } from "@adjudicate/runtime";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";
// W3-7: bump kernel_defer_timeout_total{kind} per published timeout.
// Lazy `import()` so the sweeper's hot-path tests don't drag the entire
// kernel-bootstrap module graph (Packs, llm-provider, tool-registry) into
// their fixture. The recorder is fail-open so a missing registry
// (unit tests) is a no-op even when the import resolves.
async function bumpDeferTimeoutMetric(kind: string): Promise<void> {
  try {
    const { getKernelMetricsRecorder } = await import(
      "../plugins/kernel-bootstrap.js"
    );
    getKernelMetricsRecorder().recordDeferTimeout(kind);
  } catch {
    // Fail-open — sweeper hot path must never throw on a metric.
  }
}

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

// P1-E: heartbeat TTL — 2x the repeat interval so a single missed tick
// doesn't trigger a false alarm but two missed ticks do (worker outage).
const HEARTBEAT_TTL_SECONDS = (REPEAT_INTERVAL_MS / 1000) * 2;

// P1-E: dedup TTL for recovery-fired markers. Long enough that a recovery
// scan can't double-fire across consecutive startups; short enough that
// stale markers don't accumulate forever. Matches the runtime grace.
const RECOVERY_FIRED_TTL_SECONDS = 14 * 24 * 60 * 60; // 14d

// audit-2026-05-24 P0-2: sweeper-vs-resolver mutex TTL.
//
// The sweeper acquires the same `defer:resuming:{deferResumeHash}` key the
// defer-resolver uses (see apps/api/src/subscribers/defer-resolver.ts,
// `DEFER_RESUMING_TTL_SECONDS`) so that the two paths cannot both fire for
// the same parked envelope. Matches the resolver's 60s TTL — long enough
// for a publish + DEL to complete, short enough that a crashed sweeper
// doesn't permanently block resume.
const SWEEPER_RESUMING_TTL_SECONDS = 60;

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

  // P1-E: heartbeat — refresh on every tick so downstream monitoring can
  // detect worker outage. Best-effort; a failed heartbeat doesn't block
  // the sweep itself.
  await redis
    .set(rk("heartbeat:defer-sweeper"), new Date().toISOString(), {
      EX: HEARTBEAT_TTL_SECONDS,
    })
    .catch((err) => {
      effectiveLogger?.warn(
        { err: (err as Error).message },
        "[defer-timeout-sweeper] heartbeat refresh failed",
      );
    });

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
      // parkedAt for the timeout event. If the blob is non-null but
      // malformed (JSON.parse fails), we still publish a minimal event so
      // ops can see what got cleaned up — that's a genuine data-corruption
      // case worth surfacing.
      //
      // audit-2026-05-24 E3: if `raw === null` here, the key vanished
      // between our SCAN/TTL pass and this GET. The only path that DELs a
      // parkKey out from under the sweeper is the defer-resolver winning
      // the race (it DELs both the parkKey and the resuming mutex on
      // commit). Publishing `intent.defer.timeout` with empty intentHash +
      // empty signal under a session-scoped fallback mutex creates a
      // "ghost" event that no downstream consumer can match (all consumers
      // key on intentHash). The implicit contract of `intent.defer.timeout`
      // is "every event has a non-empty intentHash"; honour that contract
      // by suppressing the publish entirely. Future consumers (e.g., a
      // metrics counter or forensic replay) can trust the contract without
      // having to filter empty events.
      const raw = await redis.get(key).catch(() => null);
      const sessionId = parseSessionId(key);
      if (raw === null) {
        effectiveLogger?.debug(
          { parkKey: key },
          "sweeper: parkKey vanished between SCAN/TTL and GET — resolver won the race; suppressing publish",
        );
        continue;
      }
      let intentHash = "";
      let signal = "";
      let parkedAt = "";
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

      // P1-E: dedup against the recovery scan. If a recovery scan fired
      // this timeout already (e.g., worker restarted between recovery and
      // the first tick), SETNX returns null and we skip — the recovery
      // scan was the one source of truth for this intent.
      const recoveryKey = rk(
        `recovery:fired:${intentHash || sessionId}`,
      );
      const acquired = await redis
        .set(recoveryKey, new Date().toISOString(), {
          NX: true,
          EX: RECOVERY_FIRED_TTL_SECONDS,
        })
        .catch(() => null);
      if (acquired !== "OK") {
        effectiveLogger?.debug(
          { sessionId, intentHash, signal, ttl },
          "[defer-timeout-sweeper] timeout already fired by recovery scan — skipping",
        );
        // Still DEL the parked key so it doesn't loop forever.
        await redis.del(key).catch(() => {});
        continue;
      }

      // audit-2026-05-24 P0-2: sweeper-vs-resolver mutex.
      //
      // SETNX the same `defer:resuming:{deferResumeHash}` key the defer-resolver
      // claims before dispatching. If the resolver is mid-flight (signal arrived
      // just-in-time as TTL crossed the imminent threshold), we MUST NOT publish
      // `intent.defer.timeout` — that would race against the resolver's resume
      // for destructive intents whose timeout-handler runs the same executor
      // (e.g., LGPD anonymize) or for any future PIX-timeout consumer (P1-7).
      // The resolver, on commit, deletes both the resuming marker and the
      // parked key; the next sweep tick sees nothing to do. If the resolver
      // crashes mid-flight, the resuming marker's TTL clears the lock; the
      // next sweep tick re-acquires + publishes.
      //
      // When intentHash is unavailable (malformed park blob), we can't derive
      // the same key the resolver would; fall back to a session-scoped lock
      // so the legitimate-malformed-blob path still serializes against ops
      // tooling that may resolve by sessionId.
      const resumingMutexKey = rk(
        intentHash && signal
          ? `defer:resuming:${deferResumeHash(intentHash, signal)}`
          : `defer:resuming:fallback:${sessionId}`,
      );
      const mutexAcquired = await redis
        .set(resumingMutexKey, new Date().toISOString(), {
          NX: true,
          EX: SWEEPER_RESUMING_TTL_SECONDS,
        })
        .catch(() => null);
      if (mutexAcquired !== "OK") {
        effectiveLogger?.debug(
          { sessionId, intentHash, signal, ttl },
          "[defer-timeout-sweeper] resolver mid-flight — skipping timeout publish",
        );
        // Release the recovery marker so the next sweep can re-fire if the
        // resolver crashes and the parked key is still around.
        await redis.del(recoveryKey).catch(() => {});
        // Do NOT DEL the parked key — the resolver owns its lifecycle.
        continue;
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
        // publish failed so the next sweep retries. Also release the
        // dedup marker AND the sweeper mutex so retry can re-claim them.
        await redis.del(recoveryKey).catch(() => {});
        await redis.del(resumingMutexKey).catch(() => {});
        effectiveLogger?.error(
          { key, err: (publishErr as Error).message },
          "[defer-timeout-sweeper] publishNatsEvent failed — leaving key for retry",
        );
        continue;
      }

      // W3-7 — bump kernel_defer_timeout_total{kind} after the publish
      // succeeded. The resume `signal` is the closest available "kind"
      // label; the original intent kind isn't part of the parked payload
      // schema today. Recorder is fail-open by design.
      await bumpDeferTimeoutMetric(signal || "unknown");

      // Idempotent cleanup. DEL the parked key so subsequent sweeps don't
      // re-publish for the same session.
      await redis.del(key).catch(() => {
        // Best-effort. Even if DEL fails, the Redis TTL will eventually
        // garbage-collect the key.
      });

      // audit-2026-05-24 P0-2: release the sweeper-vs-resolver mutex now that
      // both the publish and the parked-key DEL have completed. The marker's
      // TTL would clean it up anyway, but explicit release lets unrelated
      // resumes for the same (intentHash, signal) pair re-enter without
      // waiting on the 60s TTL.
      await redis.del(resumingMutexKey).catch(() => {});

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

/**
 * P1-E — Recovery scan run on worker startup.
 *
 * BullMQ's `upsertJobScheduler` does NOT replay missed runs across worker
 * downtime. If the sweeper is down for >TTL, parked envelopes silently
 * expire and `intent.defer.timeout` is never published — the LGPD
 * anonymize-grace-resolver never fires, the customer notification never
 * goes out.
 *
 * The recovery scan fires on each startup BEFORE the repeatable job is
 * registered. It SCANs the parked-envelope namespace, finds any keys at
 * or past their deadline, and publishes `intent.defer.timeout` events
 * idempotently. A `recovery:fired:{intentHash}` SETNX marker dedups
 * against subsequent normal sweeps so the same envelope's timeout isn't
 * published twice (once by recovery, once by the next 60s tick).
 *
 * Returns the count of recovery-fired events. Logs + Sentry on completion
 * so ops can see how many envelopes were caught during downtime.
 */
export async function runRecoveryScan(
  log?: FastifyBaseLogger | null,
): Promise<number> {
  const effectiveLogger = log ?? logger;
  let recoveryFiredCount = 0;

  let redis: Awaited<ReturnType<typeof getRedisClient>>;
  try {
    redis = await getRedisClient();
  } catch (err) {
    effectiveLogger?.error(
      { err: (err as Error).message },
      "[defer-timeout-sweeper] Redis unavailable during recovery scan",
    );
    return 0;
  }

  effectiveLogger?.info(
    { run_at: new Date().toISOString() },
    "[defer-timeout-sweeper] starting recovery scan",
  );

  // Same SCAN pattern as the regular sweep — the recovery scan is a
  // one-shot variant of the same logic, with the additional idempotency
  // marker.
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
      "[defer-timeout-sweeper] SCAN failed during recovery scan",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", "defer-timeout-sweeper");
      scope.setTag("source", "recovery-scan");
      Sentry.captureException(err);
    });
    return 0;
  }

  for (const key of candidates) {
    try {
      const ttl = await redis.ttl(key).catch(() => -2);
      if (ttl === -2) continue;
      // For recovery scan: pick up everything ≤ IMMINENT_TTL_SECONDS, same
      // threshold as the steady-state sweep. Anything fresher is owned
      // by the next normal tick.
      if (ttl > IMMINENT_TTL_SECONDS) continue;

      // audit-2026-05-24 E3: same race-loser suppression as the
      // steady-state sweep — if `raw === null`, the parkKey vanished
      // between SCAN/TTL and GET (resolver won the race and DEL'd it on
      // commit). Publishing an empty-intentHash ghost violates the
      // `intent.defer.timeout` contract; skip.
      const raw = await redis.get(key).catch(() => null);
      const sessionId = parseSessionId(key);
      if (raw === null) {
        effectiveLogger?.debug(
          { parkKey: key },
          "sweeper: parkKey vanished between SCAN/TTL and GET — resolver won the race; suppressing publish",
        );
        continue;
      }
      let intentHash = "";
      let signal = "";
      let parkedAt = "";
      try {
        const parked = JSON.parse(raw) as ParkedEnvelope;
        intentHash = parked.envelope?.intentHash ?? "";
        signal = parked.signal ?? "";
        parkedAt = parked.parkedAt ?? "";
      } catch (parseErr) {
        effectiveLogger?.warn(
          { key, err: (parseErr as Error).message },
          "[defer-timeout-sweeper] malformed parked envelope during recovery — publishing minimal timeout",
        );
      }

      // Idempotency: SETNX the recovery-fired marker keyed by intentHash.
      // If a previous sweep (recovery or steady-state) already fired the
      // timeout for this intent, we skip. Falls back to sessionId when
      // intentHash is unavailable (malformed blob).
      const recoveryKey = rk(
        `recovery:fired:${intentHash || sessionId}`,
      );
      const acquired = await redis
        .set(recoveryKey, new Date().toISOString(), {
          NX: true,
          EX: RECOVERY_FIRED_TTL_SECONDS,
        })
        .catch(() => null);
      if (acquired !== "OK") {
        effectiveLogger?.debug(
          { sessionId, intentHash, signal, ttl },
          "[defer-timeout-sweeper] recovery: timeout already fired — skipping",
        );
        continue;
      }

      // audit-2026-05-24 P0-2: sweeper-vs-resolver mutex. Same coordination
      // pattern as the steady-state sweep — if the defer-resolver is already
      // mid-flight for this (intentHash, signal) pair, don't publish a
      // duplicate `intent.defer.timeout`. Mirrors the resolver's
      // `defer:resuming:{deferResumeHash}` lock.
      const resumingMutexKey = rk(
        intentHash && signal
          ? `defer:resuming:${deferResumeHash(intentHash, signal)}`
          : `defer:resuming:fallback:${sessionId}`,
      );
      const mutexAcquired = await redis
        .set(resumingMutexKey, new Date().toISOString(), {
          NX: true,
          EX: SWEEPER_RESUMING_TTL_SECONDS,
        })
        .catch(() => null);
      if (mutexAcquired !== "OK") {
        effectiveLogger?.debug(
          { sessionId, intentHash, signal, ttl },
          "[defer-timeout-sweeper] recovery: resolver mid-flight — skipping",
        );
        // Release the recovery marker so the next attempt can re-claim it
        // once the resolver completes (or its lock expires).
        await redis.del(recoveryKey).catch(() => {});
        continue;
      }

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
        // Same as steady-state: don't DEL key on publish failure. Release
        // the dedup marker AND the sweeper mutex so the next attempt can retry.
        await redis.del(recoveryKey).catch(() => {});
        await redis.del(resumingMutexKey).catch(() => {});
        effectiveLogger?.error(
          { key, err: (publishErr as Error).message },
          "[defer-timeout-sweeper] recovery: publishNatsEvent failed — leaving key for retry",
        );
        continue;
      }

      // W3-7 — recovery path bumps kernel_defer_timeout_total too.
      await bumpDeferTimeoutMetric(signal || "unknown");

      await redis.del(key).catch(() => {});

      // audit-2026-05-24 P0-2: release the sweeper-vs-resolver mutex; the
      // TTL is the safety net for crashes between publish and release.
      await redis.del(resumingMutexKey).catch(() => {});

      recoveryFiredCount++;
      effectiveLogger?.info(
        { sessionId, intentHash, signal, ttl },
        "[defer-timeout-sweeper] RECOVERY published intent.defer.timeout — worker was down during deadline",
      );
    } catch (err) {
      effectiveLogger?.error(
        { key, err: (err as Error).message },
        "[defer-timeout-sweeper] error during recovery for key",
      );
      Sentry.withScope((scope) => {
        scope.setTag("job", "defer-timeout-sweeper");
        scope.setTag("source", "recovery-scan");
        scope.setContext("parked", { key });
        Sentry.captureException(err);
      });
    }
  }

  // Always log + Sentry-tagged so ops can correlate to deploys.
  effectiveLogger?.info(
    {
      recovery_fired_count: recoveryFiredCount,
      run_at: new Date().toISOString(),
    },
    "[defer-timeout-sweeper] recovery scan complete",
  );
  if (recoveryFiredCount > 0) {
    Sentry.withScope((scope) => {
      scope.setTag("job", "defer-timeout-sweeper");
      scope.setTag("source", "recovery-scan");
      scope.setContext("recovery", { recoveryFiredCount });
      Sentry.captureMessage(
        `[defer-timeout-sweeper] recovery sweep fired ${recoveryFiredCount} events`,
        "info",
      );
    });
  }
  return recoveryFiredCount;
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

  // P1-E: kick off the recovery scan fire-and-forget BEFORE registering
  // the repeatable job. If the worker was down through one or more TTL
  // expirations, this catches the missed envelopes and publishes their
  // timeouts idempotently (the SETNX recovery-fired marker dedups against
  // the first normal sweep). We don't await — the recovery scan can run
  // alongside the steady-state ticks (the marker prevents double-fire).
  void runRecoveryScan(logger).catch((err) => {
    logger?.error(
      { err: (err as Error).message },
      "[defer-timeout-sweeper] startup recovery scan threw",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", "defer-timeout-sweeper");
      scope.setTag("source", "recovery-scan");
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
