/**
 * DELIVERY_NO_COVERAGE — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S9).
 *
 * THIS is the single editable artifact for the DELIVERY_NO_COVERAGE claim type. It
 * UNIONS what was previously scattered across two files:
 *
 *   - `claim-registry.ts` REGISTRY_SPECS[DELIVERY_NO_COVERAGE]      (~28 lines)
 *   - `slot-grammar.ts`   VALIDATED_TEMPLATES[DELIVERY_NO_COVERAGE] (~8 lines)
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./delivery-no-coverage.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by
 * the `./__tests__/generated-drift.test.ts` drift guard. FIXED-SUBJECT, so it compiles
 * through the PUBLISHED `compileClaimDefinition` (the R2-S1 `GenUnit` path).
 *
 * THIS SOURCE DECLARES NO `decomposition`, AND THAT IS THE POINT. It is the
 * non-span-owning half of a PRESENCE-COMPLEMENT PAIR: `DELIVERY_COVERAGE_Q` is declared
 * in full — including this type in its `requires` — by the span-owning
 * `./delivery-coverage.claim.ts`, on the R2-S6 shared-row rule. Read that file's header
 * for the rule, for the shapes R2-S6 rejected, and — the part that does NOT carry over
 * from the cart pair — for the MEASUREMENT showing INV-4 cannot police this pair's
 * agreement, because both members are PUBLIC (`triadScoped: false`) and INV-4's forward
 * direction only obliges Triad-scoped types.
 *
 * Emitting no closure block is a structural fact, not a convention: the generated module
 * omits the `_CLOSURE` export entirely (the emitter's conditional), so no consumer can
 * splice a blank row for this type.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at
 * REGISTRY_SPECS), the PRESENCE_COMPLEMENT_PAIRS registration and its LE2-013 incident
 * note (`required-claim-decomposer.ts` — a SET-level relation, and the reason the shared
 * row is satisfiable at all), the read binding (`claim-registry.ts` `deriveBoundValue` +
 * `delivery-coverage-resolver.ts`), classify-only eligibility, the P2 pair table and the
 * planner personas.
 *
 * pt-BR literals live HERE as DATA, never in the interpreter as code.
 */

import { defineClaim, lit, prop } from "@adjudicate/core";

// LE2-002 / NEW-007 — DELIVERY_NO_COVERAGE: the presence-COMPLEMENT of
// DELIVERY_COVERAGE (the CART_CONTENTS/CART_EMPTY pairing, BKL-163). The investigator
// records `delivery:no_coverage` PRESENT *only* when the estimation tool positively
// proved the supplied CEP falls outside every active zone, so exactly ONE of the pair
// can ever be present in a turn. A read that ERRORED or could not resolve records
// NEITHER key → honest UNKNOWN (Inv 7: "could not check" is never "we don't deliver").
export const DELIVERY_NO_COVERAGE_SOURCE = defineClaim({
  type: "DELIVERY_NO_COVERAGE",
  version: 1,
  kind: "read_claim",
  // PUBLIC — owned by nobody. No INV-4 closure obligation, which is also why this
  // type's presence in its twin's `requires` is NOT fail-closed (see the twin's header).
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "structured",

  requiredEvidence: [
    {
      key: "delivery:no_coverage",
      ownershipPolicy: "not_applicable",
      // `must_read_this_turn` for the same admin-editability reason as the positive
      // twin: a stale out-of-zone determination is a wrongly-confident "não entregamos".
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bound to the read's own `noCoverageText`, composed IN CODE by
  // delivery-coverage-resolver.ts. Ledger-sourced, never model-authored.
  valueBinding: { key: "delivery:no_coverage", path: ["noCoverageText"] },

  // The SAME `delivery:zones_changed` W6 falsifier the positive twin declares, with the
  // same declared-but-deliberately-unread disposition. Sharing the key is deliberate:
  // one zone-change signal falsifies both directions of one underlying fact.
  falsifierComplete: true,
  falsifiers: [
    {
      key: "delivery:zones_changed",
      ownershipPolicy: "not_applicable",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // LE2-002 / NEW-007 — the HONEST-NO template. Also a VALIDATED assertion (a definitive
  // out-of-every-zone determination IS a fact, not an absence of one), with its own
  // static frame: the negative carries a PICKUP offer where the positive carries the
  // checkout caveat. Bound 1:1 to the C6 `noCoverageText`.
  render: {
    validated: [
      prop("noCoverageText"),
      lit(" — mas você pode retirar aqui no restaurante, se preferir."),
    ],
  },
});
