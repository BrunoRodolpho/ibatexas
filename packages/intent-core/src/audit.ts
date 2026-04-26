/**
 * AuditRecord — the durable governance trail entry.
 *
 * Every Decision returned by adjudicate() must produce exactly one AuditRecord.
 * These records are emitted to @adjudicate/intent-audit sinks (Console, NATS, Postgres)
 * and are the governance record of truth. The Execution Ledger is separate —
 * it handles hot-path dedup and is not authoritative for audit.
 */

import type { IntentEnvelope } from "./envelope.js";
import type { Decision } from "./decision.js";
import type { DecisionBasis } from "./basis-codes.js";

export const AUDIT_RECORD_VERSION = 1 as const;

export interface AuditRecord {
  readonly version: typeof AUDIT_RECORD_VERSION;
  readonly intentHash: string;
  readonly envelope: IntentEnvelope;
  readonly decision: Decision;
  readonly decision_basis: readonly DecisionBasis[];
  /** Populated after successful execution — e.g. order.version post-apply. */
  readonly resourceVersion?: string;
  readonly at: string; // ISO-8601
  readonly durationMs: number;
}

export interface BuildAuditInput {
  readonly envelope: IntentEnvelope;
  readonly decision: Decision;
  readonly durationMs: number;
  readonly resourceVersion?: string;
  readonly at?: string;
}

export function buildAuditRecord(input: BuildAuditInput): AuditRecord {
  return {
    version: AUDIT_RECORD_VERSION,
    intentHash: input.envelope.intentHash,
    envelope: input.envelope,
    decision: input.decision,
    decision_basis: input.decision.basis,
    ...(input.resourceVersion !== undefined
      ? { resourceVersion: input.resourceVersion }
      : {}),
    at: input.at ?? new Date().toISOString(),
    durationMs: input.durationMs,
  };
}
