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

import { describe, expect, it, vi } from "vitest";
import type { CognitiveState, Plan } from "@claustrum/core";
import type { ClaimAwarePlannerPort, ClaimPlan } from "../ibatexas-planner.js";
import {
  buildClaimsSeams,
  claimsPipelineEnabled,
  CLAIMS_PIPELINE_ENABLED_ENV,
  warnOncePerMessage,
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
    // W5b per-turn owner-attribution seam is ALSO gated OFF.
    expect(seams.claimsKernelDepsForTurn).toBeUndefined();
    // E-2 render-from-claims seam is ALSO gated OFF (no renderer wired).
    expect(seams.claimsRenderer).toBeUndefined();
    // BKL-155/153 — the render-vs-draft precedence seam is PAIRED with the renderer
    // and gated OFF with it.
    expect(seams.claimsRenderPrecedence).toBeUndefined();
    // Spreading {} into the Conductor options adds no keys (byte-identical).
    expect(Object.keys(seams)).toHaveLength(0);
  });

  it("ON → all seams are injected (the host modules instantiate)", () => {
    const seams = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV });
    expect(seams.investigator).toBeDefined();
    expect(seams.claimPlanner).toBeDefined();
    expect(seams.claimsKernel).toBeDefined();
    // W5b — the per-turn owner-attribution seam (Track-A) is wired too.
    expect(seams.claimsKernelDepsForTurn).toBeDefined();
    // E-2 — the render-from-claims seam activates ATOMICALLY with the pipeline.
    expect(seams.claimsRenderer).toBeDefined();
    // BKL-155/153 — the render-vs-draft precedence seam is PAIRED with the renderer
    // (co-wired so it only runs where the render does — customer plane, claims-ON).
    expect(seams.claimsRenderPrecedence).toBeDefined();
    expect(typeof seams.claimsRenderPrecedence).toBe("function");
    // The seams are the published shapes the Conductor consumes.
    expect(typeof seams.investigator?.investigate).toBe("function");
    expect(typeof seams.claimPlanner?.propose).toBe("function");
    expect(typeof seams.claimsKernel?.soundness.owns).toBe("function");
    expect(typeof seams.claimsKernel?.soundness.outcomeConfirmed).toBe("function");
    expect(typeof seams.claimsKernel?.soundness.now).toBe("number");
    // claimsKernelDepsForTurn is the per-turn rebuild function the Conductor calls.
    expect(typeof seams.claimsKernelDepsForTurn).toBe("function");
    expect(typeof seams.claimsRenderer?.render).toBe("function");
  });
});

describe("claims-pipeline — BKL-108 unconditional boot marker", () => {
  it("OFF → the info sink still gets ONE 'disabled' line (state is never log-silent)", () => {
    const info = vi.fn();
    buildClaimsSeams({ planner: stubPlanner, env: OFF_ENV, info });
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0]![0] as string;
    expect(line).toContain("[claims-pipeline] disabled");
    expect(line).toContain(CLAIMS_PIPELINE_ENABLED_ENV);
  });

  it("ON → the info sink gets ONE 'ENABLED' line naming the flag", () => {
    const info = vi.fn();
    buildClaimsSeams({ planner: stubPlanner, env: ON_ENV, info });
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0]![0] as string;
    expect(line).toContain("[claims-pipeline] ENABLED");
    expect(line).toContain(`${CLAIMS_PIPELINE_ENABLED_ENV}=true`);
  });

  it("no info sink (the per-trigger factory path) → both states still assemble fine", () => {
    // The per-trigger factory deliberately omits `info` (boot-class marker must
    // not repeat per trigger) — assembly must be unaffected in both states.
    expect(buildClaimsSeams({ planner: stubPlanner, env: OFF_ENV })).toEqual({});
    expect(buildClaimsSeams({ planner: stubPlanner, env: ON_ENV }).investigator).toBeDefined();
  });
});

describe("claims-pipeline — warnOncePerMessage (BKL-003 per-trigger dedup)", () => {
  it("emits each DISTINCT message once, collapsing repeats across invocations", () => {
    const emitted: string[] = [];
    // Built ONCE (the dedup set lives in the closure); reused across triggers.
    const warn = warnOncePerMessage((m) => emitted.push(m));
    // Two below-floor kernels → two distinct messages, re-seen every trigger.
    warn("adjudicate below floor");
    warn("claustrum below floor");
    warn("adjudicate below floor"); // trigger 2 — repeat
    warn("claustrum below floor"); // trigger 2 — repeat
    warn("adjudicate below floor"); // trigger 3 — repeat
    expect(emitted).toEqual(["adjudicate below floor", "claustrum below floor"]);
  });

  it("does not truncate: BOTH package warnings on the first pass survive", () => {
    const sink = vi.fn();
    const warn = warnOncePerMessage(sink);
    warn("msg-A");
    warn("msg-B");
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, "msg-A");
    expect(sink).toHaveBeenNthCalledWith(2, "msg-B");
  });
});
