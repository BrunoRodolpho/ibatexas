/**
 * F-52 PHASE 1B — can the production planner PROPOSE `pix.charge.refund`?
 *
 * `Plan.allowedIntents` is the enforced surface, not a hint: @adjudicate/core's
 * planner contract states "the bridge enforces both — out-of-plan tool/intent
 * names are refused before the kernel sees them." So a kind absent from the
 * union of every composed planner's allowedIntents cannot be proposed at all.
 *
 * This drives the REAL planner objects. It is a measurement, not a grep.
 */

import { describe, expect, it } from "vitest";
import { IBATEXAS_COMPOSED_CAPABILITY_PLANNERS } from "@ibatexas/packs-composed";
import { pixCapabilityPlanner } from "@adjudicate/pack-payments-pix";
import { PIX_REMEDIATION_AGENT } from "@ibatexas/agents";

/** Union of allowedIntents across every composed planner, over a permissive state. */
/**
 * ONE shared state for both arms, so the only difference between them is WHICH
 * planner list is consulted. It carries a CONFIRMED charge because the pix
 * planner advertises `refund` only when one exists ("no confirmed charges →
 * only create is proposable") — an empty map would have made the control fail
 * for a reason that has nothing to do with wiring.
 */
function sharedState() {
  return {
    ctx: { tenantId: "ibatexas", channel: "web", customerId: "cust_001" },
    charges: new Map([
      [
        "chg_001",
        {
          chargeId: "chg_001",
          amountCentavos: 5_000,
          status: "confirmed",
          refundedCentavos: 0,
        },
      ],
    ]),
  };
}

function composedAllowedIntents(): {
  union: Set<string>;
  threw: string[];
} {
  const state = sharedState();
  const union = new Set<string>();
  const threw: string[] = [];
  for (const [i, planner] of IBATEXAS_COMPOSED_CAPABILITY_PLANNERS.entries()) {
    try {
      for (const k of planner.plan(state as never, {} as never).allowedIntents) {
        union.add(k);
      }
    } catch (err) {
      threw.push(`#${i}: ${(err as Error).message}`);
    }
  }
  return { union, threw };
}

describe("F-52 Phase 1b — the planner surface for the agent's money kind", () => {
  it("INSTRUMENT: the composed planners advertise a NON-EMPTY surface on this state", () => {
    const { union, threw } = composedAllowedIntents();
    // Without this, "pix.charge.refund is not advertised" would be true simply
    // because NOTHING is advertised — the vacuous reading.
    expect(threw).toEqual([]);
    expect(union.size).toBeGreaterThan(0);
  });

  it("CONTROL: the pix pack's OWN planner DOES advertise pix.charge.refund", () => {
    // So absence below is about WIRING, not about the kind being unadvertisable.
    const plan = pixCapabilityPlanner.plan(sharedState() as never, {} as never);
    expect(plan.allowedIntents).toContain("pix.charge.refund");
  });

  it("WITHIN-SUBJECT: of the agent's TWO declared kinds, exactly one is proposable", () => {
    const { union } = composedAllowedIntents();
    const declared = PIX_REMEDIATION_AGENT.declaredIntentKinds as ReadonlyArray<string>;
    expect([...declared].sort()).toEqual(["payment.pix.regenerate", "pix.charge.refund"]);
    // Same agent, same planner composition, same turn: one kind is advertised
    // and the other is not. The difference cannot be the agent or the state.
    expect(union.has("payment.pix.regenerate")).toBe(true);
    expect(union.has("pix.charge.refund")).toBe(false);
  });
});
