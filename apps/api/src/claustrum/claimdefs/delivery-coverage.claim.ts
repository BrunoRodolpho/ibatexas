/**
 * DELIVERY_COVERAGE — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S9).
 *
 * THIS is the single editable artifact for the DELIVERY_COVERAGE claim type. It UNIONS
 * what was previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[DELIVERY_COVERAGE]      (~34 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[DELIVERY_COVERAGE] (~8 lines)
 *   - `required-claim-decomposer.ts` the DELIVERY_COVERAGE_Q closure row + its pt-BR markers
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./delivery-coverage.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * FIXED-SUBJECT, so this compiles through the PUBLISHED `compileClaimDefinition` (the
 * R2-S1 `GenUnit` path), NOT R2-S2's `compilePerResourceClaimDefinition` wrapper: a
 * coverage answer is about the STORE's delivery policy, so there is ONE key, no owner,
 * and no `:{subject}` parameterization anywhere in the chain.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  THE SHARED CLOSURE ROW — and the ONE way this pair differs from the cart pair
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * R2-S6 established the rule this row follows:
 *
 *   > A closure row is declared by the source that OWNS THE SPAN. A type that owns no
 *   > span of its own declares NO `decomposition` and is reached through its owner's row.
 *
 * DELIVERY_COVERAGE owns `DELIVERY_COVERAGE_Q`: the span is named after this type, and
 * the span's marker net is the coverage-ask net that gates THIS type's read.
 * `delivery-no-coverage.claim.ts` declares no `decomposition` at all and has no marker
 * net anywhere in the repo — the same fact about the code that made CART_CONTENTS the
 * cart pair's owner.
 *
 * WHERE THE INHERITANCE STOPS, and it is the load-bearing difference — MEASURED, not
 * inferred from the cart pair's header. R2-S6 could rely on the generic INV-4 to enforce
 * the two halves' AGREEMENT fail-closed, because BOTH cart types are `triadScoped: true`
 * and INV-4's forward direction ("every Triad-scoped type appears in some closure value")
 * therefore had something to fail on. BOTH members of THIS pair are PUBLIC and
 * `triadScoped: false`, so that direction imposes NO obligation on either one. The
 * measurement, run against the real `validateClaimDefinitions` over the real registry:
 *
 *     CART_CONTENTS_Q     loses CART_EMPTY           -> DECOMPOSITION_UNREACHABLE
 *     DELIVERY_COVERAGE_Q loses DELIVERY_NO_COVERAGE -> { ok: true }
 *     COUPON_VALIDITY_Q   loses COUPON_INVALID       -> { ok: true }
 *     PAIRING_Q           loses MENU_SUBSTITUTIONS   -> { ok: true }
 *
 * So for the three PUBLIC pairs adopted in this batch, INV-4 is VACUOUS as a pair-
 * agreement check. Copying the cart header's "the agreement check is already there"
 * sentence would have been a safety property the measurement denies — and the state it
 * would have left unguarded is not hypothetical: a `requires` that stopped naming the
 * twin removes it from `classifyOnlyRequiredTypes` (measured: the classify-only candidate
 * set is the closure-derived required set) and from RELEVANCE_GOVERNED_TYPES, so the
 * honest-NO branch silently stops being produced on the deterministic path. That is the
 * LE2-002 shape with the failure moved one seam over.
 *
 * WHAT CARRIES THE AGREEMENT INSTEAD: an EXPLICIT structural pin, derived rather than
 * hand-listed, in `./__tests__/generated-drift.test.ts` — every registered
 * PRESENCE_COMPLEMENT_PAIRS pair must be named TOGETHER by any closure row that names
 * either member, and the span-owning source must be the only declarer. It is weaker than
 * a boot-time refusal and is described as such; it is what is available without inventing
 * a second registry-load mechanism for a state the generic one cannot see.
 *
 * ── WHY THIS FAMILY WAS IN THE BATCH ────────────────────────────────────────────
 *
 * On every facet the compiler models it is the STORE_INFO row R2-S1 already proved —
 * ONE required-evidence row at floor `structured`, `not_applicable` ownership, provenance
 * `preserve`, ONE declared-but-deliberately-unread W6 falsifier, a single-C6-field render
 * off a deterministically pre-composed scalar — differing only in `must_read_this_turn`
 * where STORE_INFO is `cacheable`. What is new is the shared row above.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS
 * — an owner ruling, not a projection), the span GUARD (`!mutationImperative` plus the
 * SELF-REFERENCE exclusion inside `isDeliveryCoverageAsk` — the compiler models which
 * markers classify INTO a span, never which contexts must suppress it), the
 * PRESENCE_COMPLEMENT_PAIRS registration and its LE2-013 incident note (a SET-level
 * relation between two types, not a per-type facet — and this row's satisfiability
 * depends on it), the CLARIFY-for-CEP template variant (`slot-grammar.ts`
 * SAFE_CLARIFY_DELIVERY_CEP_TEMPLATE — a per-family SAFE posture the compiler's
 * `render.validated` block has no shape for), classify-only eligibility, the read binding
 * (`claim-registry.ts` `deriveBoundValue` + `delivery-coverage-resolver.ts`), the P2 pair
 * table and the planner personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { defineClaim, lit, prop } from "@adjudicate/core";

// LE2-002 / NEW-007 — DELIVERY_COVERAGE: the PUBLIC "we deliver there" read.
// FIXED-SUBJECT single-key (the STORE_INFO / MENU_OVERVIEW shape — no perResourceKey,
// keys are never `:{subject}`-parameterized): a coverage answer is about the STORE's
// delivery policy, so there is one key and no owner.
export const DELIVERY_COVERAGE_SOURCE = defineClaim({
  type: "DELIVERY_COVERAGE",
  version: 1,
  kind: "read_claim",
  // PUBLIC — owned by nobody, so INV-4 imposes no closure obligation. The
  // `decomposition` row below exists because this type OWNS the span, not because it
  // owes one. (And, per the header, that is exactly why INV-4 cannot police the row's
  // agreement with its twin.)
  triadScoped: false,
  customerScoped: false,
  minSourceIntegrity: "structured",

  requiredEvidence: [
    {
      key: "delivery:coverage",
      ownershipPolicy: "not_applicable",
      // `must_read_this_turn` (NOT cacheable): the fee/ETA are ADMIN-EDITABLE at any
      // moment (routes/admin/delivery-zones.ts) and the ticket requires an admin zone
      // edit to show up in the very next chat answer — a cacheable TTL would license
      // the kernel to accept a stale entry, which is exactly the staleness this claim
      // must not have.
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered sentence to the read's ACTUAL `coverageText`, the scalar
  // delivery-coverage-resolver.ts composes IN CODE from the zone row's INTEGER centavos
  // + minutes (Hard Rule 2). Ledger-sourced, never model-authored. INV-7 is a COMPILE
  // error here: the key is typed as the literal union of this def's own
  // requiredEvidence keys.
  valueBinding: { key: "delivery:coverage", path: ["coverageText"] },

  // The `delivery:zones_changed` W6 falsifier is DECLARED (escaping the W6 UNKNOWN-only
  // cap so the type can VALIDATE) but DELIBERATELY UNREAD — the same disposition
  // STORE_INFO's `store:info_changed` and CART_CONTENTS's `cart_cleared` carry, and for
  // the same reason: the only available "changed" signal derives from the SAME zone row
  // the base read already returned this turn, so firing it would be a tautology that
  // demotes every truthful answer while catching zero staleness the base misses. The
  // declaration stays for a future INDEPENDENT signal (a zone-events stream / the Redis
  // invalidation pub-sub).
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

  // LE2-002 / NEW-007 — the GROUNDED-YES delivery-coverage template. ONE proposition
  // slot bound 1:1 to the C6 valueBinding FIELD (`coverageText`): the deterministic
  // pt-BR scalar delivery-coverage-resolver.ts composes from the zone row's INTEGER
  // centavos + minutes (Hard Rule 2) — never model-authored, and never reachable
  // without a VALIDATED zone read behind it (which is precisely the ungrounded "Sim,
  // entregamos em Ibate" this ticket closes).
  //
  // The SOFT CAVEAT is STATIC LITERAL text, not part of the proposition, and that split
  // is deliberate: "confirmo certinho pelo endereço no checkout" asserts nothing about
  // the world — it describes what the SYSTEM will do next — so it belongs in the frame,
  // not in the ledger-bound value. Keeping it literal also means it can never be dropped
  // by the frozen single-C6-field mint (which keeps only the bound path and discards
  // every sibling read field).
  render: {
    validated: [prop("coverageText"), lit(". Confirmo certinho pelo endereço no checkout.")],
  },

  // The §O#15 decomposition contribution — the SHARED row (see the header).
  //
  // LE2-002 / NEW-007 — a delivery-COVERAGE question requires the complementary PAIR,
  // exactly like CART_CONTENTS_Q requires CART_CONTENTS + CART_EMPTY. The two read
  // COMPLEMENTARY keys (`delivery:coverage` vs `delivery:no_coverage` — at most one is
  // ever PRESENT), so exactly one can validate and the other resolves honest UNKNOWN and
  // is dropped by the kernel's §D filter — never a rendered contradiction. Requiring
  // both here is also what auto-enrols the pair into the classify-only candidate set and
  // into the claim-planner's RELEVANCE_GOVERNED_TYPES (an over-proposed coverage claim
  // is DEMOTED on a turn whose coverage span did not fire, KEPT when it did). PUBLIC
  // (`not_applicable`) → never Triad-scoped, and no unrelated span force-requires either
  // type.
  //
  // The markers are the TEN top-level arms of the single pre-migration
  // `DELIVERY_COVERAGE_ASK_RE` literal, IN ORDER, so `markers.map((m) => m.source)
  // .join("|")` reproduces that literal exactly — a `.some()` over the arms and a
  // `.test()` on the alternation are the same predicate (∃ position ∃ arm). Measured:
  // the depth-0 split rejoins BYTE-IDENTICALLY. The GUARD half is NOT part of this
  // contribution and stays hand-written in `isDeliveryCoverageAsk`: the SELF-REFERENCE
  // exclusion is what keeps "cadê minha entrega?" an owner-scoped ORDER question, and a
  // `markers` array is DISJUNCTIVE — it cannot express an absence.
  //
  // Byte-identity here holds two things a rewrite would quietly lose. (1) The trailing
  // `(?![a-z])` on arms 2 and 5, without which `entregam em` fires inside a longer word
  // and `atende no` inside "atende nossa". (2) The ACCENT CHARACTER CLASSES
  // (`voc[êe]s`, `at[ée]`, `regi[õo]es`, `pre[çc]o`) — the BKL-205/BKL-270/BKL-271
  // lesson, where an ASCII-only stem has an EMPTY true-positive set on the real phrasing
  // and no false-positive sweep reveals it.
  decomposition: {
    spanClass: "DELIVERY_COVERAGE_Q",
    markers: [
      /voc[êe]s\s+entregam/,
      /(?:faz|fazem)\s+entrega/,
      /entregam?\s+(?:em|no|na|nos|nas|pra|para|at[ée])(?![a-z])/,
      /(?:onde|at[ée]\s+onde)\s+(?:voc[êe]s\s+)?entregam/,
      /(?:[áa]rea|regi[õo]es?|regi[ãa]o|zona)\s+de\s+entrega/,
      /atende[m]?\s+(?:em|no|na|nos|nas)(?![a-z])/,
      /taxa\s+de\s+(?:entrega|frete)/,
      /(?:valor|pre[çc]o)\s+d[oa]\s+(?:entrega|frete)/,
      /quanto\s+(?:custa|fica|sai|[ée])\s+(?:a\s+entrega|o\s+frete)/,
      /quanto\s+tempo\s+(?:demora|leva)\s+(?:a\s+)?(?:entrega|pra\s+entregar)/,
    ],
    requires: ["DELIVERY_COVERAGE", "DELIVERY_NO_COVERAGE"],
  },
});
