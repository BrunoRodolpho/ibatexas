/**
 * Execution Ledger — hot-path replay/dedup.
 *
 * Purpose: "has this intentHash already been executed against a current
 * resourceVersion?" If yes, suppress re-execution and return the previous
 * result envelope. This is NOT the governance record of truth — that is
 * AuditSink. See `@ibx/intent-audit/README.md` for the distinction.
 */

export interface LedgerHit {
  /** resourceVersion recorded when the intent last executed. */
  readonly resourceVersion: string;
  /** ISO-8601 timestamp of the recorded execution. */
  readonly at: string;
  /** Session that produced the recorded execution. */
  readonly sessionId: string;
  /** Intent kind, for quick triage without decoding the full envelope. */
  readonly kind: string;
}

export interface LedgerRecordInput {
  readonly intentHash: string;
  readonly resourceVersion: string;
  readonly sessionId: string;
  readonly kind: string;
}

export interface Ledger {
  /**
   * Return a LedgerHit if this intentHash has been recorded within the TTL
   * window, otherwise null. Implementations MUST be idempotent — calling
   * twice returns the same hit.
   */
  checkLedger(intentHash: string): Promise<LedgerHit | null>;
  /**
   * Record that `intentHash` executed. Implementations use SET NX — first writer
   * wins. A second caller with the same hash does NOT overwrite; the check
   * reads the winner's value.
   */
  recordExecution(entry: LedgerRecordInput): Promise<void>;
}
