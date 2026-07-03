// DLQ-depth checker — deterministic ops watchdog (NEW-025 detection half).
//
// Runs every 5 minutes via BullMQ repeatable job. SCANs the Redis dead-letter
// lists (`{env}:dlq:*`, written by `pushToDlq`) and RAISES a governed ops-alert
// (`ops.alert.open`, cause `ops_dlq_depth`) for any DLQ whose depth crosses the
// alert threshold — surfacing "messages are dead-lettering and piling up" to the
// admin ops inbox + the future ops agent, instead of only a per-entry Sentry
// warning nobody watches. When a previously-alerting DLQ drains back below the
// threshold, its open alert AUTO-resolves.
//
// This is the ONE genuinely-missing detector of the four NEW-025 watchdogs: the
// stuck-order / PIX-expiry / stale-defer conditions already have detect-and-act
// loops; DLQ depth had no watchdog at all (only the passive `/health` read).
//
// Governance: every raise/resolve is a SYSTEM-actor `ops.alert.*` IntentEnvelope
// (buildSystemEnvelope) adjudicated by the SYSTEM-only ops-alert policy bundle
// (CLAUDE.md rule #9). The LLM never raises ops alerts. Deliberately SEPARATE
// from the conversation-incident plane (owner decision 2026-07-03).

import { getRedisClient, rk } from "@ibatexas/tools";
import {
  createOpsAlertService,
  OPS_ALERT_CAUSE_LABELS_PT,
  type OpsAlertService,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";
import { createQueue, createWorker, type Job } from "./queue.js";

const REPEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * A DLQ at or above this depth raises an ops alert. Env-overridable (a burst of
 * a few dead-letters is normal noise; a sustained backlog is the signal). One
 * alert per DLQ subject — repeat sweeps fold into it (occurrences++).
 */
const ALERT_THRESHOLD = process.env.OPS_DLQ_ALERT_THRESHOLD
  ? Number(process.env.OPS_DLQ_ALERT_THRESHOLD)
  : 25;

const SCAN_COUNT = 100;

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

// ── Pure helpers (exported for exhaustive unit testing) ─────────────────────

/**
 * Severity band for a DLQ depth. Monotonic in depth:
 *   - `high`   ≥ 4× threshold (a serious, growing backlog)
 *   - `medium` ≥ 2× threshold
 *   - `low`    ≥ 1× threshold (just crossed — worth surfacing, not urgent)
 * Below threshold no alert is raised, so `low` is the floor of the alerting band.
 */
export function dlqDepthSeverity(
  depth: number,
  threshold: number,
): "low" | "medium" | "high" {
  if (depth >= threshold * 4) return "high";
  if (depth >= threshold * 2) return "medium";
  return "low";
}

/** Recover the DLQ event name (the segment AFTER `:dlq:`) from a full Redis key. */
export function parseDlqEventName(key: string): string | null {
  const idx = key.indexOf(":dlq:");
  if (idx < 0) return null;
  const event = key.slice(idx + ":dlq:".length);
  return event.length > 0 ? event : null;
}

export interface DlqAlertPlan {
  /** DLQs at/over threshold → raise (or fold) an ops alert. */
  readonly raise: ReadonlyArray<{
    readonly event: string;
    readonly depth: number;
    readonly severity: "low" | "medium" | "high";
  }>;
  /** Open-alert ids whose DLQ is now below threshold (or gone) → AUTO-resolve. */
  readonly resolve: ReadonlyArray<{ readonly id: string; readonly event: string }>;
}

/**
 * PURE detection logic (no IO). Given the observed DLQ depths and the currently
 * OPEN `ops_dlq_depth` alerts keyed by their scope (the DLQ event name), decide
 * which conditions to RAISE (depth ≥ threshold) and which open alerts to
 * AUTO-RESOLVE (their DLQ drained below threshold or vanished). Deterministic +
 * order-stable over the depths' insertion order.
 */
export function planDlqAlertActions(args: {
  readonly depths: ReadonlyMap<string, number>;
  readonly openByScope: ReadonlyMap<string, string>; // scope(event) → alertId
  readonly threshold: number;
}): DlqAlertPlan {
  const { depths, openByScope, threshold } = args;
  const raise: Array<{ event: string; depth: number; severity: "low" | "medium" | "high" }> = [];
  const overThreshold = new Set<string>();

  for (const [event, depth] of depths) {
    if (depth >= threshold) {
      overThreshold.add(event);
      raise.push({ event, depth, severity: dlqDepthSeverity(depth, threshold) });
    }
  }

  // AUTO-resolve any open alert whose DLQ is no longer over threshold. A DLQ that
  // has fully drained no longer appears in `depths` (lLen 0 keys are skipped by
  // the caller); one that shrank below threshold appears but is not in
  // `overThreshold`. Both mean "condition cleared".
  const resolve: Array<{ id: string; event: string }> = [];
  for (const [event, id] of openByScope) {
    if (!overThreshold.has(event)) resolve.push({ id, event });
  }

  return { raise, resolve };
}

// ── IO wiring ───────────────────────────────────────────────────────────────

export interface CheckDlqDepthDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: {
    scanIterator: (opts: { MATCH: string; COUNT: number }) => AsyncIterable<string>;
    lLen: (key: string) => Promise<number>;
  };
  /** Injected for tests. Defaults to a fresh audited OpsAlertService. */
  readonly svc?: OpsAlertService;
}

