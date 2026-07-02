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

import type { CandidateClaim, EvidenceLedger } from "@adjudicate/core";
import type { ClaimPlannerInput, ClaimPlannerPort } from "@claustrum/core";
import type { ClaimAuthContext, ClaimAwarePlannerPort } from "./ibatexas-planner.js";
import { ownedResourceIdsByBaseKey } from "./ibatexas-claims-kernel-deps.js";

/**
 * tag-then-derive STEP 2 for an OWNER-SCOPED, per-resource candidate (the
 * owner-positive close). `proposeClaims` deliberately leaves an owner-scoped
 * candidate's `value` undefined — the 4B authors none (tag protocol), and the
 * planner does NOT re-read an owner-scoped resource to derive it (that would
 * re-open the IDOR the per-turn owns predicate closes). Bind the value HERE, from
 * the SAME AUTHENTICATED owner-scoped read already PRESENT in this turn's ledger
 * (the entry at the parameterized `valueBinding.key`, e.g.
 * `order_fulfillment_stage:order-A`), so the kernel's C6 compares a FIRST-PARTY
 * value against itself (PASS) and the legit owner VALIDATEs — while the model is
 * still never a value author.
 *
 * IDOR-safe + sound by construction:
 *   - Only binds when `value` is undefined → a (defensive) model-authored value is
 *     left intact so C6 still REFUSES a mismatch (the over-claim guard is unweakened).
 *   - Only reads a PRESENT entry → a forged / cross-owner owner-scoped read errored
 *     in INVESTIGATE → absent → no value bound → C6 ABSTAINs → honest UNKNOWN.
 *   - Never sets `validated`, never skips a conjunct: ownership (`owns`), freshness,
 *     provenance and the falsifier arm all still run in `runClaimsKernel`. A bound
 *     value for a resource the actor does not own is still REFUSED by the ∀-evidence
 *     ownership conjunct ("no owner" ≠ "any owner", Inv 2).
 * Pure.
 */
function bindValueFromLedger(
  candidate: CandidateClaim,
  ledger: EvidenceLedger,
): CandidateClaim {
  const binding = candidate.soundness.valueBinding;
  // No binding, or the value is already set (model-authored / publish-free-derived
  // upstream) → leave untouched: C6 then guards it (PASS/REFUSED), never silently
  // overwritten from the ledger.
  if (binding === undefined || candidate.value !== undefined) return candidate;
  const resolution = ledger.resolve(binding.key);
  if (resolution.state !== "present" || resolution.entry === undefined) {
    return candidate;
  }
  return { ...candidate, value: resolution.entry.value };
}

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
      // FIX 1 + FIX 2 — thread the AUTHENTICATED owner-scoped context to the
      // planner so an owner-scoped candidate's actor (the authenticated principal)
      // and subject (an owner-scoped PRESENT read) derive from the conductor's
      // identity / owner-scoped reads, NEVER the model's self-assertion (IDOR-safe;
      // SDD §E C1, Inv 2). `ownedResourceIdsByBaseKey` reads ONLY entries that
      // resolved PRESENT in this turn's ledger (a forged/cross-owner read errored →
      // absent → excluded), so the set of admissible subjects is owner-scoped by
      // construction. Both inputs are optional on `ClaimPlannerInput` (a host that
      // never wired them yields no auth context → the planner fails closed).
      const auth: ClaimAuthContext = {
        ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
        ...(input.ledger === undefined
          ? {}
          : { ownedByBaseKey: ownedResourceIdsByBaseKey(input.ledger) }),
      };

      // Delegate to the existing planner's registry-walled `proposeClaims`. The
      // `ClaimPlan.candidates` are EXACTLY the typed `@adjudicate/core`
      // `CandidateClaim`s that PASSED the constrained-generation wall — the
      // `runClaimsKernel` input shape. The published seam also passes the
      // post-RESOLVE `plan`, but ibatexas frames candidates over the full
      // `CognitiveState`, so the resolved plan is not needed here.
      const claimPlan = await planner.proposeClaims(input.cognition, auth);

      // OWNER-POSITIVE close (tag-then-derive STEP 2 for owner-scoped types): bind
      // each owner-scoped candidate's value from the AUTHENTICATED owner-scoped read
      // already PRESENT in this turn's ledger, so the kernel's C6 compares a
      // first-party value (never a model value) and the legit owner VALIDATEs. No
      // ledger (an unwired host) → candidates pass through unchanged (fail-closed:
      // an undefined owner-scoped value → C6 ABSTAIN → UNKNOWN).
      //
      // BELT-AND-SUSPENDERS: @claustrum/core ≥ 0.4.0 CLAIMS-VALIDATE also performs
      // this exact ledger-exact value derivation in its per-turn reconcile (its
      // "(4b)" step) before `runClaimsKernel`. Doing it HERE too is idempotent (both
      // bind ONLY when `value === undefined`) and keeps the owner-positive close
      // self-contained + unit-testable at the ibatexas adapter layer, and resilient
      // to a host that wires an older claustrum without the reconcile.
      if (input.ledger === undefined) return claimPlan.candidates;
      const ledger = input.ledger;
      return claimPlan.candidates.map((c) => bindValueFromLedger(c, ledger));
    },
  };
}
