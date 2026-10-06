/**
 * MENU_PAIRINGS — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S9).
 *
 * THIS is the single editable artifact for the MENU_PAIRINGS claim type. It UNIONS what
 * was previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[MENU_PAIRINGS]      (~36 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[MENU_PAIRINGS] (~8 lines)
 *   - `required-claim-decomposer.ts` the PAIRING_Q closure row + BOTH relation nets
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./menu-pairings.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard. FIXED-SUBJECT, so it compiles
 * through the PUBLISHED `compileClaimDefinition` (the R2-S1 `GenUnit` path): what the
 * house serves together is store knowledge under ONE key, with no `:{subject}`
 * parameterization.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  THIS IS THE FAMILY THE COMPILER WAS BUILT FOR
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * LE2-029 registered this pair across SIX files and +430 lines in the pre-compiler era.
 * Three of those files' contributions are now projections of this one source (the
 * registry row, the render template, the closure row + markers); the other three
 * (`PRESENCE_COMPLEMENT_PAIRS`, `pairing-resolver.ts`, the planner personas) are the
 * facets no per-type source can hold, and they stay where they are.
 *
 * ── WHO OWNS `PAIRING_Q` ────────────────────────────────────────────────────────
 *
 * MENU_PAIRINGS, by NAMING (the CART_CONTENTS_Q / DELIVERY_COVERAGE_Q settlement, not
 * the tie-break `./coupon-valid.claim.ts` had to state): the span is `PAIRING_Q`, the
 * predicate is `isPairingAsk`, and the resolver's relation enum spells this half
 * `pairs-with`. `menu-substitutions.claim.ts` declares no `decomposition`.
 *
 * INV-4 CANNOT POLICE THE AGREEMENT for this pair either — both members are PUBLIC
 * (`triadScoped: false`) and INV-4's forward direction obliges Triad-scoped types only
 * (MEASURED: `PAIRING_Q loses MENU_SUBSTITUTIONS -> { ok: true }` against the real
 * validator). `./delivery-coverage.claim.ts`'s header carries the full measurement and
 * the explicit structural pin that stands in for it.
 *
 * ── THE MARKERS ARE ORDERED, AND THE ORDER IS LOAD-BEARING ──────────────────────
 *
 * This is the ONLY generated marker array in the corpus whose ORDER a RUNTIME BRANCH
 * reads, so it is called out rather than left to be discovered.
 *
 * The span predicate is a flat disjunction of two literals that were ALREADY separate
 * regexes `||`-ed at the use site (the R2-S4 relocation-with-no-splitting case), so
 * `markers.some((m) => m.test(t))` is character-for-character the `isPairingAsk` the
 * classifier ran, and the two arms rejoin byte-identically (MEASURED). But the SAME two
 * regexes are also the RELATION DISCRIMINATOR: `classifyPairingAsk` tests SUBSTITUTION
 * FIRST and returns `substitutes-for`, falling through to `pairs-with` — a PRECEDENCE,
 * not a disjunction — and `isBothPairingAsk` needs both individually.
 *
 * So the arms are declared in the classifier's own test order —
 *
 *     markers[0] = the SUBSTITUTION net   (tested first; wins a tie)
 *     markers[1] = the PAIRING net
 *
 * — and `required-claim-decomposer.ts` reads them through NAMED index constants
 * (`PAIRING_SPAN_SUBSTITUTION_ARM` / `PAIRING_SPAN_PAIRING_ARM`) rather than bare
 * literals. That positional contract is a fact the `markers` schema does not carry, so it
 * is guarded the only way it can be: each arm's source is pinned BYTE-FOR-BYTE and
 * INDIVIDUALLY in `../__tests__/required-claim-decomposer.test.ts`, and the precedence
 * carries BEHAVIOURAL pins ("o que vai bem no lugar da costela" must resolve
 * `substitutes-for`, the ticket's own primary use case). Swap the two arms and the byte
 * pins go red before any behaviour has to be reasoned about.
 *
 * WHY THE SUBSTITUTION NET LIVES IN THE PAIRINGS SOURCE, which reads oddly at first: the
 * SPAN owner declares the WHOLE span contribution, exactly as `cart-contents.claim.ts`
 * declares a `requires` naming its twin. A span is one question; both vocabularies
 * classify a request into it; and splitting the array across the two sources is not
 * expressible — the compiler emits `spanClass`, `markers` and `requires` as ONE block.
 *
 * ── WHAT STAYS HAND-WRITTEN, and why each is not a marker ───────────────────────
 *
 *   - `classifyPairingAsk`'s PRECEDENCE and `isBothPairingAsk`'s CONJUNCTION + the
 *     `INTERROGATIVE_HEAD_RE` clause COUNT (≥2 heads ⟹ degrade). A `markers` array is
 *     disjunctive; it cannot express an ordering, a conjunction, or a count.
 *   - the shared `!mutationImperative` gate ("põe uma farofa junto do brisket" is an add,
 *     not a question) — the compiler models which markers classify INTO a span, never
 *     which contexts must suppress it.
 *   - the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS — an owner ruling), the
 *     PRESENCE_COMPLEMENT_PAIRS registration, classify-only eligibility, the read binding
 *     (`deriveBoundValue` + `pairing-resolver.ts` and its `PAIRING_GRAPH` egress), the P2
 *     pair table and the planner personas.
 *
 * ── THERE IS NO MENU_NO_PAIRINGS, AND THERE MUST NOT BE ─────────────────────────
 *
 * The negative twin of the PAIRING half is deliberately absent, and the reason is a
 * property of the DATA rather than a style preference. A validated negative is only sound
 * when the store behind it is COMPLETE. CART_EMPTY is honest because the cart is complete;
 * COUPON_INVALID is honest because a promotion lookup is complete. `PAIRING_GRAPH` is a
 * hand-authored seed of ten edges, grown one owner review at a time, so the ABSENCE of an
 * edge carries NO information about the world — it means "nobody has written this down
 * yet", and a MENU_NO_PAIRINGS claim would render as "nothing goes with this", an
 * assertion the data cannot support and that is usually false (Inv 7: "could not check" is
 * a distinct state from "the answer is no"). The full argument lives in
 * `claim-registry.ts`'s enum comment; it is summarized here because this is now the file
 * an author adding a claim type would open. MENU_SUBSTITUTIONS is NOT that twin — it is a
 * different QUESTION, not a negative answer.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { defineClaim, lit, prop } from "@adjudicate/core";

// LE2-029 — MENU_PAIRINGS: the PUBLIC "what goes with this" read. FIXED-SUBJECT
// single-key (the STORE_INFO / COUPON_VALID shape — no perResourceKey): the answer is
// about the STORE's own authored advice, so there is one key and no owner.
export const MENU_PAIRINGS_SOURCE = defineClaim({
  type: "MENU_PAIRINGS",
  version: 1,
  kind: "read_claim",
  // PUBLIC — what the house serves together is store knowledge owned by nobody, the same
  // answer regardless of who asks, so a guest gets the same grounded suggestion as an
  // authenticated customer. No INV-4 closure obligation (see the header).
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "structured",

  requiredEvidence: [
    {
      key: "menu:pairings",
      ownershipPolicy: "not_applicable",
      // `must_read_this_turn` (NOT cacheable): the SENTENCE names live product titles
      // resolved from the catalog this turn, and an object that stopped being sold must
      // stop being suggested — a cacheable TTL would license the kernel to accept a
      // suggestion for something off the menu.
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered sentence to the read's ACTUAL `suggestionsText`, the scalar
  // pairing-resolver.ts composes IN CODE from the authored graph's edges and the LIVE
  // product titles those edges resolve to. Ledger-sourced, never model-authored: the
  // model cannot invent a suggestion, and cannot invent the pt-BR name of one either.
  valueBinding: { key: "menu:pairings", path: ["suggestionsText"] },

  // The `menu:pairings_changed` W6 falsifier is DECLARED (escaping the W6 UNKNOWN-only
  // cap so the type can VALIDATE) but DELIBERATELY UNREAD — the same disposition
  // STORE_INFO's `store:info_changed` and COUPON_VALID's `coupon:promotions_changed`
  // carry, and for the same reason: the only available "changed" signal derives from the
  // SAME catalog read the base read already performed this turn, so firing it would be a
  // tautology that demotes every truthful answer while catching zero staleness.
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

  // LE2-029 — the PAIRING template. ONE ledger-bound proposition carrying the whole
  // factual payload: the sentence pairing-resolver.ts composed IN CODE from the authored
  // graph's edges and the LIVE product titles those edges resolved to. Never
  // model-authored, and never a handle — the customer sees the store's own pt-BR product
  // names (Hard Rule 4).
  //
  // The static frame is an OFFER and asserts nothing about the world: "quer que eu
  // adicione?" describes what the CUSTOMER may ask for next. It is deliberately not
  // "posso adicionar pra você" — this is a READ span, and a sentence that promised the
  // system would act would put a mutation on it (Decision 14's negative space, the
  // BKL-201/206 discipline).
  render: {
    validated: [prop("suggestionsText"), lit(". Quer que eu adicione algum ao pedido?")],
  },

  // The §O#15 decomposition contribution — the SHARED row (see the header).
  //
  // LE2-029 — a pairing/substitution question requires the complementary PAIR, on the
  // COUPON_VALIDITY_Q shape. The resolver classifies the utterance as ONE ask or the other
  // and records at most one key, so exactly one can validate and the other resolves honest
  // UNKNOWN and is dropped by the kernel's §D filter — never a rendered contradiction.
  // Requiring both here is also what auto-enrols the pair into the classify-only candidate
  // set and into RELEVANCE_GOVERNED_TYPES. The pair is ALSO registered in
  // PRESENCE_COMPLEMENT_PAIRS (`required-claim-decomposer.ts`) — without that registration
  // this row would make §O#15 completeness STRUCTURALLY unsatisfiable (the LE2-002
  // defect). PUBLIC (`not_applicable`) → never Triad-scoped.
  //
  // TWO arms, IN THE CLASSIFIER'S OWN TEST ORDER — substitution first (it wins a tie),
  // pairing second. The order is read at RUNTIME by `classifyPairingAsk` through named
  // index constants; see the header for why that positional contract exists and how it is
  // guarded.
  //
  // Byte-identity here holds the LEFT anchors `(?<![a-z])` on both arms (without them
  // "acabou" fires inside a longer word and "serve"-shaped stems match mid-word), the
  // ACCENTED alternatives spelled out inside each group (`inv[ée]s`, `ç[ãa]o`, `ções`,
  // `sugest[ãa]o`, `n[ãa]o`) — the BKL-205/BKL-270/BKL-271 lesson, where an ASCII-only
  // stem has an EMPTY true-positive set on the real phrasing — and the STOCK vocabulary
  // (`acabou` / `esgotad[oa]` / `sem estoque` / `não tem mais`) that makes an
  // out-of-stock complaint a substitution question rather than nothing at all.
  decomposition: {
    spanClass: "PAIRING_Q",
    markers: [
      /(?<![a-z])(?:no\s+lugar|em\s+vez|ao\s+inv[ée]s|substitui(?:r|ção|cao)?|substitut[oa]s?|troc(?:o|ar|a)\s+por|parecid[oa]\s+com|similar\s+a|acabou|esgotad[oa]|sem\s+estoque|n[ãa]o\s+tem\s+mais)/,
      /(?<![a-z])(?:combina(?:m|ç[ãa]o|coes|ções)?|vai\s+bem|v[ãa]o\s+bem|acompanha(?:m|mento)?s?|harmoniza(?:m)?|junto\s+com|pedir\s+junto|pra\s+acompanhar|para\s+acompanhar|sugest[ãa]o|sugere|recomenda)/,
    ],
    requires: ["MENU_PAIRINGS", "MENU_SUBSTITUTIONS"],
  },
});
