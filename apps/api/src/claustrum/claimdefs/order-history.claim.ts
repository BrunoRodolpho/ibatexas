/**
 * ORDER_HISTORY — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S5).
 *
 * THIS is the single editable artifact for the ORDER_HISTORY claim type. It UNIONS
 * what was previously scattered across four files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[ORDER_HISTORY]      (~44 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[ORDER_HISTORY] (~9 lines)
 *   - `claim-definition-registry.ts` TRIAD_SCOPED_TYPES membership
 *   - `required-claim-decomposer.ts` REQUIRED_CLAIM_CLOSURE row + the pt-BR markers
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./order-history.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ── WHY THE HISTORIES MIGRATE AS A PAIR, AND WHAT MADE THEM NEXT ────────────────
 *
 * R2-S4 adopted RESERVATION_STATUS as the FIRST owner-scoped type and proved the
 * ownership axis rides the PUBLISHED contract with no second widening (`toRegistrySpec`
 * passes `requiredEvidence` rows BY REFERENCE, so `ownershipPolicy` cannot be dropped).
 * That leaves SIX owner-scoped `perResourceKey` types; the two HISTORIES are the next
 * pair because they are structurally IDENTICAL to each other and to the row R2-S4 already
 * proved, on every facet the compiler models:
 *
 *   - ONE `must_read_this_turn` required-evidence row at floor `structured`, provenance
 *     `preserve`, `ownershipPolicy: "required"` — the RESERVATION_STATUS shape exactly.
 *     (PAYMENT_STATUS, still unmigrated, carries TWO falsifiers at the raised
 *     `first_party_verified` / `first_party_only` money tier.)
 *   - ONE declared-but-deliberately-unread W6 falsifier (see its note below).
 *   - `answer-anyway` (BKL-270), the posture RESERVATION_STATUS also carries.
 *     CART_CONTENTS remains the registry's ONLY `answer-with-abstention` row.
 *   - A SELF-ONLY closure row that NO OTHER SPAN references — so this source contributes
 *     exactly ONE closure row and nothing is left hand-written beside a generated one.
 *     (ORDER_FULFILLMENT_STAGE is required by PICKUP_Q as well as ORDER_STATUS_Q, so its
 *     second row would have to stay hand-written; that is still what defers it.)
 *   - NO presence-complement partner. CART_CONTENTS / CART_EMPTY SHARE one closure row,
 *     the shape R2-S1 excluded for STORE_INFO and R2-S4 for the cart pair.
 *   - A single-C6-field render off a DETERMINISTICALLY PRE-COMPOSED scalar — the same
 *     BKL-185 serialized-scalar idiom RESERVATION_STATUS's `statusLine` uses (and which
 *     this type originated: see the C6 note below).
 *
 * ── THE ONE FACET THAT IS NOT A MARKER FACT: THE SINGULAR-SIBLING SPLICE ────────
 *
 * The histories are the pair R2-S4's own header named as the reason it did not pick
 * them: each one's classifier arm SPLICES its singular sibling span out of the
 * ACCUMULATED class list — `ORDER_HISTORY_Q` firing removes an already-pushed
 * `ORDER_STATUS_Q` (and `PAYMENT_HISTORY_Q` removes `PAYMENT_STATUS_Q`). That suppression
 * is a SEQUENCING fact about `classifyRequestSpans` — it reads and mutates an array this
 * source knows nothing about, and it names a span class that is NOT part of this def's
 * contribution — so it stays HAND-WRITTEN at the classifier, exactly as every span GUARD
 * conjunction has since R2-S1. It is NOT entangled with the generated closure row:
 * measured, the generated contribution is `spanClass` + `requires` + `markers`, and the
 * splice reads the hand-written `ORDER_STATUS_Q` row's key. Both halves compose without
 * either constraining the other.
 *
 * WHAT THE SPLICE IS FOR (moved verbatim from the classifier): a history ask is NOT a
 * single-subject status ask, and leaving `ORDER_STATUS_Q` in place would force the
 * >=2-owned CLARIFY that the list-shaped type exists to REPLACE (the FE-D03 defect). A
 * singular "cade meu pedido" carries no history marker, so the singular span is untouched
 * (both directions pinned in the tests). "meus pedidos" DOES trip the order phrasing net
 * above it, which is why the suppression — not mere over-inclusion — is what routes it
 * here.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS
 * — an owner ruling, not a projection), the singular-sibling SPLICE above, classify-only
 * eligibility (`classify-only-reads.ts`), the read binding (`claim-registry.ts`
 * `deriveBoundValue` + `turn-reads.ts` `composeOrderHistorySummary`), the owner-scope
 * prefix list and `OWNER_SCOPED_BASE_TO_RESOURCE_KIND`
 * (`ibatexas-claims-kernel-deps.ts`), the P2 pair table and the planner personas.
 *
 * KNOWN PRE-EXISTING RESIDUAL, deliberately NOT changed here (a standing observation,
 * not a facet this slice moves): unlike the cart / reservation / order-status spans, the
 * history spans carry NO `!mutationImperative` guard, and ORDER_HISTORY is
 * classify-only-eligible. Measured at HEAD and after this adoption alike,
 * `classifyRequestSpans("cancela meus pedidos")` fires `ORDER_HISTORY_Q` — the BKL-201 /
 * BKL-206 / BKL-217 read-vs-mutation shape recurring on a span those tickets did not
 * cover. Adding the guard would be a BEHAVIOUR change outside an adoption slice's remit
 * (and the classifier is where it would go, not this source, since a guard is not a
 * facet). Recorded for the backlog.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// FE-D03 slice C — ORDER_HISTORY: the owner-scoped list read ("meu histórico de
// pedidos"). Structurally the CART_CONTENTS idiom (owner-scoped, must_read_this_turn,
// perResourceKey by the authenticated customerId), but its C6 proposition is a
// DETERMINISTICALLY PRE-COMPOSED bounded most-recent-N summary scalar
// (historySummaryText, "Pedido #1042 (entregue, R$89,00), … — mostrando os N mais
// recentes") derived from order listByCustomer (owner-scoped).
export const ORDER_HISTORY_SOURCE = definePerResourceClaim({
  type: "ORDER_HISTORY",
  version: 1,
  kind: "read_claim",
  // An owner-scoped live read: INV-4 REQUIRES it to appear in some
  // REQUIRED_CLAIM_CLOSURE row, which the `decomposition` block below supplies (the
  // ORDER_HISTORY_Q row). Declared HERE rather than inferred from `TRIAD_SCOPED_TYPES`
  // membership, so boot no longer depends on two sources agreeing.
  triadScoped: true,
  customerScoped: true,
  minSourceIntegrity: "structured",

  // The repo-local widening (R2-S2). The keys below stay BARE BASES — the runtime
  // suffixes them. NOTE what the subject IS for this type: the AUTHENTICATED customerId,
  // not a resource id (there is exactly ONE history per customer), so the investigator's
  // ledger key is `order_history:{customerId}`. That is what makes the two-distinct-
  // customers axis the discriminating one at the turn seam, where RESERVATION_STATUS's
  // was two-reservations-one-owner.
  perResourceKey: true,

  requiredEvidence: [
    {
      key: "order_history",
      // Ownership required via the order service's owner-scoped listByCustomer.
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // W6 — the `order_history_changed` falsifier is DECLARED (so ORDER_HISTORY escapes the
  // W6 UNKNOWN-only cap and can VALIDATE) but DELIBERATELY UNREAD — the CART_CONTENTS
  // `cart_cleared` disposition: the summary is a must_read_this_turn SNAPSHOT that
  // already reflects each order's current status, so a same-read "changed" signal is
  // tautological AND inert (an always-absent key never fires; demote-only safety holds).
  falsifierComplete: true,
  falsifiers: [
    {
      key: "order_history_changed",
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered summary to the read's PRE-COMPOSED `historySummaryText`.
  // THIS type is where the serialized-scalar idiom originated (BKL-185 cites it as the
  // ORDER_HISTORY idiom when applying it to RESERVATION_STATUS's `statusLine`): a
  // list-shaped read of N orders renders as ONE C6-bound string, because the linked
  // kernel's mint step (SDD §5 C6 / the published `runClaimsKernel` "F2" narrowing)
  // reconstructs the CanonicalClaim's value carrying ONLY the C6-`valueBinding.path`-proven
  // slice and drops every sibling field of the read as unvalidated content. Composed
  // DETERMINISTICALLY in the read (turn-reads.ts composeOrderHistorySummary — no clock,
  // no model), bounded to the most recent N. Ledger-sourced, never model-authored.
  // INV-7 is a COMPILE error here: the key is typed as the literal union of this def's
  // own requiredEvidence keys, and it is suffixed by the SAME `:{subject}` as its
  // requiredEvidence member at select time, so it stays a member of that set and the
  // kernel's C6 structural guard never throws.
  valueBinding: { key: "order_history", path: ["historySummaryText"] },

  // FE-D03 slice C — the ORDER_HISTORY validated template. ONE proposition slot
  // (self-type), bound 1:1 to the C6 valueBinding FIELD. NOT multi-field: a second
  // proposition slot reading a sibling field of the read would ALWAYS be UNFILLABLE
  // post-mint (see the C6 note above), aborting the whole template to UNKNOWN (Inv 6 is
  // all-or-nothing per template) — so this template, like every other Triad type,
  // renders exactly the one C6-bound field. The value is a bounded most-recent-N pt-BR
  // summary, never an enum, never model-authored.
  render: {
    validated: [lit("Seu histórico de pedidos: "), prop("historySummaryText"), lit(".")],
  },

  // The §O#15 decomposition contribution.
  //
  // FE-D03 slice C — a history/list question requires ONLY its own list-shaped claim.
  // Like CART_CONTENTS_Q, this row is required ONLY by its own span (no unrelated span
  // force-requires it), so it is ALSO what auto-enrols ORDER_HISTORY into the
  // claim-planner's RELEVANCE_GOVERNED_TYPES (ibatexas-claim-planner.ts BKL-110) via the
  // closure-value union — an over-proposed history claim is DEMOTED on a turn whose
  // history span did not fire, yet KEPT when it did.
  //
  // THE MARKERS. These are the THREE top-level arms of the single pre-migration
  // alternation, IN ORDER, so `markers.map((m) => m.source).join("|")` reproduces that
  // literal exactly — a `.some()` over the arms and a `.test()` on the alternation are
  // the same predicate (∃ position ∃ arm). Pinned by
  // `__SPAN_NET_SOURCES_FOR_TEST.orderHistory`, and each arm pinned INDIVIDUALLY as well
  // (arm 3 contains top-level-looking `|`s inside its own group, so the joined string
  // alone cannot witness where the arm boundary is — the R2-S4 `reservationStatus` note).
  //
  // ARM 1 / ARM 2 are the SAME two words in BOTH ORDERS, bounded by a
  // no-sentence-boundary proximity window (`[^.!?]{0,25}`) so the pair must co-occur
  // inside one sentence — "histórico de pedidos" and "pedidos no meu histórico" both
  // fire, while a "histórico" in one sentence and a "pedido" in the next do not. Both
  // spell the stem `hist[óo]rico` as a CHARACTER CLASS covering the accented AND
  // unaccented form: this is the BKL-205/BKL-270/BKL-271 accent lesson (an accented vowel
  // sits exactly where the plain one would, so an ASCII-only stem has an EMPTY
  // true-positive set on the real phrasing and no false-positive sweep reveals it), and
  // both spellings are asserted individually by test for that reason.
  //
  // THE REVERSED ARM 2 IS THIS TYPE'S ONLY STRUCTURAL DIFFERENCE FROM ITS PAYMENT TWIN,
  // which has no such arm and instead folds a second noun into arm 1's group — so ORDER
  // has THREE arms and PAYMENT has TWO. The asymmetry is real and pre-existing, and
  // byte-identity is exactly what pins it: an "equivalent" rewrite that made the pair
  // symmetric would change one net or the other.
  //
  // ARM 3 is the possessive/superlative PLURAL form ("meus pedidos", "todos os meus
  // pedidos", "últimos pedidos") with `[úu]ltimos` carrying the same accent-class
  // treatment. Anchored on the LEFT (`(?<![a-z])`) so the determiner starts at a word
  // boundary. It is the arm that makes the SPLICE necessary rather than optional:
  // "meus pedidos" trips the order-phrasing net upstream, so without the suppression the
  // turn would carry BOTH the history span and the singular ORDER_STATUS_Q.
  decomposition: {
    spanClass: "ORDER_HISTORY_Q",
    markers: [
      /hist[óo]rico[^.!?]{0,25}pedido/,
      /pedido[^.!?]{0,25}hist[óo]rico/,
      /(?<![a-z])(meus|todos os meus|[úu]ltimos)\s+pedidos/,
    ],
    requires: ["ORDER_HISTORY"],
  },
});
