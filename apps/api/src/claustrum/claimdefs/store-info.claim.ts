/**
 * STORE_INFO — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S1).
 *
 * THIS is the single editable artifact for the STORE_INFO claim type. It UNIONS what
 * was previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[STORE_INFO]        (~32 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[STORE_INFO]   (~10 lines)
 *   - `required-claim-decomposer.ts` REQUIRED_CLAIM_CLOSURE row + the pt-BR markers
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./store-info.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * WHY THIS TYPE MIGRATED IN THIS BATCH: like STORE_OPEN_NOW it is PUBLIC and
 * FIXED-SUBJECT (no `perResourceKey` — the one registry facet
 * `compileClaimDefinition` cannot express), it has no presence-complement partner
 * (unlike DELIVERY_COVERAGE / COUPON_VALID / MENU_PAIRINGS, whose closure row is
 * SHARED with a twin), no per-family CLARIFY/UNKNOWN template, a single-proposition
 * render, a self-only closure row, and its span markers were ONE flat top-level
 * alternation — so the marker array below REJOINS to the pre-migration literal
 * character-for-character (pinned by `__SPAN_NET_SOURCES_FOR_TEST.storeInfo`, the
 * discipline `required-claim-decomposer.ts` already applies to its other split nets).
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at
 * REGISTRY_SPECS — an owner ruling, not a projection), the span classifier's GUARD
 * conjunction (`notResourceScoped && !mutationImperative` — the compiler models
 * markers, not guards), classify-only eligibility (`classify-only-reads.ts`), the read
 * binding (`claim-registry.ts` `deriveBoundValue` + `store-info-resolver.ts`), the P2
 * pair table (`ibatexas-claims-kernel-deps.ts`) and the planner personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

// No `lit` import: this type's render is a BARE single proposition — the scalar
// store-info-resolver.ts composes is already a complete sentence, so there is no static
// pt-BR frame around it (the MENU_OVERVIEW shape, preserved verbatim).
import { defineClaim, prop } from "@adjudicate/core";

// BKL-136 — STORE_INFO: the store address/parking read ("onde fica?"). PUBLIC
// fixed-subject single-key like MENU_OVERVIEW (`ownershipPolicy: not_applicable`,
// NOT perResourceKey), cacheable at the same 5-minute config-freshness bound. The
// `store:info_changed` falsifier is DECLARED (escapes the W6 UNKNOWN-only cap so
// STORE_INFO can VALIDATE) but DELIBERATELY UNREAD — the MENU_OVERVIEW
// `menu:item_unpublished` disposition: a "changed" signal derived from the SAME
// store row the info came from is the same-row tautology #290/#291 removed (a
// changed address already reads as the NEW `infoText` — there is no stale present
// base to demote within a must-read turn). A future INDEPENDENT store-config
// change event could wire the read.
export const STORE_INFO_SOURCE = defineClaim({
  type: "STORE_INFO",
  version: 1,
  kind: "read_claim",
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "structured",

  requiredEvidence: [
    {
      key: "store:info",
      ownershipPolicy: "not_applicable",
      // ttl in epoch-MILLISECONDS (BKL-121/BKL-125 pin) — 300_000 ms = the same
      // 5-minute config-freshness bound MENU_OVERVIEW ratified (vacuous within a
      // per-turn ledger).
      freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered value to the read's `infoText` (ledger-sourced, never
  // model-authored). INV-7 is a COMPILE error here: the key is typed as the literal
  // union of this def's own requiredEvidence keys.
  valueBinding: { key: "store:info", path: ["infoText"] },

  falsifierComplete: true,
  falsifiers: [
    {
      key: "store:info_changed",
      ownershipPolicy: "not_applicable",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // BKL-136 — the store-info validated template. ONE proposition slot bound 1:1 to
  // the C6 valueBinding FIELD (`infoText`, above) — the deterministic
  // pre-composed pt-BR address/parking sentence (store-info-resolver.ts), derived
  // from OWNER-ATTESTED Medusa store.metadata. Bare single-prop shape like
  // MENU_OVERVIEW (the scalar is already a complete sentence).
  render: {
    validated: [prop("infoText")],
  },

  // The §O#15 decomposition contribution.
  //
  // BKL-136 — a store-location/parking question requires ONLY its own PUBLIC claim
  // (like the menu spans). Absent/blank store metadata → ABSENT evidence → honest
  // UNKNOWN; never demotes a co-occurring answer. Public (`not_applicable`) → never
  // Triad-scoped.
  //
  // The markers are the SEVEN top-level arms of the single pre-migration alternation,
  // IN ORDER, so `markers.map((m) => m.source).join("|")` reproduces that literal
  // exactly — a `.some()` over the arms and a `.test()` on the alternation are the
  // same predicate (∃ position ∃ arm). The classifier's GUARD conjunction is NOT part
  // of this contribution and stays hand-written.
  decomposition: {
    spanClass: "STORE_INFO_Q",
    markers: [
      /onde (fica|é|estão|est[áa]|se localiza)/,
      /endere[çc]o/,
      /localiza[çc][ãa]o/,
      /localizad/,
      /estacionamento/,
      /estacionar/,
      /como (chego|chegar)/,
    ],
    requires: ["STORE_INFO"],
  },
});
