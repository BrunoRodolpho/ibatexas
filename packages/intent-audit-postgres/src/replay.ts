// Replay reader — reads `intent_audit` rows back into AuditRecord instances
// for the replay harness. Inverse of recordToRow().
//
// Adopters supply a query function that returns rows; this module reconstructs
// AuditRecord objects so the standard `replay()` from @adjudicate/intent-audit can
// re-adjudicate them.

import type { AuditRecord, Decision, IntentEnvelope } from "@adjudicate/intent-core";
import type { IntentAuditRow } from "./postgres-sink.js";

export interface AuditQueryWindow {
  readonly fromIso: string;
  readonly toIso: string;
  readonly intentKind?: string;
  readonly limit?: number;
}

export interface AuditQuery {
  /**
   * Return rows whose `recorded_at` falls within [fromIso, toIso). Optional
   * filter by `intentKind`. Limit caps the result set; adopters may stream
   * via repeated calls if needed.
   */
  fetchRows(window: AuditQueryWindow): Promise<readonly IntentAuditRow[]>;
}

/**
 * Reconstruct an AuditRecord from a stored row. Inverse of recordToRow().
 * The envelope and decision are JSON-deserialized; `decision_basis` is
 * regenerated from the flattened "category:code" strings (the basis detail
 * is preserved inside `decision_jsonb`, so the deserialized Decision carries
 * the full structured basis).
 */
export function rowToRecord(row: IntentAuditRow): AuditRecord {
  const envelope = JSON.parse(row.envelope_jsonb) as IntentEnvelope;
  const decision = JSON.parse(row.decision_jsonb) as Decision;
  return {
    version: 1,
    intentHash: row.intent_hash,
    envelope,
    decision,
    decision_basis: decision.basis,
    resourceVersion: row.resource_version ?? undefined,
    at: row.recorded_at,
    durationMs: row.duration_ms,
  };
}

/**
 * Read a window of audit rows and return them as AuditRecord[] suitable for
 * `replay()` from @adjudicate/intent-audit.
 */
export async function readAuditWindow(
  query: AuditQuery,
  window: AuditQueryWindow,
): Promise<AuditRecord[]> {
  const rows = await query.fetchRows(window);
  return rows.map(rowToRecord);
}
