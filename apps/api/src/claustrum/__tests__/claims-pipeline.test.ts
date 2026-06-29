/**
 * B-PR1 — the composition-root claims-seam assembly (`claims-pipeline.ts`),
 * FLAG DEFAULT-OFF. These tests pin acceptance (a):
 *
 *   - DEFAULT-OFF: with no `ENABLE_CLAIMS_PIPELINE` (the default), the assembled
 *     seams are `{}` — NO investigator / claimPlanner / claimsKernel. Spread into
 *     `createConductor({ ... })`, `{}` adds no keys, so the Conductor is composed
 *     BYTE-IDENTICALLY to today (no INVESTIGATE / CLAIMS-VALIDATE stage).
 *   - NON-VACUOUS: with the flag ON, ALL THREE seams ARE injected (the three host
 *     modules instantiate) — proving the OFF result is a real gate, not a
 *     module that never wires anything.
 *
 * Pure unit tests — a tiny `ClaimAwarePlannerPort` stub; no DB / model / boot.
 */

import { describe, expect, it } from "vitest";
import type { CognitiveState, Plan } from "@claustrum/core";
import type { ClaimAwarePlannerPort, ClaimPlan } from "../ibatexas-planner.js";
import {
  buildClaimsSeams,
  claimsPipelineEnabled,
  CLAIMS_PIPELINE_ENABLED_ENV,
} from "../claims-pipeline.js";

const stubPlanner: ClaimAwarePlannerPort = {
  async propose(): Promise<Plan> {
    return { envelopes: [] };
  },
  async proposeClaims(_state: CognitiveState): Promise<ClaimPlan> {
    return { candidates: [], completeness: [], droppedClaimTypes: [] };
  },
};

const OFF_ENV: NodeJS.ProcessEnv = {};
const ON_ENV: NodeJS.ProcessEnv = { [CLAIMS_PIPELINE_ENABLED_ENV]: "true" };

describe("claims-pipeline — flag reader (default OFF)", () => {
  it("is OFF by default and only ON for the exact 'true' string", () => {
    expect(claimsPipelineEnabled(OFF_ENV)).toBe(false);
    expect(claimsPipelineEnabled({ [CLAIMS_PIPELINE_ENABLED_ENV]: "1" })).toBe(false);
    expect(claimsPipelineEnabled({ [CLAIMS_PIPELINE_ENABLED_ENV]: "false" })).toBe(false);
    expect(claimsPipelineEnabled(ON_ENV)).toBe(true);
  });
});

describe("claims-pipeline — buildClaimsSeams (byte-identical when OFF)", () => {
  it("OFF (default) → {} : no claims seams are injected", () => {
    const seams = buildClaimsSeams({ planner: stubPlanner, env: OFF_ENV });
    expect(seams).toEqual({});
    expect(seams.investigator).toBeUndefined();
    expect(seams.claimPlanner).toBeUndefined();
    expect(seams.claimsKernel).toBeUndefined();
    // E-2 render-from-claims seam is ALSO gated OFF (no renderer wired).
    expect(seams.claimsRenderer).toBeUndefined();
    // Spreading {} into the Conductor options adds no keys (byte-identical).
    expect(Object.keys(seams)).toHaveLength(0);
  });

  it("ON → all four seams are injected (the host modules instantiate)", () => {
    const seams = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV });
    expect(seams.investigator).toBeDefined();
    expect(seams.claimPlanner).toBeDefined();
    expect(seams.claimsKernel).toBeDefined();
    // E-2 — the render-from-claims seam activates ATOMICALLY with the pipeline.
    expect(seams.claimsRenderer).toBeDefined();
    // The seams are the published shapes the Conductor consumes.
    expect(typeof seams.investigator?.investigate).toBe("function");
    expect(typeof seams.claimPlanner?.propose).toBe("function");
    expect(typeof seams.claimsKernel?.soundness.owns).toBe("function");
    expect(typeof seams.claimsKernel?.soundness.outcomeConfirmed).toBe("function");
    expect(typeof seams.claimsKernel?.soundness.now).toBe("number");
    expect(typeof seams.claimsRenderer?.render).toBe("function");
  });
});
