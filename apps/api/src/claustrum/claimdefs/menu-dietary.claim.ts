/**
 * MENU_DIETARY — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S3).
 *
 * THIS is the single editable artifact for the MENU_DIETARY claim type. It UNIONS what
 * was previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[MENU_DIETARY]      (~35 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[MENU_DIETARY] (~5 lines)
 *   - `required-claim-decomposer.ts` REQUIRED_CLAIM_CLOSURE row + the pt-BR markers
 *
 * See `./store-open-now.claim.ts` for the full compile contract and
 * `./menu-item-price.claim.ts` for the `perResourceKey` widening this type also uses; the
 * generated image is `./menu-dietary.generated.ts` (`@generated` — DO NOT EDIT), kept in
 * sync by the `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ── WHY THIS TYPE MIGRATED IN THIS BATCH ────────────────────────────────────────
 *
 * Its FACET INVENTORY is MENU_ITEM_PRICE's exactly — one required evidence, one
 * falsifier, one value binding, `perResourceKey` with every row `not_applicable`, a
 * self-only closure row, no presence-complement partner, no per-family CLARIFY/UNKNOWN
 * template — and its span markers were ONE flat top-level alternation, so the marker
 * array below REJOINS to the pre-migration literal character-for-character (pinned by
 * `__SPAN_NET_SOURCES_FOR_TEST.menuDietary`).
 *
 * TWO WAYS IT DIFFERS FROM ITS SIBLINGS, NEITHER of which reaches the compile contract:
 *
 *   1. The "resource id" is the dietary TAG (`vegetariano` / `vegano`), not a product id
 *      — the investigator records `menu:dietary:{tag}` after its OWN deterministic tag
 *      detection (`detectDietaryPreferenceTags`, menu-item-resolver.ts). The compiler
 *      never sees WHAT a subject denotes, only that the keys are parameterized, so this
 *      is a naming fact about the ledger and not a facet.
 *   2. The render is a BARE single proposition with NO closing literal — the STORE_INFO /
 *      MENU_OVERVIEW shape — because `composeDietaryOptionsText` already emits a complete
 *      sentence ending in its own period. `RenderSource.validated` is a NON-EMPTY tuple of
 *      slots, so a one-slot render is as expressible as a two-slot one; STORE_INFO
 *      compiles exactly this shape today.
 *
 * ── THE SUBJECT-PROVENANCE ASYMMETRY (pre-existing, deliberately NOT touched) ────
 *
 * On the CLASSIFY-ONLY path the subject comes from the LEDGER (`presentPublicItemIds` →
 * the `{tag}` suffix of the present `menu:dietary:{tag}` read), exactly like its menu
 * siblings. On the MODEL path it does NOT: `ibatexas-planner.ts`'s subject-derivation
 * switch has branches for STORE_HOURS_FOR_DATE and for MENU_ITEM_PRICE /
 * MENU_ITEM_CONTENTS, and MENU_DIETARY falls through to `input.subject ?? ""` — the
 * MODEL's tag. That degrades honestly rather than unsoundly (a tag no product carries →
 * ABSENT evidence → C6 ABSTAIN → honest UNKNOWN, never a fabricated dietary list, which
 * is the disposition BKL-214 designed for), and it is planner-side logic this migration
 * does not move: the compiler emits SPECS, TEMPLATES and CLOSURES, never subject
 * derivation. Recorded here because it is the one asymmetry a reader of this source
 * would otherwise have to rediscover.
 *
 * ── THE FACET, AND WHY THE KEYS BELOW ARE BARE ──────────────────────────────────
 *
 * `perResourceKey: true` is the REPO-LOCAL widening (`./per-resource-claim.ts`): the
 * published `compileClaimDefinition` has no field for it and would SILENTLY DROP it, so
 * this source is authored with `definePerResourceClaim` and compiled with
 * `compilePerResourceClaimDefinition`. The declared keys are UNSUFFIXED BASES on purpose
 * — `selectCandidateClaim`'s `parameterizeKeysBySubject` (claim-registry.ts) appends
 * `:{subject}` to `requiredEvidence`, `falsifiers` AND `valueBinding.key` in LOCKSTEP at
 * runtime, matching the investigator's `menu:dietary:{tag}`.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at
 * REGISTRY_SPECS — an owner ruling, not a projection, and for THIS type also the
 * BKL-171-reversal policy note), the span classifier's GUARD conjunction
 * (`notOrderScoped && !mutationImperative` — the compiler models markers, not suppression
 * contexts), classify-only eligibility (`classify-only-reads.ts`), the read binding
 * (`claim-registry.ts` `deriveBoundValue` + `menu-item-resolver.ts`
 * `resolveDietaryOptionsText`, which is ALSO where BKL-273's allergen-ask refusal lives),
 * the P2 pair table (`ibatexas-claims-kernel-deps.ts`) and the planner personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

// No `lit` import: this type's render is a BARE single proposition — the scalar
// `composeDietaryOptionsText` emits already ends in its own period, so there is no static
// pt-BR frame around it (the STORE_INFO / MENU_OVERVIEW shape, preserved verbatim).
import { prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// BKL-214 — MENU_DIETARY: the PUBLIC dietary-PREFERENCE read ("tem opção vegetariana?").
// C6-bound to the pre-composed `dietaryText` (a bounded, alphabetically-sorted list of
// first-party tagged product TITLES — no price, no allergen assertion, never a "não
// contém X" guarantee). Empty tag → ABSENT evidence → honest UNKNOWN (never a fabricated
// "we have vegetarian options").
export const MENU_DIETARY_SOURCE = definePerResourceClaim({
  type: "MENU_DIETARY",
  version: 1,
  kind: "read_claim",
  // PUBLIC per-item: never Triad-scoped, so INV-4 imposes no closure obligation (the
  // closure row below exists because this type HAS a span class, not because it owes one).
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "structured",

  // The repo-local widening. The keys below stay BARE BASES — the runtime suffixes them.
  perResourceKey: true,

  requiredEvidence: [
    {
      key: "menu:dietary",
      ownershipPolicy: "not_applicable",
      // UNITS (BKL-121/BKL-125 pin): `cacheable` ttl is enforced in epoch-MILLISECONDS.
      // 300_000 ms = the ratified 5-minute catalog-freshness bound (vacuous within a
      // per-turn ledger, honest if an entry ever outlives a turn).
      freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered value to the read's ACTUAL `dietaryText` field
  // (ledger-sourced, never model-authored). INV-7 is a COMPILE error here: the key is
  // typed as the literal union of this def's own requiredEvidence keys, and it is
  // suffixed by the SAME `:{subject}` as its requiredEvidence member at select time, so
  // it stays a member of that set and the kernel's C6 structural guard never throws.
  valueBinding: { key: "menu:dietary", path: ["dietaryText"] },

  // W6 — `menu:item_unpublished` is DECLARED (so this type escapes the W6 UNKNOWN-only
  // cap and can VALIDATE) but DELIBERATELY UNREAD by the investigator — the SAME
  // disposition MENU_ITEM_PRICE / MENU_ITEM_CONTENTS / MENU_OVERVIEW and CART_CONTENTS's
  // `cart_cleared` took after the #290/#291 review: an "unpublished item" signal derived
  // from the SAME tagged product rows the list came from is a TAUTOLOGY (an unpublished
  // item already reads ABSENT from the faceted query ⇒ no present base to demote) AND
  // would re-introduce the exact same-row-tautology class those PRs removed. Declaring-
  // without-reading is sound: the runtime arm resolves an always-absent key ⇒ never fires
  // ⇒ demote-only safety is preserved. A future INDEPENDENT signal (a catalog
  // `product.unpublished` event, not these rows) could wire the read.
  falsifierComplete: true,
  falsifiers: [
    {
      key: "menu:item_unpublished",
      ownershipPolicy: "not_applicable",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // BKL-214 — the dietary-preference validated template. ONE proposition slot bound 1:1
  // to the C6 valueBinding FIELD (`dietaryText` above): the deterministic tagged-product
  // list composed in menu-item-resolver.ts, never model-authored. A positive preference
  // list only — the scalar NEVER contains a "não contém X" allergen assurance. BARE
  // single-prop shape like MENU_OVERVIEW / STORE_INFO (the scalar is already a complete
  // sentence, period included).
  render: {
    validated: [prop("dietaryText")],
  },

  // The §O#15 decomposition contribution.
  //
  // BKL-214 — a dietary-PREFERENCE question requires ONLY the MENU_DIETARY claim. Its own
  // span, no unrelated span force-requires it, so it auto-enrols into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES via the closure-value union like the other menu claims. No
  // tagged product → ABSENT evidence → honest UNKNOWN; it never demotes a co-occurring
  // answer beyond its own span.
  //
  // BKL-273 — keeping this span MAPPED is what holds an allergen-adjacent diet ask ("tem
  // opção vegetariana sem glúten?") inside §O#15 completeness. The span condition that
  // used to suppress such asks was REMOVED by PR #441 (it sent the turn to the model,
  // which then authored the "sem glúten" answer); the guard now lives on the READ
  // (`resolveDietaryOptionsText` returns `undefined` → NO evidence → honest UNKNOWN → the
  // BKL-184 abstain + staff handoff). That is the LE2-029 negative result honoured rather
  // than the span being suppressed.
  //
  // The markers are the TWO top-level arms of the single pre-migration alternation, IN
  // ORDER, so `markers.map((m) => m.source).join("|")` reproduces that literal exactly —
  // a `.some()` over the arms and a `.test()` on the alternation are the same predicate
  // (∃ position ∃ arm). RESTRICTED to pure-preference stems: `vegetarian[ao]?` is
  // unanchored (it must also match inside "comida vegetariano"), while `\bvegan[ao]?\b`
  // IS word-bounded, and that asymmetry is LOAD-BEARING rather than an oversight — an
  // unanchored `vegan` would fire on any word containing it. Over-inclusion here is
  // DEMOTE-ONLY safe (no tagged product → honest UNKNOWN), which is why the arms stay
  // deliberately narrow instead of guessing at further diets. The classifier's GUARD
  // conjunction (`notOrderScoped && !mutationImperative`, which keeps "tira o prato
  // vegetariano do carrinho" on the mutation path and an order-scoped mention off this
  // span) is NOT part of this contribution and stays hand-written.
  decomposition: {
    spanClass: "MENU_DIETARY_Q",
    markers: [/vegetarian[ao]?/, /\bvegan[ao]?\b/],
    requires: ["MENU_DIETARY"],
  },
});
