// Live decision observability — a real MetricsSink for the @adjudicate kernel.
//
// The kernel's RuntimeContext emits an event at every observability point
// (decision, refusal, ledger op, audit-sink failure) to the installed
// MetricsSink. The default sink is a no-op, so nothing is visible. This sink
// turns those events into STRUCTURED log lines (pino) that an operator can
// watch live and that ship to VictoriaLogs.
//
// FENCE 1 (determinism): this is an OBSERVER. It is installed at the composition
// root via `setMetricsSink()` and only RECEIVES events the kernel already emits
// — it never runs inside the kernel's hashed/canonical path and never alters a
// Decision or AuditRecord. `@adjudicate/core` is untouched (core stays 456).
//
// Correlation: every event carries `intentHash` — the same SHA-256 content
// digest that keys the durable `intent_audit` row. So `event:decision` log
// lines join 1:1 to audit rows (and to the per-turn `correlationId`) by
// intentHash. `principal`/`taint` are NOT duplicated here (they are not on the
// kernel's DecisionEvent); they live on the audit row and are joined by hash.

import { createHash } from "node:crypto";
import type {
  MetricsSink,
  DecisionEvent,
  RefusalEvent,
  LedgerOpEvent,
  SinkFailureEvent,
  ResourceLimitEvent,
} from "@adjudicate/core/kernel";
import { logger } from "../lib/logger.js";

/** A minimal pino-like sink — accepts the app logger or a test double. */
export interface LogLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

/**
 * Hash a session-id-shaped subject before it is emitted (SecurityReviewer-016:
 * `subject` is a session-id PII proxy). 12 hex chars keep it correlatable
 * without being reversible.
 */
function safeSubject(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 12);
}

/**
 * Build the ibatexas kernel MetricsSink over a structured logger.
 *
 * Level policy:
 *   - decision  → info   (the steady-state signal; one line per adjudication)
 *   - refusal   → warn   (a blocked mutation; operators want these surfaced)
 *   - ledger    → debug  (replay-suppression hit/miss; high-volume, off by default)
 *   - sink fail → error  (audit could not persist → the mutation fails CLOSED)
 *   - resource  → warn   (quota/back-pressure)
 *
 * Implements all six methods so `setMetricsSink` does not warn about a missing
 * shadow hook; ibatexas runs an always-on kernel (no shadow path), so
 * `recordShadowDivergence` is a no-op by design.
 */
export function createIbatexasMetricsSink(log: LogLike = logger): MetricsSink {
  return {
    recordDecision(e: DecisionEvent): void {
      log.info(
        {
          component: "kernel",
          event: "decision",
          intentHash: e.intentHash,
          intentKind: e.intentKind,
          decision: e.decision,
          basisCount: e.basisCount,
          durationMs: e.latencyMs,
        },
        `decision ${e.decision} ${e.intentKind}`,
      );
    },
    recordRefusal(e: RefusalEvent): void {
      log.warn(
        {
          component: "kernel",
          event: "refusal",
          intentHash: e.intentHash,
          intentKind: e.intentKind,
          refusalKind: e.refusal.kind,
          refusalCode: e.refusal.code,
        },
        `refusal ${e.refusal.kind}/${e.refusal.code} ${e.intentKind}`,
      );
    },
    recordLedgerOp(e: LedgerOpEvent): void {
      log.debug(
        {
          component: "kernel",
          event: "ledger",
          intentHash: e.intentHash,
          intentKind: e.intentKind,
          op: e.op,
          outcome: e.outcome,
          durationMs: e.latencyMs,
        },
        `ledger ${e.op}:${e.outcome} ${e.intentKind}`,
      );
    },
    recordSinkFailure(e: SinkFailureEvent): void {
      log.error(
        {
          component: "audit-sink",
          event: "sink_failure",
          sink: e.sink,
          subject: safeSubject(e.subject),
          errorClass: e.errorClass,
          consecutiveFailures: e.consecutiveFailures,
        },
        `audit sink failure: ${e.sink} (${e.consecutiveFailures} consecutive)`,
      );
    },
    recordResourceLimit(e: ResourceLimitEvent): void {
      log.warn(
        {
          component: "kernel",
          event: "resource_limit",
          resource: e.resource,
          subject: safeSubject(e.subject),
          limit: e.limit,
          observed: e.observed,
        },
        `resource limit ${e.resource}: ${e.observed}/${e.limit}`,
      );
    },
    // Always-on kernel: no shadow path. Implemented as a no-op so setMetricsSink
    // does not warn at boot about a missing shadow hook.
    recordShadowDivergence(): void {},
  };
}
