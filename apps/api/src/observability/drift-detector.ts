/**
 * F3 — behavioral drift detection (ADR-1xx / @adjudicate/drift).
 *
 * A process-singleton drift detector fed by the audit-sink `onAuditRecord` tee.
 * It observes only REDACTED records (decision.kind / intent.kind / basis.category
 * — never PII), so it is hot-path-safe and PII-safe. The kernel never reads
 * drift state, so determinism / golden vectors are untouched.
 *
 * Scope (v1, this wave): the detector + the fail-open observe() tee + scheduled
 * evaluate(). Prometheus counters/gauges + PromQL alert rules + the end-to-end
 * "drift fires an alert at /metrics" assertion need a live Redis/Postgres/NATS
 * boot and a metrics scrape — a documented live-verify follow-up (the same
 * posture as the VictoriaLogs observability work).
 */

import {
  createDriftDetector,
  type DriftAlert,
  type DriftDetector,
  type DriftSnapshot,
} from "@adjudicate/drift";
import type { AuditRecord } from "@adjudicate/core";
import { logger } from "../lib/logger.js";

// Conservative, env-tunable defaults. Keep these behind PromQL *alerts* (not
// pager rules) until thresholds are calibrated against real traffic.
function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function floatEnv(name: string, fallback: number): number {
  const n = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

let _detector: DriftDetector | null = null;

function detector(): DriftDetector {
  if (_detector) return _detector;
  _detector = createDriftDetector({
    baselineWindow: intEnv("IBX_DRIFT_BASELINE_WINDOW", 500),
    alertThreshold: floatEnv("IBX_DRIFT_THRESHOLD", 0.35),
    dimensions: ["decision.kind", "intent.kind", "basis"],
    onDrift: (alert: DriftAlert) => {
      // Pure-data callback; the side effect (log now, Prometheus counter once
      // the live-metrics wiring lands) is ours. Distinct from the replay-drift
      // metric — this is statistical/behavioral drift.
      logger.warn(
        {
          component: "drift",
          dimension: alert.dimension,
          signal: alert.signal,
          magnitude: alert.magnitude,
          threshold: alert.threshold,
          category: alert.category,
        },
        "behavioral drift detected",
      );
    },
  });
  return _detector;
}

/**
 * Wired as the audit-sink `onAuditRecord` tee (apps/api boot). Sees only
 * REDACTED records. `observe()` is no-throw; the sink arm swallows anyway.
 */
export function observeDriftRecord(record: AuditRecord): void {
  detector().observe(record);
}

/** Scheduled evaluation — call from a repeatable job. Fires `onDrift` per crossing. */
export function evaluateDrift(): ReadonlyArray<DriftAlert> {
  return detector().evaluate();
}

/** Pure read of the current distribution + drift snapshot (operator surface). */
export function driftSnapshot(): DriftSnapshot {
  return detector().snapshot();
}

/** Test-only reset of the singleton. */
export function __resetDriftDetectorForTest(): void {
  _detector = null;
}
