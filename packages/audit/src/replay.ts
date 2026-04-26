/**
 * Replay harness — re-run a stored AuditRecord[] through adjudicate() and
 * confirm the decisions reproduce. The core invariant behind IBX-IGE's
 * governance claim: "anything that happened can be reproduced deterministically."
 *
 * Consumers pass in an adjudicator that has closed over the correct policy for
 * each record's intent kind. The replay does NOT re-run side effects — it only
 * re-adjudicates.
 */

import type { AuditRecord, Decision } from "@adjudicate/core";

export interface ReplayReport {
  readonly total: number;
  readonly matched: number;
  readonly mismatches: ReadonlyArray<{
    readonly intentHash: string;
    readonly expected: Decision;
    readonly actual: Decision;
  }>;
}

export type Adjudicator = (record: AuditRecord) => Decision;

export function replay(
  records: readonly AuditRecord[],
  adjudicator: Adjudicator,
): ReplayReport {
  const mismatches: Array<{
    intentHash: string;
    expected: Decision;
    actual: Decision;
  }> = [];
  let matched = 0;

  for (const record of records) {
    const actual = adjudicator(record);
    if (actual.kind === record.decision.kind) {
      matched++;
    } else {
      mismatches.push({
        intentHash: record.intentHash,
        expected: record.decision,
        actual,
      });
    }
  }

  return { total: records.length, matched, mismatches };
}
