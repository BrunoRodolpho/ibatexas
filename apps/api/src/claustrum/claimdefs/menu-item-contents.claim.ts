/**
 * MENU_ITEM_CONTENTS — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S3).
 *
 * THIS is the single editable artifact for the MENU_ITEM_CONTENTS claim type. It UNIONS
 * what was previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[MENU_ITEM_CONTENTS]      (~32 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[MENU_ITEM_CONTENTS] (~5 lines)
 *   - `required-claim-decomposer.ts` REQUIRED_CLAIM_CLOSURE row + the pt-BR markers
 *
 * See `./store-open-now.claim.ts` for the full compile contract and
 * `./menu-item-price.claim.ts` for the `perResourceKey` widening this type also uses; the
 * generated image is `./menu-item-contents.generated.ts` (`@generated` — DO NOT EDIT),
 * kept in sync by the `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ── WHY THIS TYPE MIGRATED IN THIS BATCH ────────────────────────────────────────
 *
 * It is MENU_ITEM_PRICE's structural twin — the SAME public per-item shape R2-S2 already
 * proved the widening on, with the same facet inventory and not one facet more:
 *
 *   - PUBLIC (`ownershipPolicy: "not_applicable"`), so `ownerScopedBaseKey` is
 *     `undefined` and no C1 ownership/IDOR surface is in play.
 *   - ONE required evidence, ONE falsifier, ONE value binding, a TWO-slot render — the
 *     identical shape its price sibling compiles to, differing only in the key
 *     (`menu:item_contents`) and the bound field (`contentsText`).
 *   - Its span markers were ONE flat top-level alternation, so the marker array below
 *     REJOINS to the pre-migration literal character-for-character (pinned by
 *     `__SPAN_NET_SOURCES_FOR_TEST.menuItemContents` — the R2-S1 STORE_INFO discipline).
 *   - A self-only closure row, no presence-complement partner (unlike CART_CONTENTS /
 *     CART_EMPTY, whose closure row is SHARED with a twin), no per-family
 *     CLARIFY/UNKNOWN template.
 *   - And it already had handleTurn-level VALIDATED-render proofs at the customer seam
 *     — `apps/api/src/__tests__/span-net-precision.e2e.test.ts` (BKL-205: "o que tem no
 *     brisket?" must render the BRISKET's own description and NOT the other product's, a
 *     directional PER-SUBJECT assertion) and
 *     `apps/api/src/__tests__/menu-diet-guard.e2e.test.ts` (BKL-273 control) — so the
 *     migration is provable end-to-end against REAL per-subject ledger evidence rather
 *     than only at the spec shape.
 *
 * ── THE FACET, AND WHY THE KEYS BELOW ARE BARE ──────────────────────────────────
 *
 * `perResourceKey: true` is the REPO-LOCAL widening (`./per-resource-claim.ts`): the
 * published `compileClaimDefinition` has no field for it and would SILENTLY DROP it, so
 * this source is authored with `definePerResourceClaim` and compiled with
 * `compilePerResourceClaimDefinition`. The declared keys are UNSUFFIXED BASES on purpose
 * — `selectCandidateClaim`'s `parameterizeKeysBySubject` (claim-registry.ts) appends
 * `:{subject}` to `requiredEvidence`, `falsifiers` AND `valueBinding.key` in LOCKSTEP at
 * runtime, matching the investigator's `menu:item_contents:{productId}`
 * (ibatexas-investigator.ts). The subject is the RESOLVED product id from the shared
 * `menu-item-resolver.ts`, which drives BOTH the candidate subject and the investigator
 * key, so they match by construction; an unresolvable item yields no candidate / absent
 * evidence → honest UNKNOWN, never an arbitrary product.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at
 * REGISTRY_SPECS — an owner ruling, not a projection), the span classifier's GUARD
 * conjunction (`notOrderScoped && !mutationImperative && !isMenuOverview` — the compiler
 * models markers, not suppression contexts, and the third conjunct is what keeps a
 * WHOLE-menu ask disjoint from this per-ITEM span), classify-only eligibility
 * (`classify-only-reads.ts`), the read binding (`claim-registry.ts` `deriveBoundValue` +
 * `menu-item-resolver.ts` `composeMenuContentsText`, which is ALSO where BKL-273's
 * allergen-ask refusal lives), the P2 pair table (`ibatexas-claims-kernel-deps.ts`) and
 * the planner personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// BKL-142 — MENU_ITEM_CONTENTS: the PUBLIC per-item composition read ("o que vem no
// combo?"). C6-bound to the first-party `contentsText` (the owner-authored product
// description, prefixed with the product title in menu-item-resolver.ts) — never
// model-authored.
export const MENU_ITEM_CONTENTS_SOURCE = definePerResourceClaim({
  type: "MENU_ITEM_CONTENTS",
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
      key: "menu:item_contents",
      ownershipPolicy: "not_applicable",
      // UNITS (BKL-121/BKL-125 pin): `cacheable` ttl is enforced in epoch-MILLISECONDS.
      // 300_000 ms = the ratified 5-minute catalog-freshness bound (vacuous within a
      // per-turn ledger, honest if an entry ever outlives a turn).
      freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered value to the read's ACTUAL `contentsText` field
  // (ledger-sourced, never model-authored). INV-7 is a COMPILE error here: the key is
  // typed as the literal union of this def's own requiredEvidence keys, and it is
  // suffixed by the SAME `:{subject}` as its requiredEvidence member at select time, so
  // it stays a member of that set and the kernel's C6 structural guard never throws.
  valueBinding: { key: "menu:item_contents", path: ["contentsText"] },

  // W6 — `menu:item_unpublished` is DECLARED (so this type escapes the W6 UNKNOWN-only
  // cap and can VALIDATE) but DELIBERATELY UNREAD by the investigator — the SAME
  // disposition MENU_ITEM_PRICE, MENU_OVERVIEW, CART_CONTENTS's `cart_cleared` and
  // ORDER_FULFILLMENT_STAGE's `order_cancelled` took after the #290/#291 review: a "this
  // product row is unpublished" signal derived from the SAME product row the description
  // came from is a TAUTOLOGY (an unpublished item already reads ABSENT ⇒ no present base
  // to demote) AND would re-introduce the exact same-row-tautology class those PRs
  // removed. Declaring-without-reading is sound: the runtime arm resolves an
  // always-absent key ⇒ never fires ⇒ demote-only safety is preserved. A future
  // INDEPENDENT signal (a catalog `product.unpublished` event, not this row) could wire
  // the read.
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

  // BKL-142 — the menu contents validated template. ONE proposition slot bound 1:1 to
  // the C6 valueBinding FIELD (`contentsText` above). The value is the full first-party
  // clause ("Brisket Americano: peito bovino defumado 12h no carvalho"), so the static
  // frame is just the closing period — the same single-C6-field shape as its price
  // sibling (the frozen single-scalar kernel drops every sibling read field post-mint).
  render: {
    validated: [prop("contentsText"), lit(".")],
  },

  // The §O#15 decomposition contribution.
  //
  // BKL-142 — a menu question requires ONLY its own PUBLIC claim (no unrelated span
  // force-requires it; like CART_CONTENTS_Q / RESERVATION_STATUS_Q). An unresolvable item
  // → ABSENT evidence → honest UNKNOWN; it never demotes a co-occurring answer beyond its
  // own span. This row is ALSO what auto-enrols MENU_ITEM_CONTENTS into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES via the closure-value union.
  //
  // The markers are the FOUR top-level arms of the single pre-migration alternation, IN
  // ORDER, so `markers.map((m) => m.source).join("|")` reproduces that literal exactly —
  // a `.some()` over the arms and a `.test()` on the alternation are the same predicate
  // (∃ position ∃ arm). BKL-205's ACCENTED forms (`v[êe]m` / `t[êe]m`) are INSIDE these
  // arms and travel with them: the accented vowel sits exactly where the plain one would,
  // so a silent loss here would empty the true-positive set on the real phrasing without
  // failing any false-positive sweep — which is why both spellings stay asserted
  // individually by test. The `[ée]` in arm 2 is a CHARACTER CLASS, not the `(é|e)`
  // alternation it replaced (Sonar S6035); same matched language, and the only use is
  // `.test`. The classifier's GUARD conjunction (`notOrderScoped && !mutationImperative
  // && !isMenuOverview`, which keeps "o que tem no meu CARRINHO/PEDIDO", "tira o que vem
  // no combo" and the WHOLE-menu asks off this span) is NOT part of this contribution and
  // stays hand-written.
  decomposition: {
    spanClass: "MENU_ITEM_CONTENTS_Q",
    markers: [
      /o que (v[êe]m|t[êe]m|acompanha)/,
      /do que [ée] (é |)feit/,
      /que v[êe]m (n|em)/,
      /composi[çc][ãa]o d/,
    ],
    requires: ["MENU_ITEM_CONTENTS"],
  },
});
