// F3 — behavioral-drift evaluation job (completes the deferred drift→/metrics wiring).
//
// The drift DETECTOR + the fail-open audit-sink tee already landed (commit
// 23a597c, observability/drift-detector.ts). What was missing — and what this
// adds — is (a) a scheduled BullMQ job that calls evaluateDrift() on a cadence,
// and (b) Prometheus gauges/counter registered on the SHARED kernel registry
// (getKernelRegistry — the one GET /metrics serves) so behavioral drift is
// scrapeable.
//
// Determinism fence: these metrics are registered on the shared registry from
// THIS job module, NOT inside the kernel MetricsSink. The kernel's hashed path
// is untouched (core stays 456). Names are distinct from kernel_replay_drift_total
// (replay/golden-vector drift) — this is statistical/behavioral drift.
//
// Fail-open: evaluate() is no-throw and the whole body is wrapped; a drift-eval
// failure NEVER blocks a turn (it runs in a separate worker loop) and never
// crashes the worker. Mirrors the defer-timeout-sweeper BullMQ pattern.

import { Counter, Gauge, type Registry } from "prom-client";
import * as Sentry from "@sentry/node";
import type { FastifyBaseLogger } from "fastify";
import type { Queue, Worker } from "bullmq";
import type { DriftAlert } from "@adjudicate/drift";
import { createQueue, createWorker, type Job } from "./queue.js";
import { getKernelRegistry } from "../plugins/kernel-bootstrap.js";
import { evaluateDrift } from "../observability/drift-detector.js";

// Cadence — env-tunable, consistent with the IBX_DRIFT_* family. Default 60s:
// comfortably shorter than the time ~baselineWindow records take to flow, so a
// sustained shift is caught.
const EVAL_INTERVAL_MS = (() => {
  const n = Number.parseInt(process.env.IBX_DRIFT_EVAL_INTERVAL_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

// The dimensions the detector tracks (kept in sync with drift-detector.ts).
const DIMENSIONS = ["decision.kind", "intent.kind", "basis"] as const;

const MAGNITUDE = "ibx_behavioral_drift_magnitude";
const ALERTS_TOTAL = "ibx_behavioral_drift_alerts_total";
const ACTIVE = "ibx_behavioral_drift_active";
const LAST_EVAL = "ibx_behavioral_drift_last_eval_timestamp_seconds";

interface DriftMetrics {
  readonly magnitude: Gauge<string>;
  readonly alertsTotal: Counter<string>;
  readonly active: Gauge<string>;
  readonly lastEval: Gauge<string>;
}

/**
 * Idempotent per-registry metric registration. prom-client throws on a duplicate
 * name, so reuse an already-registered instance (recover-by-name) — this also lets
 * the unit test pass a fresh Registry each run while prod reuses getKernelRegistry().
 */
export function registerDriftMetrics(register: Registry): DriftMetrics {
  const magnitude =
    (register.getSingleMetric(MAGNITUDE) as Gauge<string> | undefined) ??
    new Gauge({
      name: MAGNITUDE,
      help: "Behavioral-drift magnitude of the most recent crossing (TVD / proportion-delta / 1 for new_category).",
      labelNames: ["dimension", "signal", "category"],
      registers: [register],
    });
  const alertsTotal =
    (register.getSingleMetric(ALERTS_TOTAL) as Counter<string> | undefined) ??
    new Counter({
      name: ALERTS_TOTAL,
      help: "Count of drift evaluations in which a crossing was present (re-fires while a crossing persists).",
      labelNames: ["dimension", "signal"],
      registers: [register],
    });
  const active =
    (register.getSingleMetric(ACTIVE) as Gauge<string> | undefined) ??
    new Gauge({
      name: ACTIVE,
      help: "1 if a drift crossing is currently present for the dimension, else 0 (reset each evaluation).",
      labelNames: ["dimension"],
      registers: [register],
    });
  const lastEval =
    (register.getSingleMetric(LAST_EVAL) as Gauge<string> | undefined) ??
    new Gauge({
      name: LAST_EVAL,
      help: "Unix timestamp (seconds) of the last drift evaluation (liveness).",
      registers: [register],
    });
  return { magnitude, alertsTotal, active, lastEval };
}

/**
 * Core evaluation — exported for direct unit testing without BullMQ. Recomputes
 * drift and maps the alerts onto the gauges/counter. Fail-open: never throws.
 * Returns the number of alerts this tick.
 */
export function evaluateDriftMetrics(
  register: Registry,
  log?: FastifyBaseLogger | null,
): number {
  try {
    const m = registerDriftMetrics(register);
    const alerts: ReadonlyArray<DriftAlert> = evaluateDrift();
    // Reset per-dimension "active" to 0 before re-marking this tick's crossings.
    for (const dimension of DIMENSIONS) m.active.set({ dimension }, 0);
    for (const a of alerts) {
      const category = a.category ?? "__all__";
      m.magnitude.set(
        { dimension: a.dimension, signal: a.signal, category },
        a.magnitude,
      );
      m.alertsTotal.inc({ dimension: a.dimension, signal: a.signal });
      m.active.set({ dimension: a.dimension }, 1);
    }
    m.lastEval.set(Date.now() / 1000);
    return alerts.length;
  } catch (err) {
    log?.error?.(
      { err: (err as Error).message },
      "[drift-evaluate] evaluation failed (fail-open)",
    );
    Sentry.withScope((scope) => {
      scope.setTag("job", "drift-evaluate");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
    return 0;
  }
}

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/** BullMQ processor — wraps the core logic against the shared kernel registry. */
async function processor(_job: Job): Promise<void> {
  evaluateDriftMetrics(getKernelRegistry(), logger);
}

export function startDriftEvaluate(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;
  // Never open a Redis connection in unit tests (mirrors the other jobs' guard).
  if (process.env.NODE_ENV === "test") return;

  // Register the metrics up front so /metrics exposes them (at 0) before the
  // first tick — a scrape between boot and the first eval still sees the series.
  registerDriftMetrics(getKernelRegistry());

  queue = createQueue("drift-evaluate");
  worker = createWorker("drift-evaluate", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[drift-evaluate] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "drift-evaluate");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  void queue.upsertJobScheduler("drift-evaluate-repeat", {
    every: EVAL_INTERVAL_MS,
  });
}

export async function stopDriftEvaluate(): Promise<void> {
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
