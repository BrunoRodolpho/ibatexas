/**
 * COUPON_INVALID — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S9).
 *
 * THIS is the single editable artifact for the COUPON_INVALID claim type. It UNIONS what
 * was previously scattered across two files:
 *
 *   - `claim-registry.ts` REGISTRY_SPECS[COUPON_INVALID]      (~28 lines)
 *   - `slot-grammar.ts`   VALIDATED_TEMPLATES[COUPON_INVALID] (~8 lines)
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./coupon-invalid.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard. FIXED-SUBJECT, so it compiles
 * through the PUBLISHED `compileClaimDefinition` (the R2-S1 `GenUnit` path).
 *
 * THIS SOURCE DECLARES NO `decomposition`. It is the non-span-owning half of a
 * PRESENCE-COMPLEMENT PAIR: `COUPON_VALIDITY_Q` is declared in full — including this type
 * in its `requires` — by `./coupon-valid.claim.ts`. That file's header carries the two
 * things a reader needs here: the TIE-BREAK that made the positive member the owner of a
 * span named after NEITHER type (the first such case), and the MEASUREMENT showing INV-4
 * cannot police this pair's agreement, because both members are PUBLIC and INV-4's
 * forward direction obliges Triad-scoped types only.
 *
 * Emitting no closure block is a structural fact, not a convention: the generated module
 * omits the `_CLOSURE` export entirely (the emitter's conditional), so no consumer can
 * splice a blank row for this type.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture`, the PRESENCE_COMPLEMENT_PAIRS
 * registration, the read binding (`claim-registry.ts` `deriveBoundValue` +
 * `coupon-validity-resolver.ts`), classify-only eligibility, the P2 pair table and the
 * planner personas.
 *
 * pt-BR literals live HERE as DATA, never in the interpreter as code.
 */

import { defineClaim, lit, prop } from "@adjudicate/core";

// LE2-019 — COUPON_INVALID: the presence-COMPLEMENT of COUPON_VALID (the
// DELIVERY_COVERAGE / CART_CONTENTS pairing). The investigator records `coupon:invalid`
// PRESENT *only* when a SUCCESSFUL promotion lookup positively determined the code is not
// usable (absent / draft / inactive / outside its campaign window / budget-exhausted), so
// exactly ONE of the pair can ever be present in a turn. A lookup that ERRORED records
// NEITHER key → honest UNKNOWN (Inv 7: "could not check" is never "your coupon is
// invalid").
export const COUPON_INVALID_SOURCE = defineClaim({
  type: "COUPON_INVALID",
  version: 1,
  kind: "read_claim",
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "structured",

  requiredEvidence: [
    {
      key: "coupon:invalid",
      ownershipPolicy: "not_applicable",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bound to the read's own `invalidityText`, composed IN CODE by
  // coupon-validity-resolver.ts. Ledger-sourced, never model-authored.
  valueBinding: { key: "coupon:invalid", path: ["invalidityText"] },

  // The SAME `coupon:promotions_changed` W6 falsifier the positive twin declares, with
  // the same declared-but-deliberately-unread disposition: one promotion-change signal
  // falsifies both directions of one underlying fact.
  falsifierComplete: true,
  falsifiers: [
    {
      key: "coupon:promotions_changed",
      ownershipPolicy: "not_applicable",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // LE2-019 — the HONEST-NO template. Also a VALIDATED assertion (a definitive
  // not-usable determination off a SUCCESSFUL promotion lookup IS a fact, not an absence
  // of one), with its own static frame: the negative carries an offer to check ANOTHER
  // code where the positive carries the checkout hint. Bound 1:1 to the C6
  // `invalidityText`. It states no REASON by design — why a campaign is exhausted or a
  // promotion is still in draft is store-internal, and voicing it would assert facts the
  // customer cannot verify and the claim never validated.
  render: {
    validated: [
      prop("invalidityText"),
      lit(" — se você tiver outro código, me manda que eu confiro."),
    ],
  },
});
