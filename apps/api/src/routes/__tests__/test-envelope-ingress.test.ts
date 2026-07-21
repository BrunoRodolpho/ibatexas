// JOURNEY-008 — the forged-actor ingress contract, proven at the gateway the
// test-plane route delegates to. Closes "envelope-ingress-gap": a raw,
// caller-controlled envelope with a forged actor.principal / taint is REFUSEd
// 400 `forgery_attempt` with a tamper-evident SYSTEM-actor audit record.

import { afterAll, describe, expect, it, vi } from "vitest";
import { buildEnvelope, isIntentEnvelope } from "@adjudicate/core";
import { ordersPolicyBundle } from "@ibatexas/pack-orders";
import type { IntentEnvelope, PolicyBundle } from "@adjudicate/core";
import {
  runCustomerIntent,
  STRUCTURAL_REJECTION_CODE,
} from "../__shared__/customer-intent-gateway.js";
import { envelopeIngressGate } from "../test-envelope-ingress.js";

const policy = ordersPolicyBundle as unknown as PolicyBundle<string, unknown, unknown>;

function capturingSink(): { records: unknown[]; sink: { emit: (r: unknown) => Promise<void> } } {
  const records: unknown[] = [];
  return { records, sink: { emit: async (r) => { records.push(r); } } };
}

describe("envelopeIngressGate", () => {
  const orig = { node: process.env.NODE_ENV, fp: process.env.IBX_TEST_FINGERPRINT };
  afterAll(() => {
    process.env.NODE_ENV = orig.node;
    if (orig.fp === undefined) delete process.env.IBX_TEST_FINGERPRINT;
    else process.env.IBX_TEST_FINGERPRINT = orig.fp;
  });

  it("is DISABLED in production", () => {
    process.env.NODE_ENV = "production";
    process.env.IBX_TEST_FINGERPRINT = "fp";
    expect(envelopeIngressGate()).toEqual({ ok: false, reason: "env-not-allowed" });
  });

  it("is DISABLED when NODE_ENV is unset/unexpected (positive allowlist, fail-closed)", () => {
    delete process.env.NODE_ENV;
    process.env.IBX_TEST_FINGERPRINT = "fp";
    expect(envelopeIngressGate()).toEqual({ ok: false, reason: "env-not-allowed" });
    process.env.NODE_ENV = "staging";
    expect(envelopeIngressGate()).toEqual({ ok: false, reason: "env-not-allowed" });
  });

  it("is DISABLED without the test fingerprint", () => {
    process.env.NODE_ENV = "test";
    delete process.env.IBX_TEST_FINGERPRINT;
    expect(envelopeIngressGate()).toEqual({ ok: false, reason: "no-fingerprint" });
  });

  it("is ENABLED on the test plane (NODE_ENV=test + fingerprint present)", () => {
    process.env.NODE_ENV = "test";
    process.env.IBX_TEST_FINGERPRINT = "fp";
    expect(envelopeIngressGate()).toEqual({ ok: true });
  });

  it("is ENABLED on a development stack (NODE_ENV=development + fingerprint present)", () => {
    process.env.NODE_ENV = "development";
    process.env.IBX_TEST_FINGERPRINT = "fp";
    expect(envelopeIngressGate()).toEqual({ ok: true });
  });
});

describe("forged-envelope ingress (J008 contract)", () => {
  it("REFUSEs a forged actor.principal=system envelope with 400 forgery_attempt", async () => {
    const { records, sink } = capturingSink();
    const forged = buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: "o-1" },
      actor: { principal: "system", sessionId: "attacker" },
      taint: "TRUSTED",
      nonce: "n-forged",
    });
    const reply = await runCustomerIntent({
      envelope: forged,
      state: {},
      policy,
      executor: async () => ({ ok: true }),
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress" },
      auditSink: sink as never,
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code?: string }).code).toBe("forgery_attempt");
    expect(reply.decision.kind).toBe("REFUSE");
    // tamper-evident SYSTEM-actor audit record was emitted (not minted as the customer)
    expect(records).toHaveLength(1);
    const blob = JSON.stringify(records[0]);
    expect(blob).toContain("forgery_attempt");
    expect(blob).toContain("system");
    expect(blob).toContain("forgery_rejected");
  });

  it("REFUSEs a forged taint=SYSTEM (actor.principal=user) envelope too", async () => {
    const { records, sink } = capturingSink();
    const forged = buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: "o-1" },
      actor: { principal: "user", sessionId: "u" },
      taint: "SYSTEM",
      nonce: "n-forged-taint",
    });
    const reply = await runCustomerIntent({
      envelope: forged, state: {}, policy,
      executor: async () => ({ ok: true }),
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress" },
      auditSink: sink as never,
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code?: string }).code).toBe("forgery_attempt");
    expect(records).toHaveLength(1);
  });

  it("does NOT flag a legitimate user/UNTRUSTED envelope as forgery (positive control)", async () => {
    const { sink } = capturingSink();
    const clean = buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: "o-1" },
      actor: { principal: "user", sessionId: "u" },
      taint: "UNTRUSTED",
      nonce: "n-clean",
    });
    const reply = await runCustomerIntent({
      envelope: clean, state: {}, policy,
      executor: async () => ({ ok: true }),
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress" },
      auditSink: sink as never,
    });
    // It proceeds to adjudication (may REFUSE for no-order) but NEVER as forgery.
    expect((reply.body as { code?: string }).code).not.toBe("forgery_attempt");
  });
});

