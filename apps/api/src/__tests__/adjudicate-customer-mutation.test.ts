/**
 * RC-A1 Phase B — the lazy-conductor adapter shared by every cutover route.
 *
 * Verifies the three branches of `adjudicateCustomerMutation`:
 *   - no conductor (inert/pre-activation)  → legacy mutation runs directly
 *   - conductor + EXECUTE                   → mutation runs as the onExecute callback
 *   - conductor + REFUSE                    → mutation does NOT run; typed IntentResult returned
 *
 * The bootstrap module is mocked so the conductor singleton is controllable and
 * the real composition (packs + router) is not loaded. Proves a `buildEnvelope`
 * envelope survives the gateway's forgery check and round-trips to a decision.
 */

import { describe, expect, it, vi } from "vitest";
import { decisionExecute, decisionRefuse, refuse } from "@adjudicate/core";
import type { Decision } from "@adjudicate/core";

const h = vi.hoisted(() => ({ conductor: null as unknown }));

vi.mock("../claustrum-bootstrap.js", () => ({
  tryGetConductor: () => h.conductor,
  getConductor: () => h.conductor,
  policyForKind: () => ({
    stateGuards: [],
    authGuards: [],
    business: [],
    taint: { minimumFor: () => "UNTRUSTED" as const },
    default: "EXECUTE" as const,
  }),
}));

const { adjudicateCustomerMutation } = await import(
  "../routes/__shared__/customer-intent-gateway.js"
);

function setConductor(adjudicate: () => Promise<Decision>): void {
  h.conductor = { adjudicator: { adjudicate } };
}

const base = {
  kind: "order.note.add",
  payload: { orderId: "o1", body: "sem cebola" },
  customerId: "c1",
  state: { ctx: { channel: "web", customerId: "c1", cartId: null, orderId: "o1" } },
};

describe("adjudicateCustomerMutation — lazy-conductor", () => {
  it("legacy path (no conductor) runs the mutation directly", async () => {
    h.conductor = null;
    const legacy = vi.fn(async () => "done");
    const out = await adjudicateCustomerMutation({ ...base, legacy });
    expect(out).toEqual({ ran: true, result: "done" });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("routed EXECUTE: adjudicates, then runs the mutation as onExecute", async () => {
    setConductor(async () => decisionExecute([]));
    const legacy = vi.fn(async () => "created");
    const out = await adjudicateCustomerMutation({ ...base, legacy });
    expect(out).toEqual({ ran: true, result: "created" });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("routed REFUSE: returns the IntentResult and runs NO mutation", async () => {
    setConductor(async () =>
      decisionRefuse(refuse("BUSINESS_RULE", "nope", "Não posso.", "test refuse"), []),
    );
    const legacy = vi.fn(async () => "created");
    const out = await adjudicateCustomerMutation({ ...base, legacy });
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.intent.kind).toBe("refuse");
    expect(legacy).not.toHaveBeenCalled();
  });

  it("authenticated: envelope actor is principal:user + sessionId web:<customerId>", async () => {
    let captured: { actor?: { principal?: string; sessionId?: string } } = {};
    h.conductor = {
      adjudicator: {
        adjudicate: async (env: unknown) => {
          captured = env as typeof captured;
          return decisionExecute([]);
        },
      },
    };
    const out = await adjudicateCustomerMutation({ ...base, customerId: "c1", legacy: async () => "ok" });
    expect(out).toEqual({ ran: true, result: "ok" });
    expect(captured.actor?.principal).toBe("user");
    expect(captured.actor?.sessionId).toBe("web:c1");
  });

  it("guest (customerId null): builds a guest-principal envelope (web:guest), never a synthetic customer id", async () => {
    // RC-A1 Chunk 1 prerequisite (D-21.1): the guest-tolerant wrapper faithfully
    // represents an unauthenticated cart mutation — principal stays "user", the
    // sessionId is the honest "web:guest" marker (NOT a fabricated customerId), and
    // the absence of a customer rides state.ctx.customerId === null.
    let captured: { actor?: { principal?: string; sessionId?: string } } = {};
    h.conductor = {
      adjudicator: {
        adjudicate: async (env: unknown) => {
          captured = env as typeof captured;
          return decisionExecute([]);
        },
      },
    };
    const legacy = vi.fn(async () => "added");
    const out = await adjudicateCustomerMutation({
      kind: "order.item.add",
      payload: { cartId: "cart1", variantId: "v1", quantity: 1, allergens: [] },
      customerId: null,
      state: { ctx: { channel: "web", customerId: null, cartId: "cart1", orderId: null } },
      legacy,
    });
    expect(out).toEqual({ ran: true, result: "added" });
    expect(captured.actor?.principal).toBe("user");
    expect(captured.actor?.sessionId).toBe("web:guest");
    // never leak a synthetic id (no "null"/"undefined" smuggled into the session)
    expect(captured.actor?.sessionId).not.toMatch(/null|undefined/);
    expect(legacy).toHaveBeenCalledTimes(1);
  });
});
