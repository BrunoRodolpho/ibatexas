import { describe, expect, it, vi } from "vitest";
import {
  basis,
  BASIS_CODES,
  buildAuditRecord,
  buildEnvelope,
  decisionExecute,
  decisionRefuse,
  refuse,
} from "@adjudicate/intent-core";
import {
  createPostgresSink,
  partitionMonthOf,
  recordToRow,
  type PostgresWriter,
} from "../src/postgres-sink.js";
import { rowToRecord } from "../src/replay.js";

function record(overrides: { decision?: "EXECUTE" | "REFUSE" } = {}) {
  const env = buildEnvelope({
    kind: "order.submit",
    payload: { sku: "X", qty: 1 },
    actor: { principal: "llm", sessionId: "s-1" },
    taint: "TRUSTED",
    createdAt: "2026-04-23T12:00:00.000Z",
  });
  const dec =
    overrides.decision === "REFUSE"
      ? decisionRefuse(refuse("SECURITY", "x", "y", "operator detail"), [
          basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT),
        ])
      : decisionExecute([
          basis("state", BASIS_CODES.state.TRANSITION_VALID),
          basis("auth", BASIS_CODES.auth.SCOPE_SUFFICIENT),
        ]);
  return buildAuditRecord({
    envelope: env,
    decision: dec,
    durationMs: 7,
    resourceVersion: "v3",
    at: "2026-04-23T12:00:01.000Z",
  });
}

describe("partitionMonthOf", () => {
  it("extracts YYYY-MM from ISO-8601", () => {
    expect(partitionMonthOf("2026-04-23T12:00:00.000Z")).toBe("2026-04");
    expect(partitionMonthOf("2025-12-31T23:59:59.999Z")).toBe("2025-12");
  });

  it("falls back to UTC date for non-standard input", () => {
    // Real ISO-8601 always has YYYY-MM at the start; stay defensive.
    expect(partitionMonthOf("2026/04/23")).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("recordToRow", () => {
  it("flattens envelope + decision into row shape", () => {
    const r = record();
    const row = recordToRow(r);
    expect(row.intent_hash).toBe(r.intentHash);
    expect(row.session_id).toBe("s-1");
    expect(row.kind).toBe("order.submit");
    expect(row.principal).toBe("llm");
    expect(row.taint).toBe("TRUSTED");
    expect(row.decision_kind).toBe("EXECUTE");
    expect(row.refusal_kind).toBe(null);
    expect(row.refusal_code).toBe(null);
    expect(row.resource_version).toBe("v3");
    expect(row.duration_ms).toBe(7);
    expect(row.partition_month).toBe("2026-04");
    expect(row.recorded_at).toBe("2026-04-23T12:00:01.000Z");
  });

  it("includes refusal metadata when decision is REFUSE", () => {
    const r = record({ decision: "REFUSE" });
    const row = recordToRow(r);
    expect(row.decision_kind).toBe("REFUSE");
    expect(row.refusal_kind).toBe("SECURITY");
    expect(row.refusal_code).toBe("x");
  });

  it("flattens decision_basis to category:code strings", () => {
    const r = record();
    const row = recordToRow(r);
    expect(row.decision_basis).toEqual([
      "state:transition_valid",
      "auth:scope_sufficient",
    ]);
  });

  it("envelope_jsonb is parseable JSON of the original envelope", () => {
    const r = record();
    const row = recordToRow(r);
    const parsed = JSON.parse(row.envelope_jsonb);
    expect(parsed.intentHash).toBe(r.intentHash);
    expect(parsed.payload.sku).toBe("X");
  });
});

describe("PostgresSink — emit", () => {
  it("calls writer.insertAudit with the row", async () => {
    const writer: PostgresWriter = { insertAudit: vi.fn(async () => {}) };
    const sink = createPostgresSink({ writer });
    const r = record();
    await sink.emit(r);
    expect(writer.insertAudit).toHaveBeenCalledOnce();
    const calledRow = (writer.insertAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(calledRow.intent_hash).toBe(r.intentHash);
  });

  it("rethrows on writer failure and invokes onError", async () => {
    const onError = vi.fn();
    const writer: PostgresWriter = {
      insertAudit: async () => {
        throw new Error("db down");
      },
    };
    const sink = createPostgresSink({ writer, onError });
    await expect(sink.emit(record())).rejects.toThrow("db down");
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("rowToRecord — round-trip with recordToRow", () => {
  it("recovers the original AuditRecord", () => {
    const original = record();
    const row = recordToRow(original);
    const recovered = rowToRecord(row);
    expect(recovered.intentHash).toBe(original.intentHash);
    expect(recovered.envelope.kind).toBe(original.envelope.kind);
    expect(recovered.envelope.taint).toBe(original.envelope.taint);
    expect(recovered.decision.kind).toBe(original.decision.kind);
    expect(recovered.decision.basis.length).toBe(original.decision.basis.length);
    expect(recovered.durationMs).toBe(original.durationMs);
    expect(recovered.at).toBe(original.at);
  });

  it("recovers REFUSE decisions including refusal payload", () => {
    const original = record({ decision: "REFUSE" });
    const row = recordToRow(original);
    const recovered = rowToRecord(row);
    expect(recovered.decision.kind).toBe("REFUSE");
    if (recovered.decision.kind !== "REFUSE") return;
    expect(recovered.decision.refusal.kind).toBe("SECURITY");
    expect(recovered.decision.refusal.code).toBe("x");
  });
});
