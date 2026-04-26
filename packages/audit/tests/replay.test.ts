import { describe, expect, it } from "vitest";
import {
  basis,
  BASIS_CODES,
  buildAuditRecord,
  buildEnvelope,
  decisionExecute,
  decisionRefuse,
  refuse,
  type AuditRecord,
} from "@adjudicate/core";
import { replay } from "../src/replay.js";

function record(kind: "EXECUTE" | "REFUSE", seed: string): AuditRecord {
  const env = buildEnvelope({
    kind: "order.tool.propose",
    payload: { toolName: seed },
    actor: { principal: "llm", sessionId: "s" },
    taint: "UNTRUSTED",
    createdAt: "2026-04-23T12:00:00.000Z",
  });
  const decision =
    kind === "EXECUTE"
      ? decisionExecute([basis("state", BASIS_CODES.state.TRANSITION_VALID)])
      : decisionRefuse(
          refuse("STATE", "x", "nope"),
          [basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL)],
        );
  return buildAuditRecord({
    envelope: env,
    decision,
    durationMs: 1,
  });
}

describe("replay", () => {
  it("matches every record when adjudicator is deterministic", () => {
    const records = [record("EXECUTE", "a"), record("REFUSE", "b")];
    const report = replay(records, (r) => r.decision);
    expect(report.total).toBe(2);
    expect(report.matched).toBe(2);
    expect(report.mismatches).toEqual([]);
  });

  it("surfaces mismatches with expected vs actual", () => {
    const records = [record("EXECUTE", "a"), record("REFUSE", "b")];
    const report = replay(records, () =>
      decisionRefuse(refuse("STATE", "drift", "x"), []),
    );
    expect(report.matched).toBe(1); // only the REFUSE record matches
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]!.expected.kind).toBe("EXECUTE");
    expect(report.mismatches[0]!.actual.kind).toBe("REFUSE");
  });
});
