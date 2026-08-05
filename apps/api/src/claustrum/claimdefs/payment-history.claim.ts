/**
 * PAYMENT_HISTORY — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S5).
 *
 * THIS is the single editable artifact for the PAYMENT_HISTORY claim type. It UNIONS
 * what was previously scattered across four files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[PAYMENT_HISTORY]      (~29 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[PAYMENT_HISTORY] (~9 lines)
 *   - `claim-definition-registry.ts` TRIAD_SCOPED_TYPES membership
 *   - `required-claim-decomposer.ts` REQUIRED_CLAIM_CLOSURE row + the pt-BR markers
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./payment-history.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ── THE ORDER_HISTORY SHAPE, AND THE TWO PLACES IT DIFFERS ──────────────────────
 *
 * See `./order-history.claim.ts` for why the histories migrate as a pair, and for the
 * SINGULAR-SIBLING SPLICE finding that applies identically to this type (here
 * `PAYMENT_HISTORY_Q` firing removes an already-pushed `PAYMENT_STATUS_Q`): a SEQUENCING
 * fact about `classifyRequestSpans`, not a marker fact, so it stays HAND-WRITTEN at the
 * classifier exactly as every span GUARD conjunction has since R2-S1.
 *
 * Every facet the compiler models is IDENTICAL to its order twin — one
 * `must_read_this_turn` owner-scoped evidence row at floor `structured` / provenance
 * `preserve`, one declared-but-unread W6 falsifier, `answer-anyway`, a self-only closure
 * row, no presence-complement partner, a single-C6-field render off a pre-composed
 * scalar. The two REAL differences are worth naming because byte-identity pins both:
 *
 *   1. THE MARKER ARM COUNT. This net has TWO top-level arms where the order net has
 *      THREE: it has NO reversed "pagamento … histórico" arm, and instead folds a second
 *      noun (`pagar`) into arm 1's group. Not a simplification to tidy — the nets are
 *      asymmetric at HEAD and an "equivalent" rewrite that made them symmetric would
 *      change one of them.
 *   2. THE OWNERSHIP JOIN. Order history is owner-scoped by the order service's own
 *      `listByCustomer`; payment history is owner-scoped via the
 *      Payment→OrderProjection.customerId JOIN (the SDD §N P0 payment-IDOR fix). Both
 *      surface here as the same single `ownershipPolicy: "required"` row — the join lives
 *      in the READ, not in this spec — which is precisely why the turn-seam proof for
 *      this type has to drive the real read rather than assert the spec shape.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS
 * — an owner ruling, not a projection), the singular-sibling SPLICE, classify-only
 * eligibility (`classify-only-reads.ts`), the read binding (`claim-registry.ts`
 * `deriveBoundValue` + `turn-reads.ts` `composePaymentHistorySummary`), the owner-scope
 * prefix list and `OWNER_SCOPED_BASE_TO_RESOURCE_KIND`
 * (`ibatexas-claims-kernel-deps.ts`), the P2 pair table and the planner personas.
 *
 * The NO-`!mutationImperative`-GUARD residual recorded in `./order-history.claim.ts`
 * applied to this span identically (measured: `classifyRequestSpans("cancela meus
 * pagamentos")` fired `PAYMENT_HISTORY_Q`), and F-8 CLOSED both together at the
 * classifier. The twins needed the same guard for the same reason and the measurement
 * came out symmetric despite the arm-count asymmetry above: across a 6857-utterance
 * harvest, exactly ONE utterance leaves each span — "cancela meus pagamentos" here,
 * "cancela meus pedidos" there. The reversed arm the order net has and this one lacks
 * turns out not to matter to the guard, because both nets' mutation-carrying population
 * is reached through their shared possessive-plural arm.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// FE-D03 slice C — PAYMENT_HISTORY: the owner-scoped payment-list read ("meus últimos
// pagamentos"). The exact ORDER_HISTORY shape over payment listByCustomer (owner-scoped
// via the Payment→OrderProjection.customerId join; includes terminal/refunded rows —
// it is billing HISTORY).
export const PAYMENT_HISTORY_SOURCE = definePerResourceClaim({
  type: "PAYMENT_HISTORY",
  version: 1,
  kind: "read_claim",
  // An owner-scoped live read: INV-4 REQUIRES it to appear in some
  // REQUIRED_CLAIM_CLOSURE row, which the `decomposition` block below supplies (the
  // PAYMENT_HISTORY_Q row). Declared HERE rather than inferred from `TRIAD_SCOPED_TYPES`
  // membership, so boot no longer depends on two sources agreeing.
  triadScoped: true,
  customerScoped: true,
  minSourceIntegrity: "structured",

  // The repo-local widening (R2-S2). The keys below stay BARE BASES — the runtime
  // suffixes them. As with the order twin the subject is the AUTHENTICATED customerId
  // (ONE history per customer), so the investigator's ledger key is
  // `payment_history:{customerId}`.
  perResourceKey: true,

  requiredEvidence: [
    {
      key: "payment_history",
      // Ownership required via the Payment→OrderProjection.customerId join.
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // W6 — `payment_history_changed` is likewise DECLARED-but-UNREAD: must_read_this_turn
  // re-reads each payment's current status (incl. refunded/disputed — the same facts
  // BKL-006's per-order refund/chargeback probes surface), so the summary already
  // reflects them and a separate falsifier would demote a snapshot that is already
  // current — no independent cross-read contradiction (re-verified: the refund/chargeback
  // probes are per-ORDER and this is a per-CUSTOMER snapshot; wiring them here would be
  // tautological). Declared-unread, mirroring cart_cleared.
  falsifierComplete: true,
  falsifiers: [
    {
      key: "payment_history_changed",
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered summary to the read's PRE-COMPOSED `historySummaryText`
  // (turn-reads.ts composePaymentHistorySummary — deterministic, no clock, no model;
  // money, method and a status enum, bounded to the most recent N). The
  // single-C6-field/serialized-scalar rationale is the order twin's verbatim; INV-7 is a
  // COMPILE error here for the same reason (the key is typed as the literal union of this
  // def's own requiredEvidence keys and is suffixed in lockstep at select time).
  valueBinding: { key: "payment_history", path: ["historySummaryText"] },

  // FE-D03 slice C — the PAYMENT_HISTORY validated template. ONE proposition slot
  // (self-type), bound 1:1 to the C6 valueBinding FIELD. See the order twin for why a
  // second sibling-field slot would be structurally UNFILLABLE post-mint.
  render: {
    validated: [lit("Seu histórico de pagamentos: "), prop("historySummaryText"), lit(".")],
  },

  // The §O#15 decomposition contribution.
  //
  // FE-D03 slice C — a history/list question requires ONLY its own list-shaped claim.
  // Like CART_CONTENTS_Q, this row is required ONLY by its own span (no unrelated span
  // force-requires it), so it is ALSO what auto-enrols PAYMENT_HISTORY into the
  // claim-planner's RELEVANCE_GOVERNED_TYPES (ibatexas-claim-planner.ts BKL-110) via the
  // closure-value union — an over-proposed history claim is DEMOTED on a turn whose
  // history span did not fire, yet KEPT when it did.
  //
  // THE MARKERS. These are the TWO top-level arms of the single pre-migration
  // alternation, IN ORDER, so `markers.map((m) => m.source).join("|")` reproduces that
  // literal exactly — a `.some()` over the arms and a `.test()` on the alternation are
  // the same predicate (∃ position ∃ arm). Pinned by
  // `__SPAN_NET_SOURCES_FOR_TEST.paymentHistory`, and each arm pinned INDIVIDUALLY as
  // well (both arms contain top-level-looking `|`s inside their own groups, so the joined
  // string alone cannot witness where the arm boundary is — HERE that caveat is stronger
  // than on the order twin, because with only two arms and internal `|`s in BOTH, the
  // join is genuinely ambiguous about the split point).
  //
  // ARM 1 pairs the `hist[óo]rico` stem with EITHER noun (`pagamento` / the infinitive
  // `pagar`) inside a no-sentence-boundary proximity window (`[^.!?]{0,25}`), so the pair
  // must co-occur inside one sentence. The stem is a CHARACTER CLASS covering the
  // accented AND unaccented spelling — the BKL-205/BKL-270/BKL-271 accent lesson (an
  // ASCII-only stem has an EMPTY true-positive set on the real phrasing and no
  // false-positive sweep reveals it); both spellings are asserted individually by test.
  // There is NO reversed "pagamento … histórico" arm, which is the order twin's arm 2 —
  // see the header.
  //
  // ARM 2 is the possessive/superlative PLURAL form ("meus pagamentos", "todos os meus
  // pagamentos", "últimos pagamentos") with `[úu]ltimos` carrying the same accent-class
  // treatment, anchored on the LEFT (`(?<![a-z])`) so the determiner starts at a word
  // boundary. It is the arm that makes the SPLICE necessary rather than optional:
  // "meus pagamentos" trips the payment-phrasing net upstream, so without the suppression
  // the turn would carry BOTH the history span and the singular PAYMENT_STATUS_Q.
  decomposition: {
    spanClass: "PAYMENT_HISTORY_Q",
    markers: [
      /hist[óo]rico[^.!?]{0,25}(pagamento|pagar)/,
      /(?<![a-z])(meus|todos os meus|[úu]ltimos)\s+pagamentos/,
    ],
    requires: ["PAYMENT_HISTORY"],
  },
});
