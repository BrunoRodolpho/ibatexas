/**
 * AuditSink — durable governance trail.
 *
 * The authoritative record of WHAT happened, WHY, and ON WHAT BASIS. This is
 * what auditors consume. AuditSink is intentionally distinct from the
 * ExecutionLedger: losing Redis loses dedup (retries may duplicate) but MUST
 * NOT lose audit — sinks persist independently.
 */

import type { AuditRecord } from "@ibx/intent-core";

export interface AuditSink {
  /**
   * Emit one record. Implementations should be best-effort non-blocking on the
   * hot path; caller can compose multiple sinks via `multiSink()` below.
   */
  emit(record: AuditRecord): Promise<void>;
}

/**
 * Fan out one record to multiple sinks in parallel. Failures in any one sink
 * are logged but do not block the others — audit is fail-open on the hot path
 * and the replay harness catches dropped records later.
 */
export function multiSink(...sinks: readonly AuditSink[]): AuditSink {
  return {
    async emit(record) {
      await Promise.allSettled(sinks.map((s) => s.emit(record)));
    },
  };
}
