/**
 * MENU_SUBSTITUTIONS — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S9).
 *
 * THIS is the single editable artifact for the MENU_SUBSTITUTIONS claim type. It UNIONS
 * what was previously scattered across two files:
 *
 *   - `claim-registry.ts` REGISTRY_SPECS[MENU_SUBSTITUTIONS]      (~28 lines)
 *   - `slot-grammar.ts`   VALIDATED_TEMPLATES[MENU_SUBSTITUTIONS] (~8 lines)
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./menu-substitutions.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard. FIXED-SUBJECT, so it compiles
 * through the PUBLISHED `compileClaimDefinition` (the R2-S1 `GenUnit` path).
 *
 * THIS SOURCE DECLARES NO `decomposition`, and here that is worth one extra sentence
 * beyond the R2-S6 rule: the SUBSTITUTION marker net is real and load-bearing, but it
 * lives in `./menu-pairings.claim.ts` because the SPAN owner declares the WHOLE span
 * contribution — `PAIRING_Q` is one question, both vocabularies classify a request into
 * it, and the compiler emits `spanClass`/`markers`/`requires` as one block. Read that
 * file's header for the ORDERED-ARM contract (the substitution net is `markers[0]`,
 * because `classifyPairingAsk` tests it first and it wins a tie) and for the MEASUREMENT
 * showing INV-4 cannot police this pair's agreement, both members being PUBLIC.
 *
 * Emitting no closure block is a structural fact, not a convention: the generated module
 * omits the `_CLOSURE` export entirely (the emitter's conditional), so no consumer can
 * splice a blank row for this type.
 *
 * THIS TYPE IS NOT A NEGATIVE ANSWER. It is a different QUESTION ("what do I have
 * INSTEAD"), which is why it can be a first-class VALIDATED claim while a
 * MENU_NO_PAIRINGS cannot exist at all — see `./menu-pairings.claim.ts`'s header for the
 * completeness argument that separates the two.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture`, the PRESENCE_COMPLEMENT_PAIRS
 * registration, the relation PRECEDENCE and the both-ask degrade (`classifyPairingAsk` /
 * `isBothPairingAsk`), the read binding (`claim-registry.ts` `deriveBoundValue` +
 * `pairing-resolver.ts`), classify-only eligibility, the P2 pair table and the planner
 * personas.
 *
 * pt-BR literals live HERE as DATA, never in the interpreter as code.
 */

import { defineClaim, lit, prop } from "@adjudicate/core";

// LE2-029 — MENU_SUBSTITUTIONS: the presence-COMPLEMENT of MENU_PAIRINGS. The
// investigator records `menu:substitutions` PRESENT *only* when the utterance asked what
// to have INSTEAD, so exactly one of the pair can ever be present in a turn. A read that
// found no subject, no edges, or no live product records NEITHER key → honest UNKNOWN.
export const MENU_SUBSTITUTIONS_SOURCE = defineClaim({
  type: "MENU_SUBSTITUTIONS",
  version: 1,
  kind: "read_claim",
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "structured",

  requiredEvidence: [
    {
      key: "menu:substitutions",
      ownershipPolicy: "not_applicable",
      // `must_read_this_turn` for the same reason as the pairing twin: the sentence names
      // LIVE product titles, and something that stopped being sold must stop being
      // suggested — the failure is sharper here, since the whole point of a substitution
      // answer is that the customer's first choice is unavailable.
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bound to the read's own `substitutionsText`, composed IN CODE by
  // pairing-resolver.ts from the authored graph's edges and the LIVE product titles.
  // Ledger-sourced, never model-authored, never a kebab handle (Hard Rule 4).
  valueBinding: { key: "menu:substitutions", path: ["substitutionsText"] },

  // The SAME `menu:pairings_changed` W6 falsifier the pairing twin declares, with the
  // same declared-but-deliberately-unread disposition: one graph/catalog-change signal
  // falsifies both relations off the same authored graph.
  falsifierComplete: true,
  falsifiers: [
    {
      key: "menu:pairings_changed",
      ownershipPolicy: "not_applicable",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // LE2-029 — the SUBSTITUTION template. Its own static frame, because answering an
  // absence is a different act from suggesting an addition: the customer here has already
  // been told they cannot have what they wanted, so the frame acknowledges the swap rather
  // than inviting an extra. The frame is an OFFER and asserts nothing about the world.
  render: {
    validated: [prop("substitutionsText"), lit(". Quer que eu troque?")],
  },
});
