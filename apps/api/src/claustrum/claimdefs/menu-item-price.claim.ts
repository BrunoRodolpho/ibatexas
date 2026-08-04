/**
 * MENU_ITEM_PRICE — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S2).
 *
 * THIS is the single editable artifact for the MENU_ITEM_PRICE claim type. It UNIONS
 * what was previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[MENU_ITEM_PRICE]      (~46 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[MENU_ITEM_PRICE] (~5 lines)
 *   - `required-claim-decomposer.ts` REQUIRED_CLAIM_CLOSURE row + the pt-BR markers
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./menu-item-price.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ── WHY THIS TYPE IS THE FIRST PARAMETERIZED ADOPTION ───────────────────────────
 *
 * It is the STRUCTURALLY SIMPLEST of the eleven `perResourceKey` types, and simplest in
 * the sense that matters here: every facet it has is one the compiler already models, so
 * the slice tests the `perResourceKey` widening (`./per-resource-claim.ts`) and nothing
 * else.
 *
 *   - PUBLIC (`ownershipPolicy: "not_applicable"`), so `ownerScopedBaseKey` is
 *     `undefined` and no C1 ownership/IDOR surface is in play — the eight owner-scoped
 *     parameterized types (ORDER_FULFILLMENT_STAGE / PAYMENT_STATUS / RESERVATION_STATUS
 *     / CART_CONTENTS / CART_EMPTY / ORDER_HISTORY / PAYMENT_HISTORY) each add a second
 *     axis to a first proof of the facet.
 *   - ONE required evidence, ONE falsifier, ONE value binding, a TWO-slot render — the
 *     smallest complete shape among the per-item public trio.
 *   - Its span markers were ONE flat top-level alternation, so the marker array below
 *     REJOINS to the pre-migration literal character-for-character (pinned by
 *     `__SPAN_NET_SOURCES_FOR_TEST.menuItemPrice` — the R2-S1 STORE_INFO discipline).
 *   - A self-only closure row, no presence-complement partner (unlike CART_CONTENTS /
 *     CART_EMPTY, whose closure row is SHARED with a twin), no per-family
 *     CLARIFY/UNKNOWN template.
 *   - And it already had a handleTurn-level VALIDATED-render proof at the customer seam
 *     (`apps/api/src/__tests__/bkl271-pulled-pork-read.e2e.test.ts`), so the widening is
 *     provable end-to-end against REAL per-subject ledger evidence rather than only at
 *     the spec shape.
 *
 * STORE_HOURS_FOR_DATE — the other public parameterized candidate — was NOT chosen: its
 * span class is classified by a COMPOSED predicate (`dateAnchor && scheduleContext`, plus
 * a STORE_OPEN_NOW_Q suppression seam), not a flat marker alternation, so migrating it
 * would entangle a span-net restructure with the first proof of the facet.
 *
 * ── THE FACET, AND WHY THE KEYS BELOW ARE BARE ──────────────────────────────────
 *
 * `perResourceKey: true` is the REPO-LOCAL widening (`./per-resource-claim.ts`): the
 * published `compileClaimDefinition` has no field for it and would SILENTLY DROP it, so
 * this source is authored with `definePerResourceClaim` and compiled with
 * `compilePerResourceClaimDefinition`. The declared keys are UNSUFFIXED BASES on purpose
 * — `selectCandidateClaim`'s `parameterizeKeysBySubject` (claim-registry.ts) appends
 * `:{subject}` to `requiredEvidence`, `falsifiers` AND `valueBinding.key` in LOCKSTEP at
 * runtime, matching the investigator's `menu:item_price:{productId}`
 * (ibatexas-investigator.ts). The subject is the RESOLVED product id from the shared
 * `menu-item-resolver.ts`, which drives BOTH the candidate subject and the investigator
 * key, so they match by construction; an unresolvable item yields no candidate / absent
 * evidence → honest UNKNOWN, never an arbitrary product.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at
 * REGISTRY_SPECS — an owner ruling, not a projection), the span classifier's GUARD
 * conjunction (`notOrderScoped && !mutationImperative` — the compiler models markers,
 * not suppression contexts), classify-only eligibility (`classify-only-reads.ts`), the
 * read binding (`claim-registry.ts` `deriveBoundValue` + `menu-item-resolver.ts`), the
 * P2 pair table (`ibatexas-claims-kernel-deps.ts`) and the planner personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// BKL-142 — MENU_ITEM_PRICE: the PUBLIC per-item price read ("quanto custa a
// costela?"). C6-bound to a DETERMINISTICALLY PRE-COMPOSED pt-BR scalar (`priceText`,
// composed in menu-item-resolver.ts from INTEGER CENTAVOS — Hard Rule 2, NEVER
// model-authored).
export const MENU_ITEM_PRICE_SOURCE = definePerResourceClaim({
  type: "MENU_ITEM_PRICE",
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
      key: "menu:item_price",
      ownershipPolicy: "not_applicable",
      // UNITS (BKL-121/BKL-125 pin): `cacheable` ttl is enforced in epoch-MILLISECONDS.
      // 300_000 ms = the ratified 5-minute catalog-freshness bound (vacuous within a
      // per-turn ledger, honest if an entry ever outlives a turn).
      freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered value to the read's ACTUAL `priceText` field (ledger-sourced,
  // never model-authored). INV-7 is a COMPILE error here: the key is typed as the literal
  // union of this def's own requiredEvidence keys, and it is suffixed by the SAME
  // `:{subject}` as its requiredEvidence member at select time, so it stays a member of
  // that set and the kernel's C6 structural guard never throws.
  valueBinding: { key: "menu:item_price", path: ["priceText"] },

  // W6 — `menu:item_unpublished` is DECLARED (so this type escapes the W6 UNKNOWN-only
  // cap and can VALIDATE) but DELIBERATELY UNREAD by the investigator — the SAME
  // disposition CART_CONTENTS's `cart_cleared` / ORDER_FULFILLMENT_STAGE's
  // `order_cancelled` took after the #290/#291 review: a "this product row is
  // unpublished" signal derived from the SAME product row the price came from is a
  // TAUTOLOGY (an unpublished item already reads ABSENT ⇒ no present base to demote)
  // AND would re-introduce the exact same-row-tautology class those PRs removed.
  // Declaring-without-reading is sound: the runtime arm resolves an always-absent key
  // ⇒ never fires ⇒ demote-only safety is preserved. A future INDEPENDENT signal (a
  // catalog `product.unpublished` event, not this row) could wire the read.
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

  // BKL-142 — the menu price validated template. ONE proposition slot bound 1:1 to the
  // C6 valueBinding FIELD (`priceText` above). The value is the full first-party clause
  // ("Costela Defumada custa R$ 89,00"), so the static frame is just the closing period
  // — the same single-C6-field shape as CART_CONTENTS / STORE_HOURS_FOR_DATE (the frozen
  // single-scalar kernel drops every sibling read field post-mint).
  render: {
    validated: [prop("priceText"), lit(".")],
  },

  // The §O#15 decomposition contribution.
  //
  // BKL-142 — a menu question requires ONLY its own PUBLIC claim (no unrelated span
  // force-requires it; like CART_CONTENTS_Q / RESERVATION_STATUS_Q). An unresolvable item
  // → ABSENT evidence → honest UNKNOWN; it never demotes a co-occurring answer beyond its
  // own span. This row is ALSO what auto-enrols MENU_ITEM_PRICE into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES via the closure-value union.
  //
  // The markers are the FOUR top-level arms of the single pre-migration alternation, IN
  // ORDER, so `markers.map((m) => m.source).join("|")` reproduces that literal exactly —
  // a `.some()` over the arms and a `.test()` on the alternation are the same predicate
  // (∃ position ∃ arm). The classifier's GUARD conjunction (`notOrderScoped &&
  // !mutationImperative`, which keeps "quanto custa a ENTREGA" and "muda o preço do
  // brisket" off this span) is NOT part of this contribution and stays hand-written.
  decomposition: {
    spanClass: "MENU_ITEM_PRICE_Q",
    markers: [
      /quanto custa/,
      /quanto (custam|é|fica|sai|tá|ta)/,
      /qual (o |é o )?pre[çc]o/,
      /pre[çc]o d[aoe]/,
    ],
    requires: ["MENU_ITEM_PRICE"],
  },
});
