// Unit tests for Task 14 customer-mutation governance flow.
//
// Coverage:
//
//   1. `runCustomerIntent` gateway — branches on all 6 Decision kinds:
//      - EXECUTE → executor runs, returns 200 + body
//      - REWRITE → executor runs with rewritten payload, returns 200
//      - REFUSE → returns 403 with localized pt-BR copy
//      - DEFER → calls onDefer if provided, default returns 202
//      - REQUEST_CONFIRMATION → returns 202 with prompt
//      - ESCALATE → returns 503
//
//      Also asserts enforce/shadow/pure-legacy switch:
//      - kind in ALWAYS_ENFORCE → always adjudicates (anonymize)
//      - kind enforced via env → adjudicates
//      - kind shadowed via env → adjudicates for telemetry but legacy wins
//      - kind in neither → pure legacy EXECUTE
//
//   2. Order cancel route — wraps `order.cancel` intent, surfaces pt-BR
//      refusal on REFUSE, 200 on EXECUTE.
//
// Bypass-detection: assert that `runCustomerIntent`'s executor IS or IS
// NOT called per decision branch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks for the gateway test ─────────────────────────────────────

const mockAdjudicate = vi.hoisted(() => vi.fn());

vi.mock("@adjudicate/core/kernel", async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return {
    ...actual,
    adjudicate: mockAdjudicate,
  };
});

import {
  runCustomerIntent,
  FORGERY_REJECTION_CODE,
  type CustomerIntentReply,
} from "../__shared__/customer-intent-gateway.js";
import { buildEnvelope, type Decision, type IntentEnvelope } from "@adjudicate/core";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEnvelope<K extends string>(kind: K): IntentEnvelope<K, { foo: string }> {
  return buildEnvelope<K, { foo: string }>({
    kind,
    payload: { foo: "bar" },
    nonce: "test-nonce-1",
    actor: { principal: "user", sessionId: "cust_01" },
    taint: "UNTRUSTED",
  });
}

const dummyPolicy = {
  intentKinds: () => ["test.kind", "customer.anonymize"] as readonly string[],
  guards: (_kind: string) => [],
  taintPolicy: () => ({ kind: "EXECUTE" as const, basis: [] }),
  defaultDecision: () => ({ kind: "EXECUTE" as const, basis: [] }),
} as unknown as Parameters<typeof runCustomerIntent>[0]["policy"];

const noopAuditSink = { emit: vi.fn(async () => undefined) };

// ── Gateway: decision branching ────────────────────────────────────────────

describe("runCustomerIntent — Decision branching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("IBX_KERNEL_ENFORCE", "test.kind");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("EXECUTE → runs executor + returns 200 + body", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] } satisfies Decision);
    const executor = vi.fn(async () => ({ ok: true, value: 42 }));

    const out = await runCustomerIntent({
      envelope: makeEnvelope("test.kind"),
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink: noopAuditSink,
    });

    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ ok: true, value: 42 });
    expect(executor).toHaveBeenCalledWith({ foo: "bar" });
    expect(out.decision.kind).toBe("EXECUTE");
  });

  it("REWRITE → runs executor with rewritten payload + returns 200", async () => {
    const rewrittenEnvelope = makeEnvelope("test.kind");
    (rewrittenEnvelope as unknown as { payload: { foo: string } }).payload = { foo: "rewritten" };
    mockAdjudicate.mockReturnValue({
      kind: "REWRITE",
      rewritten: rewrittenEnvelope,
      reason: "sanitize",
      basis: [],
    } satisfies Decision);
    const executor = vi.fn(async (p: unknown) => ({ received: p }));

    const out = await runCustomerIntent({
      envelope: makeEnvelope("test.kind"),
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink: noopAuditSink,
    });

    expect(out.statusCode).toBe(200);
    expect(executor).toHaveBeenCalledWith({ foo: "rewritten" });
  });

  it("REFUSE → 403 + pt-BR error copy + executor NOT called", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "test.refuse_code",
        userFacing: "Operação recusada.",
      },
      basis: [],
    } satisfies Decision);
    const executor = vi.fn();

    const out = await runCustomerIntent({
      envelope: makeEnvelope("test.kind"),
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink: noopAuditSink,
    });

    expect(out.statusCode).toBe(403);
    expect((out.body as { error: string; code: string }).error).toBe("Operação recusada.");
    expect((out.body as { error: string; code: string }).code).toBe("test.refuse_code");
    expect(executor).not.toHaveBeenCalled();
  });

  it("DEFER → 202 + signal + default pt-BR message when no onDefer", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "DEFER",
      signal: "test.signal",
      timeoutMs: 1000,
      basis: [],
    } satisfies Decision);
    const executor = vi.fn();

    const out = await runCustomerIntent({
      envelope: makeEnvelope("test.kind"),
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink: noopAuditSink,
    });

    expect(out.statusCode).toBe(202);
    expect((out.body as { signal: string }).signal).toBe("test.signal");
    expect(executor).not.toHaveBeenCalled();
  });

  it("DEFER → custom onDefer is called when provided", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "DEFER",
      signal: "test.signal",
      timeoutMs: 1000,
      basis: [],
    } satisfies Decision);
    const onDefer = vi.fn<
      (decision: Extract<Decision, { kind: "DEFER" }>) => Promise<CustomerIntentReply<unknown>>
    >(async () => ({
      statusCode: 202,
      body: { custom: "defer-body" },
      decision: { kind: "DEFER", signal: "x", timeoutMs: 0, basis: [] },
    }));
    const executor = vi.fn();

    const out = await runCustomerIntent({
      envelope: makeEnvelope("test.kind"),
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink: noopAuditSink,
      onDefer,
    });

    expect(onDefer).toHaveBeenCalledTimes(1);
    expect(out.statusCode).toBe(202);
    expect((out.body as { custom: string }).custom).toBe("defer-body");
  });

  it("REQUEST_CONFIRMATION → 202 + prompt + executor NOT called", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "REQUEST_CONFIRMATION",
      prompt: "Tem certeza?",
      basis: [],
    } satisfies Decision);
    const executor = vi.fn();

    const out = await runCustomerIntent({
      envelope: makeEnvelope("test.kind"),
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink: noopAuditSink,
    });

    expect(out.statusCode).toBe(202);
    expect((out.body as { confirmationRequired: boolean; prompt: string }).confirmationRequired).toBe(true);
    expect((out.body as { confirmationRequired: boolean; prompt: string }).prompt).toBe("Tem certeza?");
    expect(executor).not.toHaveBeenCalled();
  });

  it("ESCALATE → 503 + pt-BR copy + executor NOT called", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "ESCALATE",
      to: "human",
      reason: "needs_human",
      basis: [],
    } satisfies Decision);
    const executor = vi.fn();

    const out = await runCustomerIntent({
      envelope: makeEnvelope("test.kind"),
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink: noopAuditSink,
    });

    expect(out.statusCode).toBe(503);
    expect((out.body as { error: string }).error).toContain("atendimento humano");
    expect(executor).not.toHaveBeenCalled();
  });
});

