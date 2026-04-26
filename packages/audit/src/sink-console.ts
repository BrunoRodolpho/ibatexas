/**
 * ConsoleSink — default sink for development and tests.
 *
 * Emits one-line-per-record structured logs. Production deployments should
 * layer a NatsSink or PostgresSink on top (see @adjudicate/audit-postgres
 * when it ships).
 */

import type { AuditRecord } from "@adjudicate/core";
import type { AuditSink } from "./sink.js";

export interface ConsoleSinkOptions {
  /** Optional prefix for log lines. Defaults to "[ibx-audit]". */
  readonly prefix?: string;
  /** Output target. Defaults to console.log. */
  readonly log?: (line: string) => void;
}

export function createConsoleSink(opts: ConsoleSinkOptions = {}): AuditSink {
  const prefix = opts.prefix ?? "[ibx-audit]";
  const log = opts.log ?? ((s) => console.log(s));
  return {
    async emit(record: AuditRecord) {
      log(`${prefix} ${JSON.stringify(serialize(record))}`);
    },
  };
}

function serialize(record: AuditRecord): Record<string, unknown> {
  return {
    v: record.version,
    at: record.at,
    durationMs: record.durationMs,
    intentHash: record.intentHash,
    intentKind: record.envelope.kind,
    sessionId: record.envelope.actor.sessionId,
    principal: record.envelope.actor.principal,
    taint: record.envelope.taint,
    decision: record.decision.kind,
    basis: record.decision_basis.map((b) => `${b.category}:${b.code}`),
    ...(record.resourceVersion !== undefined
      ? { resourceVersion: record.resourceVersion }
      : {}),
    ...(record.decision.kind === "REFUSE"
      ? {
          refusal: {
            kind: record.decision.refusal.kind,
            code: record.decision.refusal.code,
          },
        }
      : {}),
  };
}