/** Core job logic — exported for direct testing. */
export async function checkDlqDepth(
  log?: FastifyBaseLogger | null,
  deps: CheckDlqDepthDeps = {},
): Promise<void> {
  const effectiveLogger = log ?? logger;
  const svc = deps.svc ?? createOpsAlertService({ auditSink: getAuditSink(), log: effectiveLogger ?? undefined });

  try {
    const redis = deps.redis ?? (await getRedisClient());

    // (1) Observe every non-empty DLQ list's depth.
    const depths = new Map<string, number>();
    const prefix = rk("dlq:");
    for await (const key of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: SCAN_COUNT })) {
      const event = parseDlqEventName(key);
      if (event === null) continue;
      const depth = await redis.lLen(key);
      if (depth > 0) depths.set(event, depth);
    }

    // (2) Load the currently-open ops_dlq_depth alerts, keyed by their DLQ scope.
    const { alerts } = await svc.list({ cause: "ops_dlq_depth", limit: 500 });
    const openByScope = new Map<string, string>();
    for (const a of alerts) {
      if ((a.status === "OPEN" || a.status === "ACKNOWLEDGED") && a.scope) {
        openByScope.set(a.scope, a.id);
      }
    }

    // (3) Decide (pure) and (4) apply through the governed service.
    const plan = planDlqAlertActions({ depths, openByScope, threshold: ALERT_THRESHOLD });
    const sweepAt = Date.now();

    for (const r of plan.raise) {
      const dedupeKey = `ops_dlq_depth:${r.event}`;
      const envelope = buildSystemEnvelope({
        kind: "ops.alert.open" as const,
        payload: {
          cause: "ops_dlq_depth" as const,
          severity: r.severity,
          source: "dlq-depth-checker",
          scope: r.event,
          title: `${OPS_ALERT_CAUSE_LABELS_PT.ops_dlq_depth}: ${r.event} (${r.depth})`,
          detail: `A fila de mensagens mortas "${r.event}" tem ${r.depth} entradas (limite ${ALERT_THRESHOLD}).`,
          context: { event: r.event, depth: r.depth, threshold: ALERT_THRESHOLD },
          dedupeKey,
        },
        sourceSubject: "dlq-depth-checker",
        eventId: `${dedupeKey}:${sweepAt}`,
      });
      const outcome = await svc.openAlertFromEnvelope(envelope, {});
      if (outcome.decision.kind !== "EXECUTE") {
        effectiveLogger?.warn(
          { event: r.event, decision: outcome.decision.kind },
          "[dlq-depth] ops-alert open not authorized — skipping",
        );
      }
    }

    for (const c of plan.resolve) {
      const envelope = buildSystemEnvelope({
        kind: "ops.alert.resolve" as const,
        payload: { id: c.id, resolvedBy: "system", resolutionType: "AUTO" as const },
        sourceSubject: "dlq-depth-checker",
        eventId: `ops_dlq_depth:${c.event}:resolve:${sweepAt}`,
      });
      await svc.resolveAlertFromEnvelope(envelope, {});
    }

    if (plan.raise.length > 0 || plan.resolve.length > 0) {
      effectiveLogger?.info(
        {
          component: "job.dlq-depth",
          event: "sweep",
          raised: plan.raise.length,
          resolved: plan.resolve.length,
        },
        "DLQ-depth sweep raised/resolved ops alerts",
      );
    }
  } catch (err) {
    effectiveLogger?.error({ error: String(err) }, "[dlq-depth] Error during DLQ-depth sweep");
    Sentry.withScope((scope) => {
      scope.setTag("job", "dlq-depth-checker");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  }
}

/** BullMQ processor — wraps the core logic. */
async function processor(_job: Job): Promise<void> {
  await checkDlqDepth();
}

export function startDlqDepthChecker(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("dlq-depth-checker");
  worker = createWorker("dlq-depth-checker", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[dlq-depth-checker] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "dlq-depth-checker");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  void queue.upsertJobScheduler("dlq-depth-repeat", { every: REPEAT_INTERVAL_MS });
}

export async function stopDlqDepthChecker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
