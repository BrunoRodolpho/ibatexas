/**
 * RC-A1 Stage 1 — the audited Adjudicator bridge.
 *
 * Proves the audit-completeness invariant: every adjudication through the
 * bridge emits exactly one AuditRecord to the sink (the bridge previously
 * called the NON-audited `adjudicate()` and produced nothing — audit RC-A1
 * prereq 3 / the cutover's "a turn produces an AuditRecord" bar).
 *
 * Also pins the fail-CLOSED contract: an incomplete PolicyBundle and a
 * throwing sink both degrade to REFUSE (never an ungated EXECUTE), and an
 * unauditable mutation persists no record.
 *
 * Unit-isolated: a minimal hand-built PolicyBundle + an in-memory capturing
 * sink. Pack-policy semantics are covered by each pack's own conformance
 * suite; this test covers only the bridge wiring.
 */

import { describe, expect, it } from "vitest";
import type { AuditRecord, AuditSink } from "@adjudicate/core";
import { buildEnvelope } from "@adjudicate/core";
import { buildAdjudicator } from "../claustrum-bootstrap.js";

// A capturing sink — records every emit so we can assert audit emission.
function capturingSink(): AuditSink & { readonly records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    async emit(record: AuditRecord) {
      records.push(record);
    },
  };
}

// Minimal well-formed PolicyBundle: no guards, taint floor UNTRUSTED, default
// EXECUTE — so a clean envelope adjudicates to EXECUTE without any guard
// firing. Shape matches the kernel's PolicyBundle contract + the bridge's
// `isWellFormedPolicyBundle` check.
function executeAllPolicy(): unknown {
  return {
    stateGuards: [],
    authGuards: [],
    business: [],
    taint: { minimumFor: () => "UNTRUSTED" as const },
    default: "EXECUTE" as const,
  };
}

function probeEnvelope() {
  return buildEnvelope({
    kind: "test.audit.probe",
    payload: { hello: "world" },
    actor: { principal: "user", sessionId: "web:cust-1" },
    taint: "UNTRUSTED",
    nonce: "n-stage1-probe",
    createdAt: "2026-05-28T12:00:00.000Z",
  });
}

describe("RC-A1 Stage 1 — audited Adjudicator bridge", () => {
  it("emits exactly one AuditRecord per adjudication (audit-completeness)", async () => {
    const sink = capturingSink();
    const bridge = buildAdjudicator({ sink });
    const envelope = probeEnvelope();

    const decision = await bridge.adjudicate(
      envelope,
      { channel: "web" } as never,
      executeAllPolicy() as never,
    );

    expect(decision.kind).toBe("EXECUTE");
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.intentHash).toBe(
      (envelope as { intentHash: string }).intentHash,
    );
  });

  it("fails CLOSED on an incomplete PolicyBundle — REFUSE, no audit emitted", async () => {
    const sink = capturingSink();
    const bridge = buildAdjudicator({ sink });

    const decision = await bridge.adjudicate(
      probeEnvelope(),
      { channel: "web" } as never,
      {} as never, // the single-tenant resolver's empty {} — not yet wired
    );

    expect(decision.kind).toBe("REFUSE");
    expect(
      (decision as { refusal: { code: string } }).refusal.code,
    ).toBe("policy_not_ready");
    // The kernel never ran → nothing to audit.
    expect(sink.records).toHaveLength(0);
  });

  it("fails CLOSED when the audit sink throws — REFUSE, no ungated EXECUTE", async () => {
    const throwingSink: AuditSink = {
      async emit() {
        throw new Error("postgres down");
      },
    };
    const bridge = buildAdjudicator({ sink: throwingSink });

    const decision = await bridge.adjudicate(
      probeEnvelope(),
      { channel: "web" } as never,
      executeAllPolicy() as never,
    );

    // An unauditable mutation must be refused, not silently executed.
    expect(decision.kind).toBe("REFUSE");
  });

  it("verifyAuditRecord maps a missing-hash record to NOT-ok (fail-safe)", () => {
    const sink = capturingSink();
    const bridge = buildAdjudicator({ sink });
    // A record with no auditHash → kernel returns {verified:null} → {ok:false}.
    const result = bridge.verifyAuditRecord({} as AuditRecord);
    expect(result.ok).toBe(false);
  });
});
