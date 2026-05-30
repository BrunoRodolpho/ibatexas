/**
 * RC-A1 Phase B — the SYSTEM sibling of the lazy-conductor adapter (webhook/cron path).
 *
 * Verifies adjudicateSystemMutation:
 *   - no conductor (inert/pre-activation)  → legacy mutation runs directly
 *   - conductor + EXECUTE                   → mutation runs
 *   - conductor + REFUSE                    → mutation does NOT run; ran:false
 *   - the envelope carries taint:"TRUSTED" and principal:"system" (the kernel
 *     actor union has no "staff"/"guest" — system is a first-class principal) with
 *     the supplied system sessionId.
 *
 * Unlike the customer/staff gateways this does NOT route through runCustomerIntent
 * (whose isCustomerEnvelope guard rejects principal:"system"); it adjudicates
 * directly. The bootstrap module is mocked so the conductor singleton is
 * controllable and the adjudicate() call captures the envelope it is handed.
 */

import { describe, expect, it, vi } from "vitest";
import { decisionExecute, decisionRefuse, refuse } from "@adjudicate/core";
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
    taint: { minimumFor: () => "TRUSTED" as const },
    default: "EXECUTE" as const,
  }),
}));

const { adjudicateSystemMutation } = await import(
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
  kind: "payment.status.reconcile",
  payload: { paymentId: "p1", newStatus: "paid", stripeEventId: "evt_1" },
  sessionId: "stripe:evt_1",
  state: { ctx: { actor: { principal: "system" }, exists: true } },
};

describe("adjudicateSystemMutation — lazy-conductor (system path)", () => {
  it("legacy path (no conductor) runs the mutation directly", async () => {
    h.conductor = null;
    const legacy = vi.fn(async () => "reconciled");
    const out = await adjudicateSystemMutation({ ...base, legacy });
    expect(out).toEqual({ ran: true, result: "reconciled" });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("routed EXECUTE: adjudicates, then runs the mutation", async () => {
    setConductor(async () => decisionExecute([]));
    const legacy = vi.fn(async () => "reconciled");
    const out = await adjudicateSystemMutation({ ...base, legacy });
    expect(out).toEqual({ ran: true, result: "reconciled" });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("builds a TRUSTED system envelope with the system sessionId", async () => {
    setConductor(async () => decisionExecute([]));
    await adjudicateSystemMutation({ ...base, legacy: async () => "ok" });
    expect(h.lastEnvelope?.taint).toBe("TRUSTED");
    expect(h.lastEnvelope?.actor.principal).toBe("system");
    expect(h.lastEnvelope?.actor.sessionId).toBe("stripe:evt_1");
    expect(h.lastEnvelope?.kind).toBe("payment.status.reconcile");
  });

  it("routed REFUSE: returns ran:false and runs NO mutation", async () => {
    setConductor(async () =>
      decisionRefuse(refuse("SECURITY", "nope", "Não autorizado.", "test"), []),
    );
    const legacy = vi.fn(async () => "reconciled");
    const out = await adjudicateSystemMutation({ ...base, legacy });
    expect(out.ran).toBe(false);
    if (!out.ran) expect(out.intent.kind).toBe("refuse");
    expect(legacy).not.toHaveBeenCalled();
  });
});
