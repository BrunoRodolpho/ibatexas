// Unit tests for the live-decision MetricsSink (observability/metrics-sink.ts).
// Proves the kernel's decision/refusal/ledger/sink-failure events become
// structured, correlatable log lines — and that the session-id subject is
// hashed (no PII leak) on the sink-failure path.

import { describe, it, expect } from "vitest";
import { refuse } from "@adjudicate/core";
import {
  createIbatexasMetricsSink,
  type LogLike,
} from "../observability/metrics-sink.js";

interface Line {
  level: string;
  obj: Record<string, unknown>;
  msg?: string;
}

function captureLogger(): { log: LogLike; lines: Line[] } {
  const lines: Line[] = [];
  const mk =
    (level: string) =>
    (obj: object, msg?: string): void => {
      lines.push({ level, obj: obj as Record<string, unknown>, msg });
    };
  return {
    log: { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") },
    lines,
  };
}

describe("ibatexas MetricsSink — live decision observability", () => {
  it("recordDecision → info line correlated by intentHash with the decision fields", () => {
    const { log, lines } = captureLogger();
    createIbatexasMetricsSink(log).recordDecision({
      intentKind: "order.item.add",
      decision: "EXECUTE",
      latencyMs: 3,
      basisCount: 1,
      intentHash: "c54da2c0deadbeef",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].obj).toMatchObject({
      component: "kernel",
      event: "decision",
      decision: "EXECUTE",
      intentKind: "order.item.add",
      intentHash: "c54da2c0deadbeef",
      basisCount: 1,
      durationMs: 3,
    });
  });

  it("recordRefusal → warn line carrying refusal kind + code", () => {
    const { log, lines } = captureLogger();
    createIbatexasMetricsSink(log).recordRefusal({
      intentKind: "payment.refund.issue",
      refusal: refuse("SECURITY", "scope_insufficient", "Sem permissão.", "test"),
      intentHash: "abc123def456",
    });
    expect(lines[0].level).toBe("warn");
    expect(lines[0].obj).toMatchObject({
      event: "refusal",
      refusalKind: "SECURITY",
      refusalCode: "scope_insufficient",
      intentHash: "abc123def456",
    });
  });

  it("recordSinkFailure → error line with the session-id subject HASHED (no PII)", () => {
    const { log, lines } = captureLogger();
    createIbatexasMetricsSink(log).recordSinkFailure({
      sink: "postgres",
      subject: "web:customer-1234",
      errorClass: "Error",
      consecutiveFailures: 2,
    });
    expect(lines[0].level).toBe("error");
    expect(lines[0].obj).toMatchObject({
      event: "sink_failure",
      sink: "postgres",
      consecutiveFailures: 2,
    });
    expect(lines[0].obj.subject).not.toBe("web:customer-1234");
    expect(lines[0].obj.subject).toMatch(/^[a-f0-9]{12}$/);
  });

  it("recordLedgerOp → debug line (high-volume, off by default)", () => {
    const { log, lines } = captureLogger();
    createIbatexasMetricsSink(log).recordLedgerOp({
      op: "check",
      outcome: "miss",
      intentKind: "order.checkout.create",
      latencyMs: 1,
      intentHash: "feedface00",
    });
    expect(lines[0].level).toBe("debug");
    expect(lines[0].obj).toMatchObject({ event: "ledger", op: "check", outcome: "miss" });
  });
});
