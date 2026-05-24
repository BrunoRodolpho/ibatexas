// NEW-P0-X2 — `runCustomerIntent` default-REFUSE for non-enforce kinds.
//
// Per deep-audit/01-architecture-coupling.md §G: the pure-legacy branch
// of `runCustomerIntent` hardcodes `decision = { kind: "EXECUTE", basis: [] }`.
// Only `customer.anonymize*` is in `ALWAYS_ENFORCE`. Every other customer
// mutation kind silently runs as legacy EXECUTE unless ops flips the
// shadow/enforce env, inverting the documented default-deny.
//
// Coverage:
//   1. A kind NOT in shadow/enforce/ALWAYS_ENFORCE → REFUSE with pt-BR.
//   2. `customer.anonymize` still EXECUTEs (ALWAYS_ENFORCE preserved).
//   3. `customer.profile.update` is now in ALWAYS_ENFORCE — adjudicates.
//   4. Shadow-listed kinds still EXECUTE (telemetry mode preserved).
//   5. Enforce-listed kinds run the kernel.
//
// We mock the kernel's `adjudicate` so we can hand-feed Decisions without
// constructing a full policy bundle (taint policy etc.).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Decision, IntentEnvelope } from "@adjudicate/core";

const mockAdjudicate = vi.hoisted(() => vi.fn());
const mockIsEnforced = vi.hoisted(() => vi.fn());
const mockIsShadowed = vi.hoisted(() => vi.fn());

vi.mock("@adjudicate/core/kernel", async () => {
  const actual = await vi.importActual<
    typeof import("@adjudicate/core/kernel")
  >("@adjudicate/core/kernel");
  return {
    ...actual,
    adjudicate: mockAdjudicate,
    isEnforced: mockIsEnforced,
    isShadowed: mockIsShadowed,
  };
});

