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

let _shadowDetector: DriftDetector | null = null;

/**
 * T3-6 / D-017: managed-agent (shadow) audit rows carry an UNHASHED
 * `agent:<id>@<ver>:entity:…` sessionId. They are REAL `intent_audit` rows but
 * MUST be excluded from the PRODUCTION behavioral-drift baseline — a Stage-0
 * shadow's decision distribution is not production signal. Mirrors the
 * kernel-replay `--ci` (T1b-3) and impact-graph (T2-4) exclusions on the same
 * literal prefix. The redactor (audit-sink) keeps the prefix unhashed so this
 * check works on the redacted record the tee sees.
 */
const AGENT_SESSION_PREFIX = "agent:";
function isAgentRecord(record: AuditRecord): boolean {
  // Defensive: the tee must never throw on a malformed/empty record (it runs
  // on the audit hot path). A record missing envelope/actor simply isn't an
  // agent row and flows to the production detector (itself no-throw).
  const sid = record?.envelope?.actor?.sessionId;
  return typeof sid === "string" && sid.startsWith(AGENT_SESSION_PREFIX);
}

function makeDetector(scope: string): DriftDetector {
  return createDriftDetector({
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
          scope,
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
}

function detector(): DriftDetector {
  if (_detector) return _detector;
  _detector = makeDetector("production");
  return _detector;
}

/** Stage-0 shadow drift monitor — fed ONLY the agent-namespace rows (T3-6). */
function shadowDetector(): DriftDetector {
  if (_shadowDetector) return _shadowDetector;
  _shadowDetector = makeDetector("shadow-agent");
  return _shadowDetector;
}

/**
 * Wired as the audit-sink `onAuditRecord` tee (apps/api boot). Sees only
 * REDACTED records. `observe()` is no-throw; the sink arm swallows anyway.
 *
 * Routes by namespace: agent (shadow) rows feed the shadow monitor and are
 * EXCLUDED from the production baseline; all other rows feed production.
 */
export function observeDriftRecord(record: AuditRecord): void {
  if (isAgentRecord(record)) {
    shadowDetector().observe(record);
    return;
  }
  detector().observe(record);
}

/** Scheduled evaluation — call from a repeatable job. Fires `onDrift` per crossing. */
export function evaluateDrift(): ReadonlyArray<DriftAlert> {
  return [...detector().evaluate(), ...shadowDetector().evaluate()];
}

/** Pure read of the production distribution + drift snapshot (operator surface). */
export function driftSnapshot(): DriftSnapshot {
  return detector().snapshot();
}

/** Pure read of the Stage-0 shadow agent decision distribution (T3-6 monitor). */
export function shadowDriftSnapshot(): DriftSnapshot {
  return shadowDetector().snapshot();
}

/** Test-only reset of the singletons. */
export function __resetDriftDetectorForTest(): void {
  _detector = null;
  _shadowDetector = null;
}
