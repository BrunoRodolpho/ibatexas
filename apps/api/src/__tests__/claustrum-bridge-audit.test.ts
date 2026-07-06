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

import { afterEach, describe, expect, it } from "vitest";
import type { AuditRecord, AuditSink } from "@adjudicate/core";
import { buildEnvelope } from "@adjudicate/core";
import { createInMemorySpillStorage } from "@adjudicate/audit";
import { generateKeyPairSync } from "node:crypto";
import {
  __resetAuditSink,
  __resetAuditSigner,
  __setAuditSigner,
  __setAuditSinkDependencies,
  buildEd25519AuditSigner,
  createAuditRedactor,
  getAuditSink,
  makeEd25519SignatureVerifier,
  type AuditSinkDependencies,
} from "@ibatexas/audit-sink";
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

// ── AUT-025 — audit-record signing through the audited bridge ────────────────
// The signer is composed into `getAuditSink()` post-redaction (the redactor
// recomputes audit_hash + drops any earlier signature, so signing MUST happen
// there). These tests drive a real EXECUTE through `buildAdjudicator` →
// `adjudicateAndAudit` → `getAuditSink()` and prove (1) the emitted record
// carries a signature verifiable over its persisted audit_hash, and (2) a
// throwing signer degrades EXECUTE to REFUSE (the kernel fail-closed semantic
// holds through our wiring; boot validation is what prevents it in practice).
describe("AUT-025 — audit-record signing through the audited bridge", () => {
  function signingSinkDeps(
    capture: (r: AuditRecord) => void,
  ): AuditSinkDependencies {
    return {
      spillStorage: createInMemorySpillStorage(),
      postgresWriter: { async insertAudit() {} },
      natsPublisher: { async publish() {} },
      redactor: createAuditRedactor({ hashSecret: "test-salt" }),
      logger: { warn() {}, error() {} },
      onAuditRecord: capture,
    };
  }

  // Managed-agent namespace ⇒ the redactor is a content no-op, so the recomputed
  // audit_hash equals the original and the full record still verifies.
  function agentProbeEnvelope() {
    return buildEnvelope({
      kind: "test.audit.probe",
      payload: { hello: "world" },
      actor: {
        principal: "system",
        sessionId: "agent:sig-bot@1.0.0:entity:probe-1",
      },
      taint: "UNTRUSTED",
      nonce: "n-sig-probe",
      createdAt: "2026-05-28T12:00:00.000Z",
    });
  }

  afterEach(() => {
    __resetAuditSink();
    __resetAuditSigner();
  });

  it("a kernel EXECUTE emits a record carrying a VERIFIABLE ed25519 signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    let captured: AuditRecord | undefined;
    __setAuditSinkDependencies(signingSinkDeps((r) => (captured = r)));
    __setAuditSigner(buildEd25519AuditSigner(privateKey, "ibx-audit"));
    const bridge = buildAdjudicator({ sink: getAuditSink() });

    const decision = await bridge.adjudicate(
      agentProbeEnvelope(),
      { channel: "web" } as never,
      executeAllPolicy() as never,
    );

    expect(decision.kind).toBe("EXECUTE");
    expect(captured?.signature?.alg).toBe("ed25519");
    expect(captured?.signature?.keyId).toBe("ibx-audit");
    expect(
      makeEd25519SignatureVerifier(publicKey)(
        captured!.auditHash!,
        captured!.signature!,
      ),
    ).toBe(true);
  });

  it("fails CLOSED when the signer throws — EXECUTE degrades to REFUSE", async () => {
    __setAuditSinkDependencies(signingSinkDeps(() => {}));
    __setAuditSigner({
      keyId: "boom",
      sign() {
        throw new Error("signer down");
      },
    });
    const bridge = buildAdjudicator({ sink: getAuditSink() });

    const decision = await bridge.adjudicate(
      agentProbeEnvelope(),
      { channel: "web" } as never,
      executeAllPolicy() as never,
    );

    // An unsignable (and therefore unauditable) mutation must be refused.
    expect(decision.kind).toBe("REFUSE");
  });
});

// ── F4/L4 — multi-envelope adjudication uses per-envelope states (BKL-029) ────
// The conductor resolves a distinct SystemState per envelope and passes them
// order-aligned as the 4th arg; the bridge must adjudicate envelopes[i] against
// perEnvelopeStates[i] ?? state. A recording stateGuard captures which state
// each envelope was adjudicated against (returns null = pass, so the plan
// EXECUTEs and no REFUSE decision needs constructing).
describe("F4/L4 — adjudicatePlan per-envelope states (BKL-029)", () => {
  function recordingPolicy(seen: { kind: string; marker: unknown }[]): unknown {
    return {
      stateGuards: [
        (env: { kind: string }, state: { marker?: unknown } | null) => {
          seen.push({ kind: env.kind, marker: state?.marker });
          return null; // record-only; never blocks
        },
      ],
      authGuards: [],
      business: [],
      taint: { minimumFor: () => "UNTRUSTED" as const },
      default: "EXECUTE" as const,
    };
  }

  function planEnvelope(kind: string, nonce: string) {
    return buildEnvelope({
      kind,
      payload: {},
      actor: { principal: "user", sessionId: "web:cust-1" },
      taint: "UNTRUSTED",
      nonce,
      createdAt: "2026-05-28T12:00:00.000Z",
    });
  }

  it("adjudicates each envelope against its order-aligned perEnvelopeStates[i]", async () => {
    const sink = capturingSink();
    const bridge = buildAdjudicator({ sink });
    const seen: { kind: string; marker: unknown }[] = [];
    const env0 = planEnvelope("test.plan.first", "n-plan-0");
    const env1 = planEnvelope("test.plan.second", "n-plan-1");

    const decision = await bridge.adjudicatePlan(
      [env0, env1],
      { channel: "web", marker: "SHARED" } as never,
      recordingPolicy(seen) as never,
      [
        { channel: "web", marker: "A" },
        { channel: "web", marker: "B" },
      ] as never,
    );

    expect(decision.kind).toBe("EXECUTE");
    // Each envelope saw its OWN per-envelope state — never the shared fallback.
    expect(seen.find((s) => s.kind === "test.plan.first")?.marker).toBe("A");
    expect(seen.find((s) => s.kind === "test.plan.second")?.marker).toBe("B");
    expect(seen.some((s) => s.marker === "SHARED")).toBe(false);
    // One audit record per envelope (kill-all-or-execute-all serialization).
    expect(sink.records).toHaveLength(2);
  });

  it("falls back to the shared state when perEnvelopeStates is omitted", async () => {
    const sink = capturingSink();
    const bridge = buildAdjudicator({ sink });
    const seen: { kind: string; marker: unknown }[] = [];

    await bridge.adjudicatePlan(
      [
        planEnvelope("test.plan.first", "n-plan-2"),
        planEnvelope("test.plan.second", "n-plan-3"),
      ],
      { channel: "web", marker: "SHARED" } as never,
      recordingPolicy(seen) as never,
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.marker === "SHARED")).toBe(true);
  });
});
