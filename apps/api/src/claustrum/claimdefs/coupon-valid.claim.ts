/**
 * COUPON_VALID — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S9).
 *
 * THIS is the single editable artifact for the COUPON_VALID claim type. It UNIONS what
 * was previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[COUPON_VALID]      (~32 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[COUPON_VALID] (~8 lines)
 *   - `required-claim-decomposer.ts` the COUPON_VALIDITY_Q closure row + the coupon NOUN
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./coupon-valid.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard. FIXED-SUBJECT, so it compiles
 * through the PUBLISHED `compileClaimDefinition` (the R2-S1 `GenUnit` path): a promotion
 * is store policy, so there is ONE key and no `:{subject}` parameterization.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  WHO OWNS `COUPON_VALIDITY_Q` — the first pair whose span is named after NEITHER type
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * R2-S6's rule is "the source that OWNS THE SPAN declares the row", and for the cart and
 * delivery pairs ownership was settled by NAMING: `CART_CONTENTS_Q` and
 * `DELIVERY_COVERAGE_Q` are each spelled with their owner's type name. `COUPON_VALIDITY_Q`
 * is not — it is named after the QUESTION, and the pair are its two ANSWERS. R2-S7's
 * PICKUP_Q disposition is the other pole (a span no type owns stays hand-written), so the
 * rule under-determines this case and needs a stated tie-break rather than a preference.
 *
 * THE TEST R2-S7 ACTUALLY APPLIED, restated: would declaring the row in this source
 * publish a FALSE assertion? PICKUP_Q failed that test — a pickup question is not an
 * order-stage question, and saying so in `order-fulfillment-stage.claim.ts` would have
 * been a lie. It does not fail here: the two members are mutually-exclusive dispositions
 * of ONE underlying fact (a successful promotion lookup), so "a coupon-validity question
 * is answered by this type, or by its complement" is true of either member. Both are
 * admissible, which is exactly why a tie-break is needed.
 *
 * THE TIE-BREAK — THE POSITIVE MEMBER DECLARES THE ROW, and it is derived from how the
 * pair is already spelled everywhere else rather than invented here:
 *
 *   1. `CLAIM_REGISTRY`, the closure `requires`, and `PRESENCE_COMPLEMENT_PAIRS` all list
 *      the positive first, and R2-S6 resolved the cart pair the same way.
 *   2. `COUPON_VALIDITY_Q` shares a stem with COUPON_VALID and with no part of
 *      COUPON_INVALID.
 *   3. The registry defines the negative AS the derived one: "COUPON_INVALID: the
 *      presence-COMPLEMENT of COUPON_VALID". The anchor is the positive.
 *
 * The choice moves no byte — the row's span class and `requires` are identical whichever
 * file declares it — so it is a REVIEW property, recorded so the next pair inherits a
 * rule instead of re-deriving one.
 *
 * ── AND THE AGREEMENT IS NOT FAIL-CLOSED HERE ───────────────────────────────────
 *
 * Both members are PUBLIC (`triadScoped: false`), so INV-4's forward direction obliges
 * neither and cannot detect a `requires` that stopped naming the twin (MEASURED:
 * `COUPON_VALIDITY_Q loses COUPON_INVALID -> { ok: true }` against the real validator).
 * `./delivery-coverage.claim.ts`'s header carries the full measurement and the explicit
 * structural pin that stands in for it; the same applies verbatim to this pair.
 *
 * ── THE MARKER / GUARD SPLIT (the R2-S7/S8 method, applied) ─────────────────────
 *
 * The pre-migration span predicate is a CONJUNCTION with a mutation-shaped escape:
 *
 *     couponNoun ∧ ¬(applyShaped ∧ ¬modal) ∧ (applyShaped∧modal ∨ validityPhrase ∨ code)
 *
 * MEASURED, and it decides the split: NO conjunct of that predicate splits into arms that
 * rejoin byte-identically — every one of the four regexes is a single `(?<![a-z])(?:…)`
 * literal whose `|`s sit INSIDE the group, under a shared lookbehind, exactly like
 * R2-S8's `dateAnchor`. So the question is not "which conjunct decomposes" (none does)
 * but "which conjunct is the MARKER NET", and the compiler's own semantics answer it:
 * `markers` are the tokens that classify a request INTO a span, which is the coupon NOUN
 * — the topic gate. Everything else is READ-VS-MUTATION DISCRIMINATION, i.e. a guard, and
 * a `markers` array is disjunctive and cannot express the absence an apply-imperative
 * check needs.
 *
 * THIS IS NOT R2-S8's REJECTED ONE-ELEMENT ARRAY, and the difference is worth being
 * precise about. There, a genuinely multi-arm rejoinable conjunct (`scheduleContext`)
 * EXISTED and was chosen, so collapsing the other conjunct into one arm would have hidden
 * the discriminating half while a richer alternative sat unused. Here no such alternative
 * exists, and the one-arm relocation is the R2-S6 `cartRef` case at arm count one: the
 * `join("|")` is the arm's own source and `markers.some((m) => m.test(t))` is literally
 * the `.test(t)` the pre-migration `COUPON_NOUN_RE` ran.
 *
 * The guard half therefore carries BEHAVIOURAL must-fire / must-not-fire pins in
 * `../__tests__/required-claim-decomposer.test.ts` and `../__tests__/coupon-validity-claim.test.ts`,
 * not only a source-byte one — a byte pin is guard-blind BY CONSTRUCTION (delete the
 * apply-imperative guard and this net's bytes are still identical while "aplica o cupom X"
 * starts riding the read).
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture`, the three guard regexes
 * (`COUPON_VALIDITY_PHRASE_RE` / `COUPON_APPLY_IMPERATIVE_RE` / `COUPON_MODAL_QUESTION_RE`)
 * and the code-extraction fallback (`promotion-validity.ts` `detectCouponCodeInText` — a
 * FUNCTION, which no `markers` array can hold), the shared `!mutationImperative` gate, the
 * PRESENCE_COMPLEMENT_PAIRS registration, the CLARIFY-for-code template variant
 * (`slot-grammar.ts` SAFE_CLARIFY_COUPON_CODE_TEMPLATE — a per-family SAFE posture the
 * compiler's `render.validated` block has no shape for), classify-only eligibility, the
 * read binding (`deriveBoundValue` + `coupon-validity-resolver.ts`), the P2 pair table and
 * the planner personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { defineClaim, lit, prop } from "@adjudicate/core";

// LE2-019 — COUPON_VALID: the PUBLIC "this code is good" read. FIXED-SUBJECT single-key
// (the STORE_INFO / DELIVERY_COVERAGE shape — no perResourceKey, keys are never
// `:{subject}`-parameterized): the answer is about the STORE's promotion, so there is one
// key and no owner.
export const COUPON_VALID_SOURCE = defineClaim({
  type: "COUPON_VALID",
  version: 1,
  kind: "read_claim",
  // PUBLIC — a promotion is store policy, owned by nobody, so the SAME code is valid or
  // not regardless of who asks and a guest gets the same honest answer as an
  // authenticated customer. No INV-4 closure obligation (see the header).
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "structured",

  requiredEvidence: [
    {
      key: "coupon:valid",
      ownershipPolicy: "not_applicable",
      // `must_read_this_turn` (NOT cacheable): a promotion's status, campaign window and
      // budget move on their own (a budget exhausts on someone ELSE's checkout), so a
      // cacheable TTL would license the kernel to accept a stale entry — exactly the
      // staleness a "vale?" answer must not have.
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered sentence to the read's ACTUAL `validityText`, the scalar
  // coupon-validity-resolver.ts composes IN CODE from the promotion record's own code +
  // `application_method` (Hard Rule 2 for a fixed amount). Ledger-sourced, never
  // model-authored — the model cannot invent a discount.
  valueBinding: { key: "coupon:valid", path: ["validityText"] },

  // The `coupon:promotions_changed` W6 falsifier is DECLARED (escaping the W6
  // UNKNOWN-only cap so the type can VALIDATE) but DELIBERATELY UNREAD — the same
  // disposition STORE_INFO's `store:info_changed` and DELIVERY_COVERAGE's
  // `delivery:zones_changed` carry, and for the same reason: the only available "changed"
  // signal derives from the SAME promotion row the base read already returned this turn,
  // so firing it would be a tautology that demotes every truthful answer while catching
  // zero staleness. The declaration stays for a future INDEPENDENT signal (a
  // promotion-events stream).
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

  // LE2-019 — the GROUNDED-YES coupon template. ONE proposition slot bound 1:1 to the C6
  // valueBinding FIELD (`validityText`).
  //
  // The application hint is STATIC LITERAL text, not part of the proposition, and that
  // split is deliberate on TWO counts. First, the DELIVERY_COVERAGE reason: "é só
  // informar o código no checkout" asserts nothing about the world — it describes what
  // the CUSTOMER does next — so it belongs in the frame, not in the ledger-bound value.
  // Second, Decision 14: the sentence describes the customer entering a code at
  // checkout; it never says the SYSTEM will apply anything, because there is no apply /
  // price-adjustment path this sentence could promise. (LE2-023 amends the wording, not
  // the rule: `order.coupon.adjust` is now DECLARED, but it is workflow-scoped and
  // refused by policy, so it remains nothing a customer-facing sentence may offer.)
  render: {
    validated: [prop("validityText"), lit(". É só informar o código no checkout.")],
  },

  // The §O#15 decomposition contribution — the SHARED row (see the header for who owns
  // it and why, and for the measurement that INV-4 cannot police the agreement).
  //
  // LE2-019 — a coupon-VALIDITY question requires the complementary PAIR, exactly like
  // DELIVERY_COVERAGE_Q. The two read COMPLEMENTARY keys (`coupon:valid` vs
  // `coupon:invalid` — at most one is ever PRESENT after a SUCCESSFUL lookup), so exactly
  // one can validate and the other resolves honest UNKNOWN and is dropped by the kernel's
  // §D filter — never a rendered contradiction. Requiring both here is also what
  // auto-enrols the pair into the classify-only candidate set and into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES (an over-proposed coupon claim is DEMOTED on a turn whose
  // coupon span did not fire, KEPT when it did). The pair is ALSO registered in
  // PRESENCE_COMPLEMENT_PAIRS (`required-claim-decomposer.ts`) — without that registration
  // this very row would make §O#15 completeness STRUCTURALLY unsatisfiable (the LE2-002
  // defect; see the pair table's comment). PUBLIC (`not_applicable`) → never Triad-scoped,
  // and no unrelated span force-requires either type.
  //
  // ONE marker arm: the coupon NOUN, relocated VERBATIM from the pre-migration
  // `COUPON_NOUN_RE`. Byte-identity holds the LEFT anchor `(?<![a-z])` (without it the
  // noun matches mid-word) and the QUALIFICATION of `código` — a bare "código" is
  // deliberately NOT enough, because "qual o código do meu pedido?" is an order question.
  decomposition: {
    spanClass: "COUPON_VALIDITY_Q",
    markers: [
      /(?<![a-z])(?:cupom|cupons|cup[ãa]o|vouchers?|c[óo]digos?\s+(?:de\s+)?(?:desconto|promo[çc][ãa]o|promocional))/,
    ],
    requires: ["COUPON_VALID", "COUPON_INVALID"],
  },
});