describe("NEW-P0-X2 — runCustomerIntent default-REFUSE for non-enforce kinds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // Default: kind is neither enforced nor shadowed.
    mockIsEnforced.mockReturnValue(false);
    mockIsShadowed.mockReturnValue(false);
    // Default: kernel returns EXECUTE if invoked.
    mockAdjudicate.mockReturnValue({ kind: "EXECUTE", basis: [] } as Decision);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeEnvelope(kind: string): IntentEnvelope {
    return {
      version: 2,
      kind,
      payload: {},
      createdAt: "2026-05-23T00:00:00.000Z",
      nonce: "n-test",
      actor: { principal: "user", sessionId: "cust_01" },
      taint: "UNTRUSTED",
      intentHash: "h-test",
    } as IntentEnvelope;
  }

  // Bare-bones policy stand-in; never called because we mock adjudicate.
  const fakePolicy = {} as unknown as Parameters<
    typeof import("../routes/__shared__/customer-intent-gateway.js").runCustomerIntent
  >[0]["policy"];

  it("REFUSES with pt-BR userFacing for a kind NOT in shadow/enforce/ALWAYS_ENFORCE", async () => {
    const { runCustomerIntent } = await import(
      "../routes/__shared__/customer-intent-gateway.js"
    );

    const executor = vi.fn(async () => ({ executed: true }));
    const envelope = makeEnvelope("order.bogus.unknown.kind");

    const result = await runCustomerIntent({
      envelope,
      state: {},
      policy: fakePolicy,
      executor,
      ctx: { customerId: "cust_01", route: "test.bogus" },
    });

    expect(result.statusCode).toBe(403);
    const body = result.body as { error: string; code: string };
    expect(body.error).toMatch(/[Oo]peração indispon|Tente novamente|suporte/i);
    expect(result.decision.kind).toBe("REFUSE");
    // Adjudicate NOT called for non-enforce/non-shadow kinds.
    expect(mockAdjudicate).not.toHaveBeenCalled();
    // Executor MUST NOT be called when default-REFUSE.
    expect(executor).not.toHaveBeenCalled();
  });

  it("EXECUTES customer.anonymize (ALWAYS_ENFORCE preserved)", async () => {
    const { runCustomerIntent } = await import(
      "../routes/__shared__/customer-intent-gateway.js"
    );

    const executor = vi.fn(async () => ({ executed: true }));
    const envelope = makeEnvelope("customer.anonymize");

    const result = await runCustomerIntent({
      envelope,
      state: {},
      policy: fakePolicy,
      executor,
      ctx: { customerId: "cust_01", route: "anonymize.test" },
    });

    expect(result.decision.kind).toBe("EXECUTE");
    // adjudicate WAS called (ALWAYS_ENFORCE forces kernel).
    expect(mockAdjudicate).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("ADJUDICATES customer.profile.update via ALWAYS_ENFORCE expansion (audit recommendation)", async () => {
    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "profile.update.refused",
        userFacing: "Perfil bloqueado.",
      },
      basis: [],
    } as Decision);

    const { runCustomerIntent } = await import(
      "../routes/__shared__/customer-intent-gateway.js"
    );

    const executor = vi.fn(async () => ({ executed: true }));
    const envelope = makeEnvelope("customer.profile.update");

    const result = await runCustomerIntent({
      envelope,
      state: {},
      policy: fakePolicy,
      executor,
      ctx: { customerId: "cust_01", route: "profile.update" },
    });

    expect(mockAdjudicate).toHaveBeenCalledTimes(1);
    expect(result.decision.kind).toBe("REFUSE");
    if (result.decision.kind === "REFUSE") {
      expect(result.decision.refusal.code).toBe("profile.update.refused");
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it("ADJUDICATES customer.preferences.update via ALWAYS_ENFORCE expansion", async () => {
    const { runCustomerIntent } = await import(
      "../routes/__shared__/customer-intent-gateway.js"
    );

    const executor = vi.fn(async () => ({ executed: true }));
    const envelope = makeEnvelope("customer.preferences.update");

    const result = await runCustomerIntent({
      envelope,
      state: {},
      policy: fakePolicy,
      executor,
      ctx: { customerId: "cust_01", route: "preferences.update" },
    });

    expect(mockAdjudicate).toHaveBeenCalledTimes(1);
    expect(result.decision.kind).toBe("EXECUTE");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("ADJUDICATES customer.pix.details.save via ALWAYS_ENFORCE expansion", async () => {
    const { runCustomerIntent } = await import(
      "../routes/__shared__/customer-intent-gateway.js"
    );

    const executor = vi.fn(async () => ({ executed: true }));
    const envelope = makeEnvelope("customer.pix.details.save");

    const result = await runCustomerIntent({
      envelope,
      state: {},
      policy: fakePolicy,
      executor,
      ctx: { customerId: "cust_01", route: "pix.save" },
    });

    expect(mockAdjudicate).toHaveBeenCalledTimes(1);
    expect(result.decision.kind).toBe("EXECUTE");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("shadow-listed kind keeps legacy EXECUTE for the soak (telemetry only)", async () => {
    mockIsShadowed.mockReturnValue(true);
    // Even if adjudicate would refuse, shadow mode preserves legacy EXECUTE.
    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "shadow.refuse",
        userFacing: "Shadow refusal.",
      },
      basis: [],
    } as Decision);

    const { runCustomerIntent } = await import(
      "../routes/__shared__/customer-intent-gateway.js"
    );

    const executor = vi.fn(async () => ({ executed: true }));
    const envelope = makeEnvelope("order.cart.create");

    const result = await runCustomerIntent({
      envelope,
      state: {},
      policy: fakePolicy,
      executor,
      ctx: { customerId: "cust_01", route: "shadow.test" },
    });

    // Shadow → adjudicate IS called for telemetry but legacy EXECUTE wins.
    expect(mockAdjudicate).toHaveBeenCalledTimes(1);
    expect(result.decision.kind).toBe("EXECUTE");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("enforce-listed kind runs kernel decision (no legacy override)", async () => {
    mockIsEnforced.mockReturnValue(true);
    mockAdjudicate.mockReturnValue({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "enforce.refuse",
        userFacing: "Pedido recusado pelo kernel.",
      },
      basis: [],
    } as Decision);

    const { runCustomerIntent } = await import(
      "../routes/__shared__/customer-intent-gateway.js"
    );

    const executor = vi.fn(async () => ({ executed: true }));
    const envelope = makeEnvelope("order.cart.refuse");

    const result = await runCustomerIntent({
      envelope,
      state: {},
      policy: fakePolicy,
      executor,
      ctx: { customerId: "cust_01", route: "enforce.test" },
    });

    expect(mockAdjudicate).toHaveBeenCalledTimes(1);
    expect(result.decision.kind).toBe("REFUSE");
    if (result.decision.kind === "REFUSE") {
      expect(result.decision.refusal.code).toBe("enforce.refuse");
    }
    expect(executor).not.toHaveBeenCalled();
  });
});
