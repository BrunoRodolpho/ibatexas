/**
 * MENU_ITEM_ALLERGENS — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S9).
 *
 * THIS is the single editable artifact for the MENU_ITEM_ALLERGENS claim type, and it is
 * the SMALLEST source in the corpus. It unions exactly ONE previously-scattered facet:
 *
 *   - `claim-registry.ts` REGISTRY_SPECS[MENU_ITEM_ALLERGENS]  (~22 lines)
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./menu-item-allergens.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard. FIXED-SUBJECT, so it compiles
 * through the PUBLISHED `compileClaimDefinition` (the R2-S1 `GenUnit` path).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  WHY IT WAS DEFERRED, AND WHAT CHANGED
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * R2-S1 REJECTED this type from its batch on the grounds that adopting it would prove
 * nothing: with no render template, no falsifiers and no closure row, the compile would
 * exercise none of the folds the slice existed to demonstrate. That judgement was right
 * for R2-S1 and is unchanged as a statement about EVIDENCE.
 *
 * What changed is the CENSUS. This slice's terminal claim is that every registry type is
 * either GENERATED or EXCLUDED-with-a-reason, pinned so a future type addition must
 * declare itself (`22 generated + 1 documented exclusion = 23`). A type left hand-written
 * because its adoption is unexciting is exactly the residue that census cannot tolerate:
 * it would leave the count at 21+2 with one of the two "exclusions" being an omission
 * nobody had ruled on. So this type is adopted for COMPLETENESS, and the honest scope of
 * what it proves is stated below rather than dressed up.
 *
 * ── EXACTLY WHICH FACETS ARE ABSENT, AND WHY EACH IS ABSENT ─────────────────────
 *
 *   - NO `falsifiers` / `falsifierComplete`. The type is therefore UNKNOWN-CAPPED by the
 *     kernel's W6 eligibility rule: without a declared falsifier set a claim can never
 *     reach VALIDATED at all. That is the fail-safe default, and for the registry's one
 *     safety-critical read it is the correct posture, not an oversight.
 *   - NO `valueBinding`. §5 stays value-agnostic for this type (C6 is a no-op), because
 *     there is no sentence to bind a value INTO.
 *   - NO `render`. This is the BKL-123 gate: adding a validated allergen template is
 *     soundness-sensitive and DECISION-gated (allergens are Hard-Rule-1 safety-critical; a
 *     renderer list-slot capability and an owner liability policy are prerequisites), so a
 *     genuinely-VALIDATED claim of this type would still SAFE-DEGRADE to the UNKNOWN
 *     template. The absence is load-bearing and is pinned by
 *     `../__tests__/proposable-renderable-drift.test.ts`, which asserts this type is one
 *     of exactly two proposable-but-unrenderable ones.
 *
 *     THE COMPILER HONOURS THAT ABSENCE STRUCTURALLY: a source with no `render` block
 *     compiles to `renderTemplate: undefined`, and the generator's emitter (which grew a
 *     conditional in this slice, mirroring the one it already had for a missing closure)
 *     omits the `_TEMPLATE` export ENTIRELY rather than emitting an empty-slot template
 *     nobody may splice. An always-empty template export sitting next to a type whose
 *     un-renderability is a ratified safety decision is precisely the dead, false artifact
 *     inv.18 v2 exists to prevent.
 *   - NO `decomposition`. This type owns no §O#15 span, and that is deliberate: allergen
 *     phrasing is detected by the SHARED `ALLERGEN_FAMILY_RE` in
 *     `required-claim-decomposer.ts`, which routes such an ask AWAY from a confident
 *     contents/overview render and into the ratified BKL-184 abstain + staff handoff
 *     (`slot-grammar.ts` SAFE_UNKNOWN_ALLERGEN_TEMPLATE). A span of its own would be a
 *     span whose only possible outcome is an abstain. `triadScoped: false` is what makes
 *     the absence sound — INV-4 imposes a closure obligation on Triad-scoped types only.
 *
 * SO WHAT THIS SOURCE DOES PROVE, stated at its real size: that the compiler's folds are
 * TOTAL over the degenerate case — a def with no optional block at all still projects a
 * correct registry row, a correct validator-wiring `ClaimDefinition`, and a doc card that
 * says `_(no render template)_` / `_(no decomposition)_` / `_(none — UNKNOWN-only until
 * falsifiers are enumerated)_` out loud. It is also the ONLY unit in the corpus that
 * generates exactly TWO mutation fixtures (EMPTY_REQUIRED_EVIDENCE + PROVENANCE_DENY),
 * which is what turned the drift harness's hardcoded `>= 4` floor into a DERIVED exact
 * count — a strictly tighter assertion for all 22 units, and one this type is the reason
 * for.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS
 * — an owner ruling; `abstain` here is DOCUMENTATION with zero behaviour change, since a
 * type with no template already abstains unconditionally, and it exists so a future author
 * who adds a template trips a contradiction instead of silently un-ratifying a closed
 * owner decision), the shared `ALLERGEN_FAMILY_RE` net and the BKL-184 abstain template
 * selection, and the planner personas.
 */

import { defineClaim } from "@adjudicate/core";

// SDD §E worked type — MENU_ITEM_ALLERGENS: a public, safety-critical INFORM read. The
// floor is `structured` precisely so a free-text "sem alérgenos" FAILS the C2 conjunct and
// degrades to UNKNOWN rather than validating an assurance no attested field backs.
export const MENU_ITEM_ALLERGENS_SOURCE = defineClaim({
  type: "MENU_ITEM_ALLERGENS",
  version: 1,
  kind: "read_claim",
  // PUBLIC and non-Triad: no INV-4 closure obligation, which is what makes the absent
  // `decomposition` block sound rather than an unreachable-type defect.
  triadScoped: false,
  customerScoped: false,
  // SDD §E: free-text "sem alérgenos" must fail → the floor is `structured`.
  minSourceIntegrity: "structured",

  requiredEvidence: [
    {
      key: "allergens",
      ownershipPolicy: "not_applicable",
      // `static`: the owner-attested allergens array is catalog configuration, not a
      // per-turn signal. (Hard Rule 1: always an explicit array, never inferred from a
      // product name or description.)
      freshnessPolicy: "static",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],
});
