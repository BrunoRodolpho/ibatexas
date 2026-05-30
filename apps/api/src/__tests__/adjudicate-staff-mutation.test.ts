/**
 * RC-A1 Phase B — the staff sibling of the lazy-conductor adapter.
 *
 * Verifies adjudicateStaffMutation:
 *   - no conductor (inert/pre-activation)  → legacy mutation runs directly
 *   - conductor + EXECUTE                   → mutation runs as onExecute
 *   - conductor + REFUSE                    → mutation does NOT run; typed result
 *   - conductor + REQUEST_CONFIRMATION      → mutation does NOT run (the refund
 *                                             magnitude ladder / status-force band)
 *   - the staff envelope carries taint:"TRUSTED" (NOT UNTRUSTED) and a
 *     "staff:<id>" sessionId — the customer/staff distinction at the kernel
 *     boundary.
 *
 * The bootstrap module is mocked so the conductor singleton is controllable and
 * the adjudicate() call captures the envelope it is handed.
 */

import { describe, expect, it, vi } from "vitest";
import {
  decisionExecute,
  decisionRefuse,
  decisionRequestConfirmation,
  refuse,
} from "@adjudicate/core";
import type { Decision, IntentEnvelope } from "@adjudicate/core";

const h = vi.hoisted(() => ({
  conductor: null as unknown,
  lastEnvelope: undefined as IntentEnvelope | undefined,
}));

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

const { adjudicateStaffMutation } = await import(
  "../routes/__shared__/customer-intent-gateway.js"
);

function setConductor(decision: () => Promise<Decision>): void {
  h.conductor = {
    adjudicator: {
      adjudicate: async (env: IntentEnvelope) => {
        h.lastEnvelope = env;
        return decision();
      },
    },
  };
}

const base = {
  kind: "payment.cash.confirm",
  payload: { orderId: "o1", paymentId: "p1", amountCentavos: 8900, staffId: "staff_1" },
  staffId: "staff_1",
  state: { ctx: { actor: { principal: "admin", id: "staff_1" }, exists: true, currentMethod: "cash" } },
};

describe("adjudicateStaffMutation — lazy-conductor (staff path)", () => {
  it("legacy path (no conductor) runs the mutation directly", async () => {
    h.conductor = null;
    const legacy = vi.fn(async () => "done");
    const out = await adjudicateStaffMutation({ ...base, legacy });
    expect(out).toEqual({ ran: true, result: "done" });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("routed EXECUTE: adjudicates, then runs the mutation as onExecute", async () => {
    setConductor(async () => decisionExecute([]));
    const legacy = vi.fn(async () => "confirmed");
    const out = await adjudicateStaffMutation({ ...base, legacy });
    expect(out).toEqual({ ran: true, result: "confirmed" });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("builds a TRUSTED envelope with a staff:<id> sessionId", async () => {
    setConductor(async () => decisionExecute([]));
    await adjudicateStaffMutation({ ...base, legacy: async () => "ok" });
    expect(h.lastEnvelope?.taint).toBe("TRUSTED");
    expect(h.lastEnvelope?.actor.principal).toBe("user");
    expect(h.lastEnvelope?.actor.sessionId).toBe("staff:staff_1");
  });

  it("routed REFUSE: returns the IntentResult and runs NO mutation", async () => {
    setConductor(async () =>
      decisionRefuse(refuse("BUSINESS_RULE", "nope", "Não posso.", "test"), []),
    );
    const legacy = vi.fn(async () => "confirmed");
    const out = await adjudicateStaffMutation({ ...base, legacy });
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.intent.kind).toBe("refuse");
    expect(legacy).not.toHaveBeenCalled();
  });

  it("routed REQUEST_CONFIRMATION (refund ladder / status-force): runs NO mutation", async () => {
    setConductor(async () =>
      decisionRequestConfirmation("Confirmar reembolso de R$ 600,00?", []),
    );
    const legacy = vi.fn(async () => "refunded");
    const out = await adjudicateStaffMutation({ ...base, legacy });
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.intent.kind).toBe("request_confirmation");
    expect(legacy).not.toHaveBeenCalled();
  });
});