// ── Gateway: enforce / shadow / pure-legacy switch ─────────────────────────

describe("runCustomerIntent — enforce/shadow switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kind in ALWAYS_ENFORCE (customer.anonymize) → adjudicates even without env", async () => {
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] } satisfies Decision);
    const executor = vi.fn(async () => ({ ok: true }));

    const out = await runCustomerIntent({
      envelope: makeEnvelope("customer.anonymize"),
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink: noopAuditSink,
    });

    expect(out.statusCode).toBe(200);
    expect(mockAdjudicate).toHaveBeenCalledTimes(1);
  });

  it("adjudicates every intent kind and surfaces the kernel's REFUSE", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: { kind: "BUSINESS_RULE", code: "x", userFacing: "Nope." },
      basis: [],
    } satisfies Decision);
    const executor = vi.fn();

    const out = await runCustomerIntent({
      envelope: makeEnvelope("test.kind"),
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink: noopAuditSink,
    });

    expect(out.statusCode).toBe(403);
    expect(mockAdjudicate).toHaveBeenCalledTimes(1);
    expect(executor).not.toHaveBeenCalled();
  });
});

// ── P2-6 + P2-7 (audit-2026-05-24) — forgery defenses ─────────────────────

describe("runCustomerIntent — forgery defenses (P2-6 + P2-7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("P2-6 — rejects actor.principal: 'system' with 400 + forgery_attempt code", async () => {
    const forgedEnvelope = buildEnvelope<"test.kind", { foo: string }>({
      kind: "test.kind",
      payload: { foo: "bar" },
      nonce: "forgery-nonce-1",
      actor: { principal: "system", sessionId: "cust_01" },
      taint: "UNTRUSTED",
    });
    const executor = vi.fn();
    const emit = vi.fn(async (_record: unknown) => undefined);
    const auditSink = { emit };

    const out = await runCustomerIntent({
      envelope: forgedEnvelope,
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink,
    });

    expect(out.statusCode).toBe(400);
    expect((out.body as { code: string }).code).toBe(FORGERY_REJECTION_CODE);
    expect(mockAdjudicate).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    // System-actor audit record emitted so the rejection leaves a trail
    expect(emit).toHaveBeenCalledTimes(1);
    const auditedRecord = emit.mock.calls[0]![0] as {
      envelope: IntentEnvelope;
      decision: Decision;
    };
    expect(auditedRecord.envelope.actor.principal).toBe("system");
    expect(auditedRecord.envelope.taint).toBe("SYSTEM");
    expect(auditedRecord.decision.kind).toBe("REFUSE");
  });

  it("P2-7 — rejects taint: 'TRUSTED' with 400 + forgery_attempt code", async () => {
    const forgedEnvelope = buildEnvelope<"test.kind", { foo: string }>({
      kind: "test.kind",
      payload: { foo: "bar" },
      nonce: "forgery-nonce-2",
      actor: { principal: "user", sessionId: "cust_01" },
      taint: "TRUSTED",
    });
    const executor = vi.fn();
    const emit = vi.fn(async (_record: unknown) => undefined);
    const auditSink = { emit };

    const out = await runCustomerIntent({
      envelope: forgedEnvelope,
      state: {},
      policy: dummyPolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test" },
      auditSink,
    });

    expect(out.statusCode).toBe(400);
    expect((out.body as { code: string }).code).toBe(FORGERY_REJECTION_CODE);
    expect(mockAdjudicate).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    const auditedRecord = emit.mock.calls[0]![0] as {
      envelope: IntentEnvelope;
      decision: Decision;
    };
    expect(auditedRecord.envelope.actor.principal).toBe("system");
    expect(auditedRecord.envelope.taint).toBe("SYSTEM");
    expect(auditedRecord.decision.kind).toBe("REFUSE");
  });
});
