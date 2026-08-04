// F-21 (class rollout, site 2) — the PROMOTE-OVERWRITE premise, pinned.
//
// `processTriggerJob`'s two promotes write the terminal marker over the
// in-flight claim WITHOUT checking ownership:
//
//     await deps.redis.set(seenKey, DONE_MARKER, { EX: REDELIVERY_DONE_TTL_S });
//
// F-21 asked whether that is the same defect as the release path. The answer
// recorded in `agent-trigger-bridge.ts` (see its PROMOTE-OVERWRITE block) is
// no, on two grounds — one semantic, one MEASURED. This file pins the measured
// one, because it is the half that can rot silently.
//
// The measurement: an ownership-blind overwrite can only harm anyone if THIS
// invocation's claim can lapse while the invocation is still running, letting a
// second delivery re-claim the carrier before this one writes. It cannot, while
//
//     max(budgets.wallClockMsPerTrigger)  <  REDELIVERY_INFLIGHT_TTL_S
//
// and `runWithWallClock` does not merely observe that cap — it REJECTS at it,
// routing an over-running turn to the ownership-CONDITIONAL catch rather than
// to a promote.
//
// That premise is a property of the AGENT REGISTRY's budgets, not of the bridge
// code, so nothing in the bridge would notice it changing. Raising an agent's
// wall-clock budget to within the in-flight TTL re-opens the hazard and must
// re-open the decision. This test is what makes that loud.

import { describe, expect, it } from "vitest";
import { AGENT_REGISTRY } from "@ibatexas/agents";
import { REDELIVERY_INFLIGHT_TTL_S } from "../agent-trigger-bridge.js";

describe("PROMOTE-OVERWRITE premise — the in-flight claim outlives every turn", () => {
  it("every registered agent's wall-clock budget is strictly inside the in-flight TTL", () => {
    const inflightMs = REDELIVERY_INFLIGHT_TTL_S * 1000;

    // A hand-written roll call over the registry, reported as NAMED offenders
    // rather than a bare count, so a failure says which agent broke it.
    const offenders = AGENT_REGISTRY.filter(
      (a) => a.budgets.wallClockMsPerTrigger >= inflightMs,
    ).map((a) => `${a.id} (${a.budgets.wallClockMsPerTrigger}ms >= ${inflightMs}ms)`);

    expect(offenders).toEqual([]);
  });

  it("the measured margin is at least 2x (documented as 5x on the current registry)", () => {
    const inflightMs = REDELIVERY_INFLIGHT_TTL_S * 1000;
    const worst = Math.max(
      ...AGENT_REGISTRY.map((a) => a.budgets.wallClockMsPerTrigger),
    );

    // Not merely "less than": a budget one millisecond inside the TTL would
    // satisfy the case above while leaving no room for scheduling jitter
    // between the claim and the promote. 2x is the floor this decision was
    // taken under; the registry currently sits at 5x (60_000 vs 300_000).
    expect(worst * 2).toBeLessThanOrEqual(inflightMs);
  });

  it("the registry is non-empty (the roll call above is not vacuous on [])", () => {
    // Both cases above pass trivially against an empty registry — `filter`
    // returns [] and `Math.max()` of nothing is -Infinity. This is the guard
    // that makes them claims about real agents.
    expect(AGENT_REGISTRY.length).toBeGreaterThan(0);
    for (const agent of AGENT_REGISTRY) {
      expect(agent.budgets.wallClockMsPerTrigger).toBeGreaterThan(0);
    }
  });

  it("REDELIVERY_INFLIGHT_TTL_S is the 5-minute window the decision was taken under", () => {
    // A value pin, so lowering the TTL (the other way to break the premise)
    // reds here too rather than only showing up as a shrinking margin.
    expect(REDELIVERY_INFLIGHT_TTL_S).toBe(300);
  });
});