// ── FE-T04 — canonical isIntentEnvelope structural boundary gate ───────────
//
// Distinct failure mode from J008's forgery contract above: a forged-actor
// envelope is built via `buildEnvelope` and so IS structurally well-formed
// (see the composition test at the bottom of this file) — it is caught by
// `detectForgery`, unchanged. These tests drive a value that is not
// envelope-shaped AT ALL — the class `detectForgery` was never scoped to
// catch (it only reads `actor.principal` / `taint`) — and prove the NEW
// named gate rejects it before either `detectForgery` or `adjudicate()` ever
// sees it.

describe("structurally-malformed envelope ingress (FE-T04)", () => {
  it("REFUSEs a value that is not envelope-shaped at all with 400 envelope_malformed", async () => {
    const { records, sink } = capturingSink();
    const malformed = { totally: "not an envelope" };
    const reply = await runCustomerIntent({
      envelope: malformed as unknown as IntentEnvelope,
      state: {},
      policy,
      executor: async () => ({ ok: true }),
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress" },
      auditSink: sink as never,
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code?: string }).code).toBe(STRUCTURAL_REJECTION_CODE);
    expect(reply.decision.kind).toBe("REFUSE");
    // tamper-evident SYSTEM-actor audit record was emitted for the rejection.
    expect(records).toHaveLength(1);
    const blob = JSON.stringify(records[0]);
    expect(blob).toContain(STRUCTURAL_REJECTION_CODE);
    expect(blob).toContain("system");
  });

  it("REFUSEs a well-formed envelope missing a required field (nonce) with 400 envelope_malformed", async () => {
    const { records, sink } = capturingSink();
    const wellFormed = buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: "o-1" },
      actor: { principal: "user", sessionId: "u" },
      taint: "UNTRUSTED",
      nonce: "n-1",
    });
    const { nonce: _dropped, ...missingNonce } =
      wellFormed as unknown as Record<string, unknown>;
    const reply = await runCustomerIntent({
      envelope: missingNonce as unknown as IntentEnvelope,
      state: {},
      policy,
      executor: async () => ({ ok: true }),
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress" },
      auditSink: sink as never,
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code?: string }).code).toBe(STRUCTURAL_REJECTION_CODE);
    expect(records).toHaveLength(1);
  });

  it("REFUSEs an envelope carrying an extra, undeclared key with 400 envelope_malformed", async () => {
    const wellFormed = buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: "o-1" },
      actor: { principal: "user", sessionId: "u" },
      taint: "UNTRUSTED",
      nonce: "n-2",
    });
    const withExtraKey = { ...wellFormed, notPartOfTheSchema: "sneaky" };
    const reply = await runCustomerIntent({
      envelope: withExtraKey as unknown as IntentEnvelope,
      state: {},
      policy,
      executor: async () => ({ ok: true }),
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress" },
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code?: string }).code).toBe(STRUCTURAL_REJECTION_CODE);
  });

  it("bypass-detection: never calls the executor for a structurally malformed envelope", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    await runCustomerIntent({
      envelope: { nope: true } as unknown as IntentEnvelope,
      state: {},
      policy,
      executor,
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress" },
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it("does NOT flag a legitimate user/UNTRUSTED envelope as structurally malformed (positive control)", async () => {
    const clean = buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: "o-1" },
      actor: { principal: "user", sessionId: "u" },
      taint: "UNTRUSTED",
      nonce: "n-clean-structural",
    });
    const reply = await runCustomerIntent({
      envelope: clean,
      state: {},
      policy,
      executor: async () => ({ ok: true }),
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress" },
    });
    expect((reply.body as { code?: string }).code).not.toBe(STRUCTURAL_REJECTION_CODE);
  });
});

describe("structural gate composes with the forgery guard (FE-T04 / J008)", () => {
  it("a forged-actor envelope IS structurally well-formed — passes the new gate, still caught by detectForgery", async () => {
    const { records, sink } = capturingSink();
    const forged = buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: "o-1" },
      actor: { principal: "system", sessionId: "attacker" },
      taint: "TRUSTED",
      nonce: "n-forged-structural-check",
    });
    // The structural gate is not what catches this — it is a well-formed
    // envelope by construction (built via buildEnvelope).
    expect(isIntentEnvelope(forged)).toBe(true);

    const reply = await runCustomerIntent({
      envelope: forged,
      state: {},
      policy,
      executor: async () => ({ ok: true }),
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress" },
      auditSink: sink as never,
    });
    // The forgery_attempt contract stays byte-identical: same code, same
    // statusCode, same recorded rejection — the structural gate composes
    // ahead of detectForgery without altering its outcome.
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code?: string }).code).toBe("forgery_attempt");
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toContain("forgery_rejected");
  });
});
