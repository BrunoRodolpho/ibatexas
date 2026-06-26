// ibatexas-claim-planner.ts — the candidate-claim source host (SDD §M / §Q.6;
// v1.1 §8). Implements the published @claustrum/core `ClaimPlannerPort` as a THIN
// HOST ADAPTER over the EXISTING Q6b claim-aware planner (`proposeClaims` on
// `ClaimAwarePlannerPort`, ibatexas-planner.ts) and the `claim-registry.ts`
// deterministic walls it already orchestrates:
//
//   - constrained generation over the registry enum (SDD §H/§P3) —
//     `constrainClaimGeneration` (only an in-enum claim TYPE becomes a typed
//     `CandidateClaim`; a hallucinated type is dropped, never free-generated);
//   - P4 completeness (SDD §C P4 / §J.8) — `checkCompleteness`;
//   - §O#9 closed-taxonomy safety routing — `routeSafety`.
//
// This adapter REUSES that planner — it does NOT reimplement the walls. It only
// adapts the published seam's `{ cognition, plan }` input to `proposeClaims`'s
// `CognitiveState` and surfaces the registry-constrained `candidates`. NO
// validation happens here: the candidates are the (bounded) planner's framing;
// the deterministic P1 soundness ∘ P2 consistency gates run downstream in the
// Conductor's CLAIMS-VALIDATE stage (`runClaimsKernel`, Q5).

import type { CandidateClaim } from "@adjudicate/core";
import type { ClaimPlannerInput, ClaimPlannerPort } from "@claustrum/core";
import type { ClaimAwarePlannerPort } from "./ibatexas-planner.js";

/**
 * Adapt the EXISTING Q6b claim-aware planner into the published
 * `ClaimPlannerPort`. The SAME planner instance is wired as the Conductor's
 * `planner` (its `PlannerPort.propose` is the intent path, unchanged); this
 * adapter exposes the additive `proposeClaims` seam as the CLAIMS-VALIDATE
 * stage's candidate source.
 */
export function createIbatexasClaimPlanner(
  planner: ClaimAwarePlannerPort,
): ClaimPlannerPort {
  return {
    async propose(
      input: ClaimPlannerInput,
    ): Promise<ReadonlyArray<CandidateClaim>> {
      // Delegate to the existing planner's registry-walled `proposeClaims`. The
      // `ClaimPlan.candidates` are EXACTLY the typed `@adjudicate/core`
      // `CandidateClaim`s that PASSED the constrained-generation wall — the
      // `runClaimsKernel` input shape. The published seam also passes the
      // post-RESOLVE `plan`, but ibatexas frames candidates over the full
      // `CognitiveState`, so the resolved plan is not needed here.
      const claimPlan = await planner.proposeClaims(input.cognition);
      return claimPlan.candidates;
    },
  };
}
