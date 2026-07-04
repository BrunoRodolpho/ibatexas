// ops-planner-context — the ops-plane deriver shape (NEW-032 slice B).

import { describe, expect, it } from "vitest";
import type { CognitiveState } from "@claustrum/core";
import { opsCapabilityPlanner } from "@ibatexas/pack-ops";
import { deriveOpsPlannerContext } from "../ops-planner-context.js";

const FAKE_STATE = {
  perception: { text: "acabou a picanha", channel: "system", receivedAt: "" },
  conversationId: "admin:staff_1",
  turnId: "t1",
} as unknown as CognitiveState;

describe("deriveOpsPlannerContext", () => {
  it("stamps the authenticated staffId + the staff ctx shape (customerId null, unauth)", () => {
    const derived = deriveOpsPlannerContext("staff_1")(FAKE_STATE);
    expect(derived.context).toEqual({});
    expect(derived.state).toEqual({
      ctx: {
        tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
        channel: "staff",
        customerId: null,
        staffId: "staff_1",
        isAuthenticated: false,
        cartId: null,
        orderId: null,
      },
    });
  });

  it("ignores the CognitiveState (staffId is a composition constant)", () => {
    const d1 = deriveOpsPlannerContext("staff_9")(FAKE_STATE);
    const d2 = deriveOpsPlannerContext("staff_9")({
      ...FAKE_STATE,
      conversationId: "admin:someone-else",
    } as CognitiveState);
    expect(d1.state).toEqual(d2.state);
  });

  it("drives opsCapabilityPlanner to advertise the ops surface for the staff ctx", () => {
    const { state, context } = deriveOpsPlannerContext("staff_1")(FAKE_STATE);
    const plan = opsCapabilityPlanner.plan(state as never, context as never);
    expect(plan.allowedIntents).toContain("product.availability.set");
    expect(plan.visibleReadTools).toContain("ops_snapshot");
  });
});
