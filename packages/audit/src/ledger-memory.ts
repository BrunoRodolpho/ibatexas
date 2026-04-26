/**
 * In-memory ledger — for unit tests and for boot-time scenarios before Redis
 * is available. Not suitable for production; there is no persistence and no
 * TTL enforcement.
 */

import type { Ledger, LedgerHit, LedgerRecordInput } from "./ledger.js";

export function createMemoryLedger(): Ledger {
  const store = new Map<string, LedgerHit>();
  return {
    async checkLedger(intentHash) {
      return store.get(intentHash) ?? null;
    },
    async recordExecution(entry: LedgerRecordInput) {
      // SET NX semantics — first writer wins
      if (store.has(entry.intentHash)) return;
      store.set(entry.intentHash, {
        resourceVersion: entry.resourceVersion,
        at: new Date().toISOString(),
        sessionId: entry.sessionId,
        kind: entry.kind,
      });
    },
  };
}
