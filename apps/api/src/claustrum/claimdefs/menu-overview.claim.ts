/**
 * MENU_OVERVIEW — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S9).
 *
 * THIS is the single editable artifact for the MENU_OVERVIEW claim type. It UNIONS what
 * was previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[MENU_OVERVIEW]      (~40 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[MENU_OVERVIEW] (~5 lines)
 *   - `required-claim-decomposer.ts` the MENU_OVERVIEW_Q closure row + its three nets
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./menu-overview.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * FIXED-SUBJECT, so this compiles through the PUBLISHED `compileClaimDefinition` (the
 * R2-S1 `GenUnit` path) and NOT R2-S2's per-resource wrapper — and the distinction is
 * substantive rather than incidental for this type, because it is the ONLY menu family
 * member that is not per-item. The evidence is a deterministic listing of the WHOLE
 * catalog under one key (`menu:overview`), which is why `publicPerItemBaseKey` must keep
 * resolving `undefined` for it while it resolves a base key for its three per-item
 * siblings.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  THE DECOMPOSITION — three flat arms generated, TWO ordering facts hand-written
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * The pre-migration span predicate is
 *
 *     notOrderScoped ∧ ¬mutationImperative ∧ (MENU_WORD ∨ MENU_BARE_ASK ∨ MENU_LIST_ASK)
 *
 * and the R2-S7/S8 method splits it exactly where the measurement says it splits.
 *
 * GENERATED — the three-way disjunction. The three regexes were ALREADY separate
 * literals `||`-ed at the use site (the Sonar S5843 split, and the R2-S4
 * relocation-with-no-splitting case), so `markers.some((m) => m.test(t))` is
 * character-for-character the predicate the classifier ran, and the arms rejoin
 * byte-identically to `__SPAN_NET_SOURCES_FOR_TEST.menuOverview` — a pin that ALREADY
 * EXISTED before this migration and whose expected VALUE is unchanged by it, which is the
 * strongest form the "not an equivalent regex, THE SAME regex" claim can take.
 *
 * THREE ARMS AND NOT FOUR, deliberately, and measured: `MENU_WORD_RE` itself splits at a
 * top-level `|` into `\bcard[áa]pio\b` and `\bmenu\b`, and that four-arm array would
 * rejoin byte-identically too. It is kept WHOLE because BKL-205 made it a separate
 * constant ON PURPOSE — "the menu named outright wins regardless of any locative
 * complement" is a statement about that arm as a UNIT, sitting opposite the bare-ask arm
 * that carries the locative lookahead. Splitting it further would invent surface the
 * pre-migration code did not have and dissolve the very contrast the ticket installed.
 *
 * HAND-WRITTEN — both ORDERING facts, and they are different kinds of thing:
 *
 *   1. The GUARD conjunction (`notOrderScoped && !mutationImperative`). The compiler
 *      models which markers classify INTO a span, never which contexts must suppress it,
 *      and a `markers` array is disjunctive so it cannot express an absence.
 *      `notOrderScoped` is what keeps "o que tem no meu PEDIDO/CARRINHO" off the whole-menu
 *      span; `!mutationImperative` keeps "tira o brisket do cardápio" on the mutation path.
 *
 *   2. The BKL-205 SPECIFICITY ORDERING — `isMenuOverview` is computed here and then
 *      consumed as `!isMenuOverview` by the per-ITEM contents span BELOW it. That is a
 *      SEQUENCING fact about `classifyRequestSpans` (one span's result suppressing
 *      another's), which no per-type source can express: this source can say what makes a
 *      request an overview question, never what an overview verdict does to a DIFFERENT
 *      type's span. It stays verbatim and in place.
 *
 * THE HALF OF BKL-205 THAT *DOES* TRAVEL, and it is the subtle one: the NEGATIVE
 * LOOKAHEAD `(?!\s+n[oa]s?\b|\s+em\b)` lives INSIDE the bare-ask arm, so it moves into
 * this file with it and is pinned byte-for-byte. That lookahead is the entire fix for the
 * measured defect where "o que tem NO BRISKET?" matched the bare-ask prefix, fired
 * MENU_OVERVIEW_Q, and the `!isMenuOverview` guard then SUPPRESSED the per-item span the
 * customer's question was actually about — so the turn did not degrade, it CONFIDENTLY
 * rendered the entire catalogue as the answer to "what is in the brisket". A wrong-FAMILY
 * render is the one direction the demote-only argument does not cover.
 *
 * Consequently the two halves are pinned DIFFERENTLY, and the asymmetry is the point: the
 * lookahead is inside a generated arm and a byte pin sees it; the ordering interplay is
 * outside every arm and a byte pin is BLIND to it (delete `!isMenuOverview` from the
 * contents span and this net's bytes are identical while the wrong-family render returns).
 * So the interplay carries BEHAVIOURAL must-fire / must-not-fire pins in
 * `../__tests__/required-claim-decomposer.test.ts` and `../__tests__/menu-claims.test.ts`.
 *
 * ── WHY THE ALLERGEN CONDITION IS NOT HERE (BKL-273) ────────────────────────────
 *
 * An earlier `!ALLERGEN_FAMILY_RE` conjunct on this span was DELETED by BKL-273 and must
 * not come back as a marker or a guard. Suppressing the SPAN did not route an
 * allergen-marked overview ask to the conservative abstain: it left the turn with NO read
 * span at all, so §O#15 had nothing to complete, no claims render fired, and the REAL
 * responder authored the dietary sentence itself (measured at the customer seam). The
 * span now always fires and the guard lives on the READ
 * (`menu-item-resolver.ts` `resolveMenuOverviewText`), exactly as LE2-029 placed the
 * pairing guard on `resolvePairings` for the same reason.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS
 * — an owner ruling, and for this type an `abstain` whose argument is about the LIST'S
 * RESPONSIVENESS rather than any one item), the two ordering facts above, classify-only
 * eligibility, the read binding (`claim-registry.ts` `deriveBoundValue` +
 * `menu-item-resolver.ts` `composeMenuOverviewText`), the P2 pair table and the planner
 * personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

// No `lit` import: this type's render is a BARE single proposition — the scalar
// menu-item-resolver.ts composes is already a complete sentence, so there is no static
// pt-BR frame around it (the STORE_INFO / MENU_DIETARY shape, preserved verbatim).
import { defineClaim, prop } from "@adjudicate/core";

// BKL-142 — MENU_OVERVIEW: the menu-WIDE overview ("o que tem no cardápio?"). PUBLIC and
// FIXED-SUBJECT like STORE_HOURS (single key, NOT perResourceKey) — the evidence is a
// deterministic listing of the whole catalog, not a per-item read. C6-bound to a
// pre-composed scalar (`overviewText` — first-party titles + centavos prices, composed in
// menu-item-resolver.ts; NO allergen/dietary — those stay carved out).
export const MENU_OVERVIEW_SOURCE = defineClaim({
  type: "MENU_OVERVIEW",
  version: 1,
  kind: "read_claim",
  // PUBLIC — owned by nobody, so INV-4 imposes no closure obligation. The
  // `decomposition` row below exists because this type OWNS the span, not because it owes
  // one. Unlike the three PAIRS in this batch it has no twin, so nothing about its row
  // depends on an agreement INV-4 cannot see.
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "structured",

  requiredEvidence: [
    {
      key: "menu:overview",
      ownershipPolicy: "not_applicable",
      // ttl in epoch-MILLISECONDS (BKL-121/BKL-125 pin) — 300_000 ms = the ratified
      // 5-minute catalog-freshness bound (vacuous within a per-turn ledger).
      freshnessPolicy: { kind: "cacheable", ttl: 300_000 },
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered value to the read's `overviewText` (ledger-sourced, never
  // model-authored). INV-7 is a COMPILE error here: the key is typed as the literal union
  // of this def's own requiredEvidence keys.
  valueBinding: { key: "menu:overview", path: ["overviewText"] },

  // W6 — `menu:item_unpublished` is DECLARED (so MENU_OVERVIEW escapes the W6
  // UNKNOWN-only cap and can VALIDATE) but DELIBERATELY UNREAD — the SAME disposition the
  // per-item menu claims + CART_CONTENTS's `cart_cleared` took after the #290/#291
  // review: an "unpublished item" signal derived from the SAME catalog rows the overview
  // came from is a same-row TAUTOLOGY (an unpublished item already reads ABSENT from the
  // published listing ⇒ no present base to demote) that would re-introduce the exact class
  // those PRs removed. Declaring-without-reading is sound: the runtime arm resolves an
  // always-absent key ⇒ never fires ⇒ demote-only safety preserved. A future INDEPENDENT
  // catalog `product.unpublished` event could wire it.
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

  // BKL-142 — the menu-WIDE overview validated template. ONE proposition slot bound 1:1
  // to the C6 `overviewText` (the deterministic first-party listing composed in
  // menu-item-resolver.ts `composeMenuOverviewText`), never model-authored. Bare
  // single-prop shape like STORE_INFO (the scalar is already a complete sentence).
  render: {
    validated: [prop("overviewText")],
  },

  // The §O#15 decomposition contribution.
  //
  // BKL-142 — a menu-WIDE overview question requires ONLY its own PUBLIC claim (like the
  // per-item menu spans). Empty catalog → ABSENT evidence → honest UNKNOWN; never demotes
  // a co-occurring answer. Public (`not_applicable`) → never Triad-scoped.
  //
  // The markers are the THREE already-separate literals the classifier `||`-ed, IN ORDER,
  // so `markers.map((m) => m.source).join("|")` reproduces the pinned reassembly exactly.
  // Arm 1 — the menu named outright, which must keep firing the overview even when the
  // utterance carries a locative ("o que tem no cardápio?"). Arm 2 — the bare
  // interrogative, carrying the BKL-205 NEGATIVE LOOKAHEAD that sends "o que tem no
  // brisket?" to the per-ITEM span instead; note `de` is deliberately NOT excluded, since
  // a category ask ("o que tem de sobremesa?") is an overview. Arm 3 — the list ask.
  decomposition: {
    spanClass: "MENU_OVERVIEW_Q",
    markers: [
      /\bcard[áa]pio\b|\bmenu\b/,
      /o que (voc[êe]s )?(t[êe]m|servem)(?!\s+n[oa]s?\b|\s+em\b)( (pra|para) comer)?/,
      /quais (os |as )?(pratos|op[çc][õo]es)/,
    ],
    requires: ["MENU_OVERVIEW"],
  },
});
