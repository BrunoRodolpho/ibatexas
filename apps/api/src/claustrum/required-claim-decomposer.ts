// required-claim-decomposer.ts — the REQUIRED-CLAIM DECOMPOSER (SDD §O#15; Plan 1
// Phase 3 round-2 addendum). A DETERMINISTIC, PLANNER-INDEPENDENT,
// CONSERVATIVE-OVER-DECOMPOSING stage that sits UPSTREAM of the planner: given the
// intent / span-classes of the request, it declares the MANDATORY required-claim-
// type set the turn MUST resolve. The downstream completeness check (P4) then
// quantifies over THIS required set — NOT the planner's chosen candidates — so a
// turn cannot render literal-true-but-INCOMPLETE (omitting a companion claim the
// question logically required).
//
// WHY upstream + planner-independent (SDD §O#15): if completeness quantified only
// over the candidates the (probabilistic) planner CHOSE, the planner could satisfy
// completeness by simply not proposing the awkward companion (a "render the easy
// half" hole). By fixing the required set from a DECLARED closure table keyed by
// the request's span-class — before and independent of what the planner proposes —
// the required companion can never be silently dropped: it is either VALIDATED or
// the turn DEGRADES (UNKNOWN/ESCALATE/CLARIFY), never literal-true-but-partial.
//
// CONSERVATIVE-OVER-DECOMPOSING: when a span matches multiple classes (or its
// class is uncertain), the required set is the UNION — we over-include companions
// (stricter completeness), never under-include. Adding a required claim can only
// DEGRADE a turn (demote-only), never falsely promote it.
//
// SCOPE (SDD §Q scope guard): the Trustworthiness-Triad slice (STORE_OPEN_NOW,
// ORDER_FULFILLMENT_STAGE, PAYMENT_STATUS). The full closure table over the 37-row
// registry is the deferred follow-on; this proves the MACHINERY + the Triad rows.
//
// PURE & self-contained: no clock / RNG / IO; no model import; no kernel-downstream
// import beyond the `RegistryClaimType` it quantifies over.

import type { ClaimVerdict } from "@adjudicate/core";
import type { PairingRelation } from "@ibatexas/catalog";
import {
  isRegistryClaimType,
  type RegistryClaimType,
} from "./claim-registry.js";
// inv.18 v2 — these closure rows (span class + required companions) AND their pt-BR span
// markers are GENERATED from their ClaimDefinition sources by the claimdef-compiler
// (./claimdefs/*.generated.ts — DO NOT EDIT). The previously-handwritten closure entries
// + marker regexes collapse into these splices. What the compiler does NOT model is a
// span GUARD: STORE_INFO_Q's `notResourceScoped && notSelfScopedAddress &&
// !mutationImperative` conjunction (the middle term is F-31's half of the
// address-change fix) stays hand-written below, wrapping the generated markers — as does
// MENU_ITEM_CONTENTS_Q's THREE-conjunct guard (`notOrderScoped && !mutationImperative &&
// !isMenuOverview`), whose third term is what keeps a whole-menu ask disjoint from the
// per-item contents span.
import { CART_CONTENTS_CLOSURE } from "./claimdefs/cart-contents.generated.js";
import { COUPON_VALID_CLOSURE } from "./claimdefs/coupon-valid.generated.js";
import { DELIVERY_COVERAGE_CLOSURE } from "./claimdefs/delivery-coverage.generated.js";
import { MENU_DIETARY_CLOSURE } from "./claimdefs/menu-dietary.generated.js";
import { MENU_ITEM_CONTENTS_CLOSURE } from "./claimdefs/menu-item-contents.generated.js";
import { MENU_ITEM_PRICE_CLOSURE } from "./claimdefs/menu-item-price.generated.js";
import { MENU_OVERVIEW_CLOSURE } from "./claimdefs/menu-overview.generated.js";
import { MENU_PAIRINGS_CLOSURE } from "./claimdefs/menu-pairings.generated.js";
import { ORDER_FULFILLMENT_STAGE_CLOSURE } from "./claimdefs/order-fulfillment-stage.generated.js";
import { ORDER_HISTORY_CLOSURE } from "./claimdefs/order-history.generated.js";
import { PAYMENT_HISTORY_CLOSURE } from "./claimdefs/payment-history.generated.js";
import { PAYMENT_STATUS_CLOSURE } from "./claimdefs/payment-status.generated.js";
import { RESERVATION_STATUS_CLOSURE } from "./claimdefs/reservation-status.generated.js";
import { STORE_HOURS_FOR_DATE_CLOSURE } from "./claimdefs/store-hours-for-date.generated.js";
import { STORE_INFO_CLOSURE } from "./claimdefs/store-info.generated.js";
import { STORE_OPEN_NOW_CLOSURE } from "./claimdefs/store-open-now.generated.js";
// LE2-019 — the PURE coupon-code extractor (no IO; see promotion-validity.ts's
// header for why it lives there and not in the resolver).
import { detectCouponCodeInText } from "./promotion-validity.js";

/**
 * A SPAN-CLASS — the coarse, CLOSED category a request span falls into (SDD §O#15;
 * §O#8 the span-segmenter is the bounded probabilistic INPUT, this table is the
 * deterministic net over it). Closed by construction: an unrecognized class string
 * is NOT in the table → it maps to the EMPTY required set (no companion forced),
 * while the planner's own §O#9/P4 safety+CLARIFY nets handle the unrecognized span
 * (this decomposer never SUPPRESSES — it only ADDS required companions).
 *
 * Triad scope:
 *   - `STORE_OPEN_NOW_Q` — "estão abertos?" / "que horas fecham?" → STORE_OPEN_NOW.
 *   - `STORE_HOURS_FOR_DATE_Q` — a DAY-SPECIFIC hours question ("qual o horário de
 *     domingo?", "vocês abrem amanhã no feriado?") → STORE_HOURS_FOR_DATE (BKL-138 /
 *     SCN-002/003). Fired ONLY when a DATE ANCHOR (a named weekday / "amanhã" /
 *     "feriado") co-occurs with schedule phrasing, so an ordinary "que horas
 *     funciona?" (no date) stays STORE_OPEN_NOW_Q. DEMOTE-ONLY safe: this only ADDS
 *     the date-hours companion (the today STORE_HOURS/STORE_OPEN_NOW answers are
 *     unaffected).
 *   - `ORDER_STATUS_Q`   — "cadê meu pedido?" → ORDER_FULFILLMENT_STAGE.
 *   - `PAYMENT_STATUS_Q` — "meu pagamento foi aprovado?" → PAYMENT_STATUS.
 *   - `RESERVATION_STATUS_Q` — "qual minha reserva?" / "minha mesa está confirmada?"
 *     → RESERVATION_STATUS (FE-T17).
 *   - `PICKUP_Q`         — a PICKUP / "posso retirar agora?" question logically
 *     requires BOTH the store-open companion AND the order stage (you can only
 *     retrieve a ready order from an OPEN store) → {STORE_OPEN_NOW,
 *     ORDER_FULFILLMENT_STAGE}. This is the §O#15 worked example: a pickup/hours
 *     question's required set is MORE than the one type the planner might pick.
 */
export type SpanClass =
  | "STORE_OPEN_NOW_Q"
  | "STORE_HOURS_FOR_DATE_Q"
  | "MENU_ITEM_PRICE_Q"
  | "MENU_ITEM_CONTENTS_Q"
  | "MENU_OVERVIEW_Q"
  | "MENU_DIETARY_Q"
  | "STORE_INFO_Q"
  // LE2-002 / NEW-007 — a DELIVERY-COVERAGE question ("vocês entregam em Ibaté?",
  // "entregam no CEP 14815000?", "fazem entrega pra São Carlos?"). A CAPABILITY
  // question about where the STORE delivers — deliberately DISJOINT from
  // ORDER_STATUS_Q, which is about the customer's OWN in-flight delivery (the
  // BKL-204 `capabilityQuestion` guard already keeps those two apart; this span is
  // what finally gives the capability half a grounded answer instead of the prose
  // path that shipped the ungrounded "Sim, entregamos em Ibate").
  | "DELIVERY_COVERAGE_Q"
  // LE2-019 / spec Decision 18 — a COUPON-VALIDITY question ("o cupom X1234
  // vale?", "esse código BEMVINDO15 ainda funciona?"). A READ about the STORE's
  // promotions — deliberately DISJOINT from any apply/use IMPERATIVE ("aplica o
  // cupom X"), which is a mutation and must never ride a read span (the
  // BKL-201/206 discipline, and Decision 14's negative space: no apply path
  // exists for a read to be mistaken for).
  // F-13 — the SECOND example above is advertised here and, until F-13, did not
  // fire; both examples are now pinned as true positives
  // (`__tests__/required-claim-decomposer.test.ts`, the F-13 describe), so this
  // comment is a claim the suite checks rather than one it merely repeats.
  | "COUPON_VALIDITY_Q"
  // LE2-029 — a PAIRING / SUBSTITUTION question ("o que combina com brisket?",
  // "não tem costela, o que peço no lugar?"). A READ over the house's OWN
  // authored pairing graph — deliberately DISJOINT from any add/swap IMPERATIVE
  // ("põe uma farofa junto"), which is a mutation and must never ride a read span
  // (the BKL-201/206 discipline).
  | "PAIRING_Q"
  | "ORDER_STATUS_Q"
  | "PAYMENT_STATUS_Q"
  | "RESERVATION_STATUS_Q"
  | "CART_CONTENTS_Q"
  | "ORDER_HISTORY_Q"
  | "PAYMENT_HISTORY_Q"
  | "PICKUP_Q";

/**
 * The DECLARED claim-closure / required-companion table (SDD §O#15). Maps each
 * span-class to its MANDATORY required-claim-type set. The single source of truth
 * for "what must this turn resolve to be COMPLETE" — independent of the planner's
 * choices. `satisfies` pins every key to a closed SpanClass and every value to
 * in-registry types (a typo'd type would be a compile error via the assertion
 * below).
 */
export const REQUIRED_CLAIM_CLOSURE = {
  // inv.18 v2 — STORE_OPEN_NOW_Q's row is GENERATED (span class + required set).
  [STORE_OPEN_NOW_CLOSURE.spanClass]: STORE_OPEN_NOW_CLOSURE.requires,
  // inv.18 v2 / R2-S8 — STORE_HOURS_FOR_DATE_Q's row is GENERATED (span class + required
  // set); the BKL-138 rationale (a day-specific hours question requires only the date-hours
  // claim, and this row is what auto-enrols STORE_HOURS_FOR_DATE into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES via the closure-value union) moved verbatim into
  // `./claimdefs/store-hours-for-date.claim.ts`.
  //
  // WHAT STAYS HAND-WRITTEN, and where to look for it: the `dateAnchor` CONJUNCT that gates
  // this span in `classifyRequestSpans` (the generated markers are the `scheduleContext`
  // half only — see below and the source's header), and the BKL-152 STORE_OPEN_NOW_Q
  // SUPPRESSION SEAM in `decomposeRequiredClaims`, which is sequencing over the assembled
  // required set rather than any one type's contribution.
  [STORE_HOURS_FOR_DATE_CLOSURE.spanClass]: STORE_HOURS_FOR_DATE_CLOSURE.requires,
  // inv.18 v2 / R2-S7 — both STATUS rows are GENERATED (span class + required set); the
  // rationale for each requiring ONLY its own claim, and for the row being what auto-enrols
  // the type into the claim-planner's RELEVANCE_GOVERNED_TYPES, moved verbatim into
  // `./claimdefs/order-fulfillment-stage.claim.ts` / `./claimdefs/payment-status.claim.ts`.
  // The row shape is identical either way (a span class mapped to a non-empty required set) —
  // ownership lives on the SPEC's evidence rows, not here.
  //
  // WHAT STAYS HAND-WRITTEN, and where to look for it: every GUARD that gates these two spans
  // in `classifyRequestSpans` (the dual-use `entrega`/`pix` capability conjuncts, the
  // `pagamento` payment-methods conjunct, `!mutationImperative`), the BARE-"status" FALLBACK
  // that pushes both classes from outside either type's net, the FE-D03 history SPLICES that
  // remove them again, and — the one that matters for the table itself — the PICKUP_Q row
  // below, which requires ORDER_FULFILLMENT_STAGE without owning any span. See each source's
  // header for the marker/guard decomposition.
  [ORDER_FULFILLMENT_STAGE_CLOSURE.spanClass]: ORDER_FULFILLMENT_STAGE_CLOSURE.requires,
  [PAYMENT_STATUS_CLOSURE.spanClass]: PAYMENT_STATUS_CLOSURE.requires,
  // inv.18 v2 / R2-S4 — RESERVATION_STATUS_Q's row is GENERATED (span class + required
  // set); the FE-T17 rationale for requiring ONLY the reservation claim, and for this row
  // being what auto-enrols RESERVATION_STATUS into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES, moved verbatim into
  // `./claimdefs/reservation-status.claim.ts`. It is the FIRST generated row for an
  // OWNER-SCOPED type; the row shape is identical either way (a span class mapped to a
  // non-empty required set), since ownership lives on the SPEC's evidence rows, not here.
  [RESERVATION_STATUS_CLOSURE.spanClass]: RESERVATION_STATUS_CLOSURE.requires,
  // inv.18 v2 / R2-S6 — CART_CONTENTS_Q's row is GENERATED (span class + required set), and
  // it is the FIRST generated row SHARED BY TWO SOURCES: the BKL-139 rationale (the cart
  // claim, and why this row is what auto-enrols CART_CONTENTS into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES) and the BKL-163 rationale (why the row ALSO requires the
  // provable-empty complement CART_EMPTY, which reads the complementary key off the same
  // owner-scoped read) both moved verbatim into `./claimdefs/cart-contents.claim.ts` — the
  // SPAN-OWNING source, which declares the whole row including its twin. `cart-empty.claim.ts`
  // declares NO closure; its `triadScoped: true` is what makes a `requires` that stopped
  // naming it a fail-closed INV-4 boot REFUSAL rather than a silent un-enrolment. The row
  // shape is identical either way (a span class mapped to a non-empty required set).
  //
  // WHAT STAYS HERE: this row is satisfiable ONLY because the pair is registered in
  // PRESENCE_COMPLEMENT_PAIRS below — a SET-level relation between two types, not a per-type
  // facet a source can project (BKL-163 reopened; LE2-002 shipped the same shape for
  // DELIVERY without the registration and degraded every coverage turn RENDER→UNKNOWN).
  [CART_CONTENTS_CLOSURE.spanClass]: CART_CONTENTS_CLOSURE.requires,
  // inv.18 v2 / R2-S5 — both history rows are GENERATED (span class + required set); the
  // FE-D03 rationale for each requiring ONLY its own list-shaped claim, and for the row
  // being what auto-enrols the type into the claim-planner's RELEVANCE_GOVERNED_TYPES,
  // moved verbatim into `./claimdefs/order-history.claim.ts` /
  // `./claimdefs/payment-history.claim.ts`. The row shape is identical either way (a span
  // class mapped to a non-empty required set) — ownership lives on the SPEC's evidence
  // rows, not here, and the SINGULAR-SIBLING SPLICE that accompanies each of these two
  // spans is a `classifyRequestSpans` SEQUENCING fact and stays hand-written there.
  [ORDER_HISTORY_CLOSURE.spanClass]: ORDER_HISTORY_CLOSURE.requires,
  [PAYMENT_HISTORY_CLOSURE.spanClass]: PAYMENT_HISTORY_CLOSURE.requires,
  // inv.18 v2 / R2-S2 + R2-S3 — the two per-item menu rows are GENERATED (span class +
  // required set); the BKL-142 rationale for requiring ONLY its own PUBLIC claim moved
  // verbatim into `./claimdefs/menu-item-price.claim.ts` /
  // `./claimdefs/menu-item-contents.claim.ts`.
  [MENU_ITEM_PRICE_CLOSURE.spanClass]: MENU_ITEM_PRICE_CLOSURE.requires,
  [MENU_ITEM_CONTENTS_CLOSURE.spanClass]: MENU_ITEM_CONTENTS_CLOSURE.requires,
  // inv.18 v2 / R2-S9 — MENU_OVERVIEW_Q's row is GENERATED (span class + required set); the
  // BKL-142 rationale for requiring ONLY its own PUBLIC claim moved verbatim into
  // `./claimdefs/menu-overview.claim.ts`, along with the BKL-205 marker/ordering
  // decomposition.
  //
  // WHAT STAYS HAND-WRITTEN, and where to look for it: the GUARD conjunction
  // (`notOrderScoped && !mutationImperative`) in `classifyRequestSpans`, and — the one that
  // no per-type source could ever express — the BKL-205 SPECIFICITY ORDERING, where this
  // span's verdict is consumed as `!isMenuOverview` by the per-ITEM contents span BELOW it.
  // That is sequencing between two DIFFERENT types, and it is BYTE-PIN-BLIND: delete it and
  // the generated marker net is unchanged while "o que tem no brisket?" confidently renders
  // the whole catalogue.
  [MENU_OVERVIEW_CLOSURE.spanClass]: MENU_OVERVIEW_CLOSURE.requires,
  // inv.18 v2 / R2-S3 — MENU_DIETARY_Q's row is GENERATED (span class + required set);
  // the BKL-214 rationale, and the BKL-273 correction about WHY keeping this span mapped
  // is what holds an allergen-adjacent diet ask inside §O#15 completeness, moved verbatim
  // into `./claimdefs/menu-dietary.claim.ts`.
  [MENU_DIETARY_CLOSURE.spanClass]: MENU_DIETARY_CLOSURE.requires,
  // inv.18 v2 / R2-S1 — STORE_INFO_Q's row is GENERATED (span class + required set); the
  // BKL-136 rationale for requiring ONLY its own PUBLIC claim moved verbatim into
  // `./claimdefs/store-info.claim.ts`.
  [STORE_INFO_CLOSURE.spanClass]: STORE_INFO_CLOSURE.requires,
  // inv.18 v2 / R2-S9 — the THREE PRESENCE-COMPLEMENT PAIR rows are GENERATED (span class +
  // required set), each declared by its SPAN-OWNING source under R2-S6's shared-row rule:
  // `delivery-coverage.claim.ts`, `coupon-valid.claim.ts`, `menu-pairings.claim.ts`. Each
  // twin declares NO `decomposition` and so emits no closure export. The LE2-002 / LE2-019 /
  // LE2-029 rationales — why each row requires BOTH members, and why requiring both is what
  // auto-enrols the pair into the classify-only candidate set and into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES — moved verbatim into those three sources.
  //
  // THE ONE THING THAT DID *NOT* CARRY OVER FROM R2-S6, and it is worth knowing before
  // reading an INV-4 failure here. For the CART pair, INV-4 enforces the two halves'
  // agreement fail-closed, because both members are `triadScoped: true` and INV-4's forward
  // direction ("every Triad-scoped type appears in some closure value") has something to
  // fail on. All SIX members of the three pairs below are PUBLIC and `triadScoped: false`,
  // so that direction obliges none of them. MEASURED against the real validator over the
  // real registry:
  //
  //     CART_CONTENTS_Q     loses CART_EMPTY           -> DECOMPOSITION_UNREACHABLE
  //     DELIVERY_COVERAGE_Q loses DELIVERY_NO_COVERAGE -> { ok: true }
  //     COUPON_VALIDITY_Q   loses COUPON_INVALID       -> { ok: true }
  //     PAIRING_Q           loses MENU_SUBSTITUTIONS   -> { ok: true }
  //
  // So INV-4 is VACUOUS as a pair-agreement check for these three, and the state it leaves
  // unguarded is not hypothetical: `classifyOnlyRequiredTypes` IS this closure-derived
  // required set, so a row that stopped naming its twin would silently stop producing the
  // honest-NO / substitution branch on the deterministic path — the LE2-002 shape one seam
  // over. What stands in for the boot-time refusal is an EXPLICIT structural pin over
  // PRESENCE_COMPLEMENT_PAIRS x this table, in
  // `./claimdefs/__tests__/generated-drift.test.ts`. It is weaker than a fail-closed
  // invariant and is described as such.
  //
  // WHAT ELSE STAYS HERE: each pair's PRESENCE_COMPLEMENT_PAIRS registration (below) — a
  // SET-level relation between two types, not a per-type facet a source can project — and
  // every span GUARD (`!mutationImperative`, the delivery SELF-REFERENCE exclusion, the
  // coupon apply-imperative/modal discrimination, the pairing relation PRECEDENCE and
  // both-ask degrade).
  [DELIVERY_COVERAGE_CLOSURE.spanClass]: DELIVERY_COVERAGE_CLOSURE.requires,
  [COUPON_VALID_CLOSURE.spanClass]: COUPON_VALID_CLOSURE.requires,
  [MENU_PAIRINGS_CLOSURE.spanClass]: MENU_PAIRINGS_CLOSURE.requires,
  // §O#15 worked example — a pickup question requires BOTH companions.
  //
  // inv.18 v2 / R2-S7 — this row STAYS HAND-WRITTEN, and it is the first row to stay so for
  // the reason R2-S6's shared-row rule names: a source declares a closure row iff it OWNS the
  // span, and NO type owns PICKUP_Q. Its marker net (`/retir|buscar|pegar/` in
  // `classifyRequestSpans`) is its OWN, it is named after no claim type, and it requires TWO
  // types neither of which is "the pickup type" — you can only collect a ready order from an
  // OPEN store. Putting this row in either source would publish a false assertion (that a
  // pickup question IS an order-stage question, or IS an open-now question), which is the dead
  // artifact inv.18 v2 exists to prevent. Both members ARE generated types, so the reverse
  // direction of INV-4 still covers this row; what it costs is documented in
  // `./claimdefs/order-fulfillment-stage.claim.ts`'s header (the forward direction can no
  // longer catch a de-sync of the ORDER_STATUS_Q row alone, because THIS row keeps
  // ORDER_FULFILLMENT_STAGE reachable on its own).
  PICKUP_Q: ["STORE_OPEN_NOW", "ORDER_FULFILLMENT_STAGE"],
} satisfies Record<SpanClass, readonly RegistryClaimType[]>;

// Compile-time + load-time guard: every closure value must be an in-registry type.
// (Belt-and-braces over the `satisfies` above — also catches a hand-edited table.)
for (const types of Object.values(REQUIRED_CLAIM_CLOSURE)) {
  for (const t of types) {
    if (!isRegistryClaimType(t)) {
      throw new Error(
        `[required-claim-decomposer] closure table references a non-registry claim type: ${t}`,
      );
    }
  }
}

/**
 * The §O#8 SPAN-SEGMENTER (deterministic approximation; Plan 1 Phase 3 / F2). Maps
 * a raw request text to the closed {@link SpanClass} set the §O#15 decomposer
 * quantifies over, by matching CONSERVATIVE pt-BR markers. CLOSED + demote-only:
 * an unmatched text yields the EMPTY set (no companion forced — the planner's own
 * P4/§O#9 nets still run); matching multiple classes UNIONS them (over-include,
 * never under-include). The probabilistic §O#8 segmenter is the canonical input —
 * this keyword net is the deterministic stand-in for the wired Triad slice (the
 * full segmenter is the deferred follow-on). Pure: no clock/RNG/IO.
 *
 * Markers (representative — SDD §Q scope guard):
 *   - PICKUP_Q         — "retir(ar/ada)" / "buscar" / "pegar" (a pickup question
 *     requires BOTH the store-open + order-stage companions — §O#15 worked case).
 *   - STORE_OPEN_NOW_Q — "abert" / "fechad" / "que horas" / "funciona" / "horário".
 *   - PAYMENT_STATUS_Q — payment-bearing phrasing: "pagamento" / "pago" / "pix" /
 *     "cobrança" / "pagar" / "paguei" / "aprovad".
 *   - ORDER_STATUS_Q   — order/delivery phrasing: "pedido" / "entrega" / "preparo" /
 *     "saiu" / "chegou" / "cadê".
 *
 * F2 — the polysemous bare word "status". It used to map UNCONDITIONALLY to
 * ORDER_STATUS_Q, so "qual o status do meu pagamento?" MISROUTED to ORDER (the
 * order companion would resolve from the WRONG resource / or drop the payment
 * companion). The fix routes "status" by its DISCRIMINATOR: payment phrasing →
 * PAYMENT_STATUS_Q; order/delivery phrasing → ORDER_STATUS_Q; a BARE "status"
 * with NEITHER discriminator → over-include BOTH companions (conservative-over-
 * decomposing — the decomposer is a TCB member, so over-include is safe and
 * under-include is not; neither required companion is ever silently dropped).
 */
/**
 * BKL-184 — the allergen-family phrasing net (shared): the SAME pattern the
 * span classifier uses to keep allergen questions OUT of the contents/overview
 * spans (they route to the carved-out MENU_ITEM_ALLERGENS honest-UNKNOWN,
 * BKL-123/143). Exported as a predicate so the render seam can give the
 * allergen abstain its human-handoff OFFER copy without a second, drifting
 * regex. Applies the classifier's own normalization (lowercase).
 */
// Stems (alérg*/glúten/lactose/contém) + the WORD-BOUNDED common allergen nouns
// customers actually ask with ("tem amendoim?", "tem leite?" — the SCN-008 live
// phrasings): boundaries prevent substring hits (\bovo\b never fires inside
// "provolone"). Widening is demote-only-safe for the span exclusions (an
// allergen-ish ask routes AWAY from a confident contents render) and gates the
// BKL-184 offer copy.
const ALLERGEN_FAMILY_RE =
  /al[ée]rg|gl[úu]ten|lactose|cont[ée]m|\b(?:amendoim|nozes|castanhas?|camar[ãa]o|mariscos?|soja|ovos?|leite)\b/;

/** BKL-184 — does this request text carry allergen-family phrasing? Pure. */
export function isAllergenFamilyAsk(text: string): boolean {
  return ALLERGEN_FAMILY_RE.test(text.toLowerCase());
}

/**
 * BKL-270 — the NON-ALLERGEN dietary-condition vocabulary: the stems a customer
 * uses to name a condition that makes a grounded FOOD answer unsafe, which the
 * allergen net above does not carry.
 *
 * ── WHY A SECOND CONSTANT AND NOT A WIDER `ALLERGEN_FAMILY_RE` ──────────────
 *
 * This is the load-bearing decision of the ticket, so it is written down here
 * rather than in a PR nobody will find.
 *
 * `ALLERGEN_FAMILY_RE` has THREE consumers doing THREE different jobs, and only
 * two of them should widen:
 *
 *   1. `classify-only-reads.ts` — a ROUTE guard. Any match makes the WHOLE turn
 *      decline classify-only and fall to the model `propose_claim` call.
 *   2. the per-family READ guards (menu-item-resolver / pairing-resolver).
 *   3. `claims-renderer-adapter.ts` — the COPY selector for the BKL-184 abstain.
 *
 * Widening the shared constant would drag consumer 1 along, and consumer 1 is
 * the one that costs something: every diet-qualified variant of the 18
 * classify-only-eligible families would leave the deterministic dispatch for a
 * model call — including families whose ratified posture is `answer-anyway`
 * ("sou diabético, o meu pagamento foi aprovado?" is a PAYMENT_STATUS turn that
 * is simply supposed to answer). That is an extra model call and a fresh chance
 * of authored prose, for no safety gain, in the exact direction LE2-029 and
 * BKL-273 spent two tickets moving away from.
 *
 * So the nets stay separate: `ALLERGEN_FAMILY_RE` keeps the route guard
 * BYTE-IDENTICAL (zero utterance classes move — pinned by test), and
 * {@link isDietQualifiedAsk} — the UNION — feeds the posture enforcement and the
 * copy selector. `isAllergenFamilyAsk` ⊆ `isDietQualifiedAsk` holds BY
 * CONSTRUCTION below (the union literally tests the allergen net first), and is
 * asserted directly by test so a future edit cannot silently invert it.
 *
 * ── THE VOCABULARY, AND WHAT WAS REJECTED ──────────────────────────────────
 *
 * Swept (BKL-271's root-by-root method) against BOTH the LIVE Medusa catalog
 * (201 vocabulary rows — titles, handles, descriptions, variants, tags,
 * categories, option values; the static seed is NOT the catalog of record) and
 * the 751-row in-repo corpus. Every stem below: ZERO false positives. The sweep
 * is non-vacuous — the EXISTING net returns 4 real hits on the same live
 * vocabulary ("Pudim de Leite Condensado" and its handle, the Limonada Suíça and
 * Feijão Tropeiro descriptions), so the method finds hits when hits exist.
 *
 *   · `diab[ée]t`  — diabetes / diabético / diabética / diabetico. No pt-BR word
 *                    outside the diabetes family contains the substring.
 *                    THE `[ée]` CLASS IS LOAD-BEARING, and this is the BKL-271
 *                    lesson repeating itself: a bare `diabet` matches "diabetes"
 *                    but NOT "diabético" — the accented é sits exactly where the
 *                    plain e would be — so the stem's true-positive set on the
 *                    phrasing customers actually use ("sou diabético") was very
 *                    nearly EMPTY. A false-positive sweep cannot catch that; only a
 *                    true-positive test can, which is why the vocabulary test in
 *                    `dietary-posture.test.ts` asserts each spelling explicitly.
 *   · `a[çc][úu]car` — açúcar / acucar / açúcares / açucarado (the corpus mixes
 *                    accented and unaccented spellings, so both are matched).
 *   · `glic[êe]m`  — glicemia / glicêmico / hipoglicemia / hiperglicemia (one stem
 *                    covers the hypo- and hyper- forms; same accent trap as
 *                    `diab[ée]t` — "glicêmico" carries ê).
 *   · `insulin`    — insulina.
 *   · `cel[íi]a[cq]` — celíaco / celíaca / celiaquia. A gap the BKL-270 audit did
 *                    NOT name, found by comparing two tables that should agree
 *                    and do not: the catalog's own `DIETARY_RESTRICTION_MARKERS`
 *                    (packages/catalog safety-markers.ts) already carries
 *                    `celiac`, and this runtime net did not — so "sou celíaco"
 *                    bypassed every gate while "sem glúten" did not, for the
 *                    SAME medical condition. The `[cq]` class is load-bearing:
 *                    `cel[íi]ac` alone misses "celiaquia".
 *   · `intoler[âa]nci|intolerante` — WORD-FORMS, deliberately not the `intoler`
 *                    STEM. "sou intolerante a frutose" carries no other stem here,
 *                    but the stem would also match "intolerável" — a plausible
 *                    complaint word ("esse atraso é intolerável"). That is the
 *                    BKL-271 embedded-match class (`p[õo]r` inside "pork"), and
 *                    the cost of getting it wrong is abstaining on a complaint.
 *
 * REJECTED, with the measured reason, so nobody re-proposes them:
 *
 *   · a bare `sem\s` — MEASURED 8 corpus hits, 7 FALSE POSITIVES, all order notes
 *     or formatting ("sem cebola" ×3, "sem picles" ×2, "sem maionese", "cpf …,
 *     sem pontuação mesmo"). Its ONE true positive ("…que seja sem glúten?") is
 *     already caught by the `gl[úu]ten` stem above. Net: zero new true positives,
 *     seven false abstains on ordinary order notes.
 *   · `keto` — matches inside "ketchup". Same class as `p[õo]r` in "pork".
 *   · `zero` / `light` / `diet` — zero hits TODAY, but the live store already
 *     sells `Refrigerante :: Coca-Cola`; "Coca-Cola Zero" is one catalog edit
 *     away, and then `\bzero\b` would abstain every read for "quero uma coca
 *     zero". Rejected on trajectory. `diet`/`dieta` is additionally out of SCOPE:
 *     a weight-loss diet is a PREFERENCE, like vegetariano, and BKL-214 already
 *     drew the preference/restriction line.
 *   · `s[óo]dio` / `hipertens` / `colesterol` / pregnancy terms — real dietary
 *     vocabularies, but with no MEASURED leak. The bar for a later tranche is a
 *     measured leak at the turn seam (the BKL-270 audit's own method), not a
 *     brainstormed list.
 *   · `vegano` / `vegetariano` — MUST STAY OUT. They are the positive-preference
 *     tags MENU_DIETARY exists to render (BKL-214); including them would make the
 *     family abstain on its own subject and delete it.
 *
 * DISJOINT FROM THE EMERGENCY ROUTER, STILL: this is a DIET-NAMING net;
 * {@link detectMedicalEmergencyMarkers} keys on ACTIVE DISTRESS. Naming a
 * condition is not an emergency, and the BKL-143/123/184 ratification of honest
 * self-report over a handoff-for-every-question depends on those staying apart.
 */
const DIET_CONDITION_RE =
  /diab[ée]t|a[çc][úu]car|glic[êe]m|insulin|cel[íi]a[cq]|intoler[âa]nci|intolerante/;

/**
 * BKL-270 — does this request text name a dietary restriction of ANY kind
 * (allergen family OR non-allergen condition)? This is the net the registry-declared
 * `dietaryPosture` enforcement and the abstain COPY selector consume; the route
 * guard in `classify-only-reads.ts` deliberately does NOT (see above).
 *
 * A strict SUPERSET of {@link isAllergenFamilyAsk} by construction. Pure.
 */
export function isDietQualifiedAsk(text: string): boolean {
  const lower = text.toLowerCase();
  return ALLERGEN_FAMILY_RE.test(lower) || DIET_CONDITION_RE.test(lower);
}

/**
 * A SELF-REFERENCE to the customer's OWN order/payment/delivery/reservation: a
 * possessive attached to one of those NOUNS ("meu pedido", "minha entrega") or an
 * explicit order display number. Hoisted to module scope (BKL-204 authored it
 * inline) so the LE2-002 delivery-coverage net below reuses the SAME definition
 * rather than a second, drifting copy — the two nets must agree on exactly one
 * question: is this about the STORE's policy, or about THIS customer's resource?
 *
 * NOT any bare possessive ("minha região" is a coverage question, not the
 * customer's order). A bare CEP is not an order number (no `#`, no "pedido nº"),
 * so a coverage question carrying a CEP never trips the explicit-number arm. Pure.
 */
const SELF_RESOURCE_REFERENCE_RE =
  /(?<![a-z])(meu|minha|meus|minhas)\s+(pedido|pagamento|entrega|reserva)/;
const EXPLICIT_ORDER_NUMBER_RE = /(?<![a-z])pedido\s*n?[ºo°.]?\s*#?\d{2,}|#\d{2,}/;

function isSelfResourceReference(lowerText: string): boolean {
  return (
    SELF_RESOURCE_REFERENCE_RE.test(lowerText) || EXPLICIT_ORDER_NUMBER_RE.test(lowerText)
  );
}

/**
 * LE2-002 / NEW-007 — the DETERMINISTIC delivery-COVERAGE net: does this text ask
 * whether/where/at-what-cost the RESTAURANT delivers? The capability half of the
 * BKL-204 delivery/order split, given its own span so it stops falling through to
 * the lie-capable prose path (the 2026-07-20 ungrounded "Sim, entregamos em Ibate").
 *
 * FIRES on the phrasings customers actually use for coverage + fee + ETA:
 *   · "vocês entregam …" / "vocês fazem entrega" / "fazem entrega em …"
 *   · "entregam em/no/na/pra/para/até <lugar ou CEP>"
 *   · "atendem em/no/na <lugar>" (the pt-BR synonym for serving an area)
 *   · "área/região/zona de entrega", "onde vocês entregam"
 *   · the fee/ETA asks: "taxa de entrega", "valor/preço do frete", "quanto custa a
 *     entrega", "quanto tempo demora a entrega"
 *
 * DOES NOT FIRE on a SELF-REFERENCE ("cadê minha entrega?", "meu pedido saiu para
 * entrega?") — that is an ORDER_STATUS question about the customer's own in-flight
 * delivery and keeps its owner-scoped read, unchanged. This is the same guard
 * BKL-204 uses in the opposite direction, sharing ONE definition.
 *
 * Over-firing is DEMOTE-ONLY safe: the resolver never guesses, so a false positive
 * lands on the CLARIFY-for-CEP ask (or an honest UNKNOWN), never a wrong coverage
 * answer. Pure; applies the classifier's own lowercase normalization.
 */
// inv.18 v2 / R2-S9 — the MARKERS are now GENERATED from `./claimdefs/delivery-coverage.claim.ts`
// (TEN arms — the pre-migration `DELIVERY_COVERAGE_ASK_RE` was ONE flat top-level
// alternation, so the arms REJOIN to that literal character-for-character; pinned by
// `__SPAN_NET_SOURCES_FOR_TEST.deliveryCoverage`, and `markers.some((m) => m.test(t))` is
// the same predicate as `.test()` on the alternation, ∃ position ∃ arm).
//
// The GUARD is NOT generated and stays right here: `isSelfResourceReference` is what keeps
// "cadê MINHA entrega?" an owner-scoped ORDER question, and a `markers` array is
// DISJUNCTIVE — it cannot express an absence. That makes this net's byte pin GUARD-BLIND by
// construction: delete the guard line below and the pin stays green while every
// self-referential delivery question starts firing the coverage span. The guard therefore
// carries BEHAVIOURAL must-not-fire cases (`../__tests__/required-claim-decomposer.test.ts`,
// `../__tests__/delivery-coverage-claim.test.ts`).

/** LE2-002 — does this request text ask about DELIVERY COVERAGE (not the
 *  customer's own delivery)? Pure. Exported so the render seam can select the
 *  CLARIFY-for-CEP ask without a second, drifting regex (the BKL-184 idiom). */
export function isDeliveryCoverageAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (isSelfResourceReference(t)) return false;
  return DELIVERY_COVERAGE_CLOSURE.markers.some((m) => m.test(t));
}

/**
 * LE2-019 / spec Decision 18 — the DETERMINISTIC COUPON-VALIDITY net: does this
 * text ask whether a coupon / discount code WORKS? The read half of the coupon
 * vocabulary, given its own span so a validity question is answered from a
 * promotion lookup instead of the customer being told to try it and see.
 *
 * Structurally it is a CONJUNCTION — a coupon NOUN plus either validity phrasing
 * or a code-shaped token — so the merely-coupon-adjacent ("ganhei um cupom, que
 * legal") does not fire, and neither does a bare validity word.
 *
 * COUPON NOUN: "cupom/cupons/cupão", "voucher", or "código/codigo" QUALIFIED as a
 * discount code ("código de desconto", "código promocional"). A bare "código" is
 * deliberately NOT enough IN THE GENERATED NET — "qual o código do meu pedido?" is
 * an order question. F-13(a) adds the one bridge that qualification was missing: a
 * bare "código" IMMEDIATELY followed by the extracted code ("esse código BEMVINDO15
 * ainda funciona?" — the family's own advertised example, which had an empty
 * true-positive set). See {@link hasBareCodeNounNamingACode}.
 *
 * DOES NOT FIRE on an APPLY/USE IMPERATIVE ("aplica o cupom X", "usa esse código
 * no meu carrinho"): that is a MUTATION request, and answering it with a validity
 * READ would silently drop what the customer actually asked for (the SCN-046
 * failure shape). A MODAL question form ("posso usar o cupom X?", "dá pra usar o
 * BEMVINDO15?") is a VALIDITY question, not an imperative, so the modal prefix
 * DISABLES the apply guard — otherwise the most natural phrasing of the very
 * question this ticket answers would be excluded.
 *
 * Over-firing is DEMOTE-ONLY safe: the resolver never guesses, so a false positive
 * lands on the CLARIFY-for-code ask (or an honest UNKNOWN), never a wrong validity
 * answer. Pure; applies the classifier's own lowercase normalization.
 */
// The extractor lives in the PURE `promotion-validity.ts` (no IO) precisely so
// this module — which the render adapter and most of the claims layer import —
// never gains a network client just to classify a span. See that module's header.
// inv.18 v2 / R2-S9 — the coupon NOUN is now the GENERATED marker net from
// `./claimdefs/coupon-valid.claim.ts` (ONE arm — a relocation, since the pre-migration
// `COUPON_NOUN_RE` was a single lookbehind-anchored literal whose `|`s all sit inside one
// group, so no split rejoins; `markers.some((m) => m.test(t))` is literally the `.test(t)`
// it ran, and the arm is pinned byte-for-byte by
// `__SPAN_NET_SOURCES_FOR_TEST.couponNoun`).
//
// The THREE regexes below did NOT move, and that is the R2-S8 split applied to a
// conjunction whose conjuncts are all single literals: `markers` are the tokens that
// classify a request INTO a span (the coupon TOPIC), while these three are READ-VS-MUTATION
// DISCRIMINATION — an absence check a disjunctive array cannot express. So the byte pin
// above is guard-blind, and the guard carries BEHAVIOURAL pins instead.

/** Validity/usability phrasing — "vale?", "é válido?", "ainda funciona?", "tá valendo?" */
const COUPON_VALIDITY_PHRASE_RE =
  /(?<![a-z])(?:vale(?:m|ndo)?|v[áa]lid[oa]s?|validade|funciona(?:m|ndo)?|serve|ativ[oa]|expir|venceu|vencid[oa]|caduc|est[áa]\s+ok|t[áa]\s+ok|confer(?:e|ir)|checa(?:r)?)/;

/** An APPLY/USE IMPERATIVE aimed at a coupon — a MUTATION, never this read. */
const COUPON_APPLY_IMPERATIVE_RE =
  /(?<![a-z])(?:aplica(?:r|e)?|resgata(?:r)?|ativa(?:r)?|usa(?:r|e)?|coloca(?:r)?|p[õo]e|p[õo]r|adiciona(?:r)?|insere|inserir)\s+(?:o\s+|a\s+|esse\s+|este\s+|essa\s+|meu\s+|minha\s+)?(?:cupom|c[óo]digo|voucher|desconto)/;

/** A MODAL/interrogative frame that makes an apply-shaped verb a QUESTION. */
const COUPON_MODAL_QUESTION_RE =
  /(?<![a-z])(?:posso|consigo|d[áa]\s+(?:pra|para)|ser[áa]\s+que|quero\s+saber|gostaria\s+de\s+saber|como\s+(?:fa[çc]o|uso|usar))/;

/**
 * F-13(a) — a BARE `código`/`códigos`, the noun the generated marker net
 * deliberately does NOT accept. Case-insensitive because this arm is read against
 * the RAW text (see {@link hasBareCodeNounNamingACode}), not the lowercased copy.
 */
const COUPON_BARE_CODE_NOUN_RE = /(?<![a-z])c[óo]digos?(?![a-z])/i;

/** The first alphanumeric TOKEN in a string — the "next word" reader for the bridge. */
const NEXT_ALNUM_TOKEN_RE = /[A-Za-z0-9]+/;

/**
 * F-13(a) — THE BRIDGE. Does this text name a bare `código` IMMEDIATELY FOLLOWED
 * by the one extractable coupon CODE ("esse código BEMVINDO15 ainda funciona?")?
 * Pure.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `claim-registry.ts`'s `COUPON_VALIDITY_Q` doc advertises the family as fired by
 * "o cupom X1234 vale?" AND "esse código BEMVINDO15 ainda funciona?". The second
 * one had an EMPTY true-positive set: the generated coupon NOUN requires `código`
 * to be QUALIFIED ("código DE DESCONTO/promoção/promocional") because a bare
 * "código" would swallow "qual o código do meu pedido?" — an ORDER question, and
 * that exclusion is correct. Nothing bridged the gap for the phrasing the doc
 * itself uses, so the advertised utterance did not merely miss the coupon family:
 * measured on dev it classified as `[STORE_OPEN_NOW_Q]` and required
 * `STORE_OPEN_NOW` — a coupon question answered as a question about opening hours.
 *
 * ── WHY IT IS A HAND-WRITTEN GUARD AND NOT A MARKER ARM ─────────────────────
 *
 * The R2-S8/S9 split: `markers` are the tokens that classify a request INTO a span
 * and a `markers` array is DISJUNCTIVE, so adding a bare `código` arm would make
 * the DECLARED net say "qual o código do meu pedido?" is coupon-topical and leave
 * the whole discrimination to the guards. This predicate is a CONJUNCTION whose
 * second half is `detectCouponCodeInText` — a FUNCTION, which no `markers` array
 * can hold (the constraint `coupon-valid.claim.ts`'s header already records). So
 * the generated net stays BYTE-IDENTICAL (`__SPAN_NET_SOURCES_FOR_TEST.couponNoun`
 * is untouched by this change) and the bridge carries BEHAVIOURAL pins instead.
 *
 * ── THE DISCRIMINATOR IS ADJACENCY, NOT A BLACKLIST ─────────────────────────
 *
 * A `código` that belongs to something ELSE always says so BETWEEN the noun and
 * the identifier — "código DO MEU PEDIDO ABC123", "código DE RASTREIO BR123456",
 * "código DA MINHA RESERVA R1234". A coupon code is named directly: "código
 * BEMVINDO15". So the bridge requires the next alphanumeric token after the noun
 * to BE the extracted code, which needs no enumeration of foreign resource nouns
 * and cannot go stale as new ones appear. The strictness is deliberate: a false
 * NEGATIVE here leaves the pre-F-13 behaviour (the customer is asked for their
 * code), a false POSITIVE would force the coupon pair onto an ORDER turn and
 * completeness-degrade an answerable question.
 *
 * NOTE the extractor is given the RAW text: `isCodeShapedToken` accepts an
 * ALL-CAPS token with no digit ("FRETEGRATIS"), a rule that is destroyed by
 * lowercasing. See {@link isCouponValidityAsk}'s caller note.
 */
function hasBareCodeNounNamingACode(text: string): boolean {
  const code = detectCouponCodeInText(text);
  if (code === undefined) return false;
  const noun = COUPON_BARE_CODE_NOUN_RE.exec(text);
  if (noun === null) return false;
  const nextToken = NEXT_ALNUM_TOKEN_RE.exec(text.slice(noun.index + noun[0].length))?.[0];
  return nextToken !== undefined && nextToken.toUpperCase() === code.toUpperCase();
}

// ── LE2-029: the PAIRING / SUBSTITUTION ask ──────────────────────────────────
// The two nets are GENERATED (R2-S9) from `./claimdefs/menu-pairings.claim.ts` and read
// back here, so the SPAN and the READ (`pairing-resolver.ts`, which calls these exported
// predicates) stay the same judgement — the property the pre-migration co-location bought,
// preserved by a single source instead of a single file.
//
// ════════════════════════════════════════════════════════════════════════════
//  THE ONE GENERATED MARKER ARRAY WHOSE ORDER A RUNTIME BRANCH READS
// ════════════════════════════════════════════════════════════════════════════
//
// Every other adopted net is consumed ONLY as `markers.some(...)`, where order is
// irrelevant. This one is different: the same two arms are also the RELATION
// DISCRIMINATOR — `classifyPairingAsk` tests substitution FIRST and falls through to
// pairing (a PRECEDENCE, not a disjunction), and `isBothPairingAsk` needs each arm
// individually. So the source declares them in the classifier's own test order and the two
// index constants below NAME that contract instead of leaving bare `[0]`/`[1]` at the read
// sites (the `ORDER_STATUS_STRONG_ARMS` idiom, applied to a RUNTIME dependency rather than
// a test pin).
//
// The positional contract is a fact the `markers` schema does not carry, so it is guarded
// the only way it can be: each arm's source is pinned BYTE-FOR-BYTE and INDIVIDUALLY in
// `../__tests__/required-claim-decomposer.test.ts`, and the precedence carries BEHAVIOURAL
// pins ("o que vai bem no lugar da costela" must resolve `substitutes-for` — the ticket's
// own primary use case, and the case a swapped array would silently invert).
//
// Arm 0 — SUBSTITUTION phrasing ("no lugar", "em vez de", "substitui", "troco por",
// "acabou o X, e agora"). Tested FIRST: "o que vai bem no lugar da costela" carries both
// vocabularies but asks ONE question, and the customer's operative word is the one saying
// they cannot have the thing they asked for. A genuine TWO-question utterance is a
// different case and is NOT resolved by this precedence — see {@link isBothPairingAsk}.
const PAIRING_SPAN_SUBSTITUTION_ARM = 0;
// Arm 1 — PAIRING phrasing ("combina", "vai bem", "acompanha", "harmoniza", "pedir
// junto", "o que peço com").
const PAIRING_SPAN_PAIRING_ARM = 1;

/** The generated SUBSTITUTION arm (see the ordered-arm contract above). */
const SUBSTITUTION_PHRASE_RE = MENU_PAIRINGS_CLOSURE.markers[PAIRING_SPAN_SUBSTITUTION_ARM]!;

/** The generated PAIRING arm (see the ordered-arm contract above). */
const PAIRING_PHRASE_RE = MENU_PAIRINGS_CLOSURE.markers[PAIRING_SPAN_PAIRING_ARM]!;

/**
 * The interrogative clause heads this family is asked with. Counted, not
 * merely detected: the COUNT is what tells a two-question utterance from a
 * one-question one (see {@link isBothPairingAsk}).
 */
const INTERROGATIVE_HEAD_RE = /(?<![a-z])(?:o\s+que|qual|quais)/g;

/**
 * Does this utterance ask BOTH questions at once — "o que combina com a costela
 * e o que posso pôr no lugar?" Pure.
 *
 * WHY THIS IS ITS OWN PREDICATE, and not something the precedence above
 * resolves. The two questions are two different acts, and the pair backing them
 * is a PRESENCE COMPLEMENT: at most one key may ever be recorded in a turn, so
 * answering both is structurally forbidden. That leaves two candidate
 * behaviours for a both-ask, and only one of them is honest:
 *
 *   · Let the precedence pick. For a subject carrying edges of only ONE relation
 *     that happens to be harmless (the other half finds nothing and the turn
 *     degrades). For a subject carrying edges of BOTH — `costela-bovina-defumada`
 *     is exactly that, with a frozen substitute AND two pairings — it answers the
 *     substitution half CONFIDENTLY and drops the pairing half without a word.
 *     Nothing said is false, but the reply reads as a complete answer to a
 *     question that was only half heard. That is the P4 silent-drop direction.
 *   · Degrade. The read records NEITHER key, both claims resolve UNKNOWN, and
 *     the turn says so out loud.
 *
 * The second is what this predicate is for. It costs a turn that could have
 * half-answered, and buys never passing off half an answer as a whole one.
 * The span still FIRES (see {@link isPairingAsk}), so the question stays
 * accounted for by §O#15 rather than falling through to a prose path.
 */
export function isBothPairingAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (!SUBSTITUTION_PHRASE_RE.test(t) || !PAIRING_PHRASE_RE.test(t)) return false;
  // Both vocabularies firing is NECESSARY and NOT SUFFICIENT. "o que vai bem no
  // lugar da costela" carries both and is ONE question — the single ask that
  // borrows the other's words, which the precedence in `classifyPairingAsk`
  // exists to resolve. Measured, not assumed: the first cut of this predicate
  // tested only the two vocabularies and degraded that utterance to UNKNOWN,
  // which is the ticket's own primary use case answered with a shrug.
  //
  // What actually separates the two is TWO INTERROGATIVE CLAUSES. A genuine
  // both-ask states each question with its own head ("o que combina com a
  // costela e O QUE posso pôr no lugar?"); the borrowed-vocabulary single ask
  // has exactly one.
  //
  // The threshold is deliberately conservative in the ANSWERING direction. A
  // false positive here degrades a question the system could have answered — the
  // worse failure, and the one that breaks the ticket. A false negative
  // half-answers a rare unheaded two-question form ("o que combina com a costela
  // e um substituto"), which is the behaviour that already shipped everywhere
  // else and says nothing untrue. Given the choice, this errs toward answering.
  return (t.match(INTERROGATIVE_HEAD_RE) ?? []).length >= 2;
}

/**
 * Which relation is this utterance asking about, or `undefined` when neither
 * vocabulary fires? Pure.
 *
 * Exported so the span classifier and the render seam select the same branch
 * without a second, drifting regex (the BKL-184 / LE2-002 idiom). A both-ask is
 * NOT disambiguated here — the caller asks {@link isBothPairingAsk} first and
 * degrades; this function's precedence exists for the single question that
 * merely borrows the other's vocabulary ("o que vai bem no lugar da costela").
 */
export function classifyPairingAsk(text: string): PairingRelation | undefined {
  const t = text.toLowerCase();
  if (SUBSTITUTION_PHRASE_RE.test(t)) return "substitutes-for";
  if (PAIRING_PHRASE_RE.test(t)) return "pairs-with";
  return undefined;
}

/** Does this text ask a pairing/substitution question at all? Pure. */
export function isPairingAsk(text: string): boolean {
  return classifyPairingAsk(text) !== undefined;
}

/**
 * F-13(b) — does this text carry INDEPENDENT evidence of an open-now question?
 * Pure. The `STORE_OPEN_NOW_Q` gate in {@link classifyRequestSpans}.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `funciona` is a STORE_OPEN_NOW marker ("vocês funcionam?") AND the most natural
 * pt-BR coupon-validity verb ("esse cupom BEMVINDO15 ainda funciona?"). A coupon
 * question phrased that way therefore ALSO fired `STORE_OPEN_NOW_Q` and
 * force-required `STORE_OPEN_NOW` as a §O#15 companion, so an otherwise-VALIDATED
 * coupon answer was completeness-degraded to a proposition-free UNKNOWN whenever
 * the unrelated schedule read did not land. Same cross-family coupling BKL-152
 * removed for the date-anchored hours pair; this one had no suppression rule.
 *
 * ── THE RULE, AND WHY IT IS NOT "COUPON ⇒ DROP THE SCHEDULE SPAN" ───────────
 *
 * The coarse rule would silently drop the schedule half of a GENUINE two-question
 * utterance ("o cupom BEMVINDO15 vale e vocês estão abertos?") — the P4 silent-drop
 * direction, which is a worse failure than the one being fixed. What actually makes
 * the schedule reading spurious is that its ONLY evidence is a token the coupon
 * VALIDITY vocabulary also owns. So: under a coupon reading, keep the span iff some
 * matching store-open marker's own matched text is NOT itself a coupon validity
 * phrase. "abert"/"fechad"/"que horas"/"horário" never are, so every genuinely
 * schedule-bearing utterance keeps its span; "funciona" alone is.
 *
 * The overlap is DERIVED from the two nets rather than spelled as a literal
 * `funciona` here, so a future shared verb (adding "aberto" to the coupon phrases,
 * or "vale" to the store-open markers) is handled by construction instead of
 * re-opening this defect under a new token.
 *
 * ── DEMOTE-ONLY ─────────────────────────────────────────────────────────────
 *
 * This only ever REMOVES a span class, and a removed span can only REMOVE required
 * companions and classify-only eligibility. It proposes nothing, sets no verdict
 * and grants no prose authority — the third demote-only shrink in this module,
 * alongside the #8 ownership gate and the BKL-152 date-anchor suppression. And it
 * is applied where the TEXT is, so all three consumers of the decomposition (the
 * claim planner, classify-only, the renderer's completeness gate) read ONE
 * classification and cannot disagree about it (the F-12 property).
 */
function hasIndependentStoreOpenNowMarker(t: string, couponValidityAsk: boolean): boolean {
  const hits = STORE_OPEN_NOW_CLOSURE.markers.filter((m) => m.test(t));
  if (hits.length === 0) return false;
  if (!couponValidityAsk) return true;
  return hits.some((m) => !COUPON_VALIDITY_PHRASE_RE.test(m.exec(t)?.[0] ?? ""));
}

/**
 * LE2-019 — does this request text ask whether a COUPON is valid? Pure. Exported
 * so the render seam can select the CLARIFY-for-code ask without a second,
 * drifting regex (the BKL-184 / LE2-002 idiom).
 *
 * PASS THE RAW TEXT, NOT A LOWERCASED COPY. This function does its own
 * normalization for the regex conjuncts and hands the UNTOUCHED string to
 * `detectCouponCodeInText`, whose "an ALL-CAPS token is code-shaped even without a
 * digit" rule ("FRETEGRATIS") a pre-lowercased argument silently deletes. F-13
 * MEASURED that divergence live: `claims-renderer-adapter.ts` passed the raw
 * `requestText` and got `true` for "cupom FRETEGRATIS?" while
 * `classifyRequestSpans` passed its lowercased `t` and produced `spans=[]` — one
 * predicate, two answers, selected by the CALLER. The F-12 lesson applied to a
 * string argument: the two call sites now agree because there is nothing left for
 * them to disagree about.
 */
export function isCouponValidityAsk(text: string): boolean {
  const t = text.toLowerCase();
  // The TOPIC gate: the generated coupon NOUN, or — F-13(a) — the bare-`código`
  // BRIDGE that makes the family's own advertised phrasing reachable. See
  // {@link hasBareCodeNounNamingACode} for why the bridge is not a marker arm.
  if (
    !COUPON_VALID_CLOSURE.markers.some((m) => m.test(t)) &&
    !hasBareCodeNounNamingACode(text)
  ) {
    return false;
  }
  const applyShaped = COUPON_APPLY_IMPERATIVE_RE.test(t);
  const modal = COUPON_MODAL_QUESTION_RE.test(t);
  // An apply-shaped verb with NO modal frame is an IMPERATIVE — a mutation the
  // customer asked for, which must keep its own path.
  if (applyShaped && !modal) return false;
  // …but the SAME verb inside a modal frame ("posso usar o cupom X?", "dá pra usar
  // esse cupom ainda?") IS the validity question in its most natural pt-BR form:
  // "can I use it" is precisely "is it valid". Treating it as a mutation would
  // exclude the phrasing this ticket most exists to answer.
  if (applyShaped && modal) return true;
  if (COUPON_VALIDITY_PHRASE_RE.test(t)) return true;
  // No validity word, but the customer named a CODE alongside the coupon noun
  // ("cupom BEMVINDO15?") — that is a validity question in its shortest form.
  return detectCouponCodeInText(text) !== undefined;
}

/**
 * BKL-209 — the DETERMINISTIC medical-EMERGENCY / distress net (SDD §O#9 safety).
 * A customer in medical distress ("estou tendo uma reação alérgica", "não consigo
 * respirar", "minha garganta está fechando") must route to a §O#9 safety-ESCALATE
 * regardless of what the 4B flags — the old path relied on the model emitting a
 * `safetyMarkers` array (model luck) and, when it didn't, degraded to a
 * MENU_ITEM_ALLERGENS read-claim with responder-authored medical prose (a live
 * hallucinated "190"). This net is DELIBERATELY DISJOINT from the allergen-INFO
 * net: it keys on active-distress / emergency language, NOT on merely naming an
 * allergen — so "tem amendoim?" / "sou alérgico a leite, tem no brownie?" (info
 * questions) do NOT fire it and keep the BKL-184 conservative abstain+offer path.
 * Err toward escalate: a false-positive escalate is safe, a missed emergency is not.
 *
 * Distress markers (word-bounded / stemmed pt-BR): anaphylaxis; an ACTIVE allergic
 * reaction; breathing distress; throat/tongue/lip/face swelling or closing;
 * choking; fainting/passing-out; hives; and explicit help/emergency words.
 */
const MEDICAL_EMERGENCY_RE =
  /anafila|anafil[áa]tic|choque anafil|rea[çc][ãa]o al[ée]rgica|al[ée]rgic[ao] agora|passando mal|passar mal|me sinto mal|mal s[úu]bito|n[ãa]o (?:consigo|estou conseguindo|to|t[ôo]) respir|falta de ar|dificuldade (?:para|pra|de) respir|sem ar\b|garganta (?:inchan|incha|inchou|fechan|fecha|fechou|apertan|aperta)|(?:l[íi]ngua|garganta|boca|l[áa]bios?|rosto|cara|olhos?)[^.!?]{0,15}(?:inchan|incha|inchou|inchad|inchaç)|engasg|desmai|urtic[áa]ria|socorro|emerg[êe]ncia|urg[êe]ncia m[ée]dica|ambul[âa]ncia|samu\b/;

/**
 * BKL-209 — does this request text signal a medical EMERGENCY / distress? Pure.
 * When true, the planner forces a §O#9 ESCALATE (deterministic, not model-flagged)
 * and the renderer selects the emergency safe template + fires the staff surface.
 */
export function isMedicalEmergencyAsk(text: string): boolean {
  return MEDICAL_EMERGENCY_RE.test(text.toLowerCase());
}

/**
 * BKL-209 — the deterministic §O#8/§O#9 marker contribution for a medical
 * emergency. Returns the closed-taxonomy marker `"medical-emergency"` when the
 * distress net fires (which `routeSafety` escalates on — it is NOT in the
 * recognized-non-escalate set, and there is no non-escalate terminal for it),
 * else `[]`. Merged with the model's flagged markers so the ESCALATE never
 * depends on 4B luck. Pure.
 */
export function detectMedicalEmergencyMarkers(text: string): string[] {
  return isMedicalEmergencyAsk(text) ? ["medical-emergency"] : [];
}

/**
 * F-3 — does this request text carry a SAFETY MARKER, i.e. is it a turn whose
 * outcome the deterministic safety machinery already decides?
 *
 * ── WHY A COMPOSITION AND NOT A NET ─────────────────────────────────────────
 *
 * There is deliberately NO new regex here. This is the UNION of the two
 * deterministic nets the safety path itself already trusts, and nothing else:
 *
 *   · {@link isMedicalEmergencyAsk} — the BKL-209 active-distress net. It is the
 *     `detectMedicalEmergencyMarkers` contribution the planner merges into
 *     `SafetyRoutingInput.markers`, which `routeSafety` turns into the §O#9
 *     ESCALATE (ibatexas-planner.ts, `proposeClaims`), and the SAME net the render
 *     adapter reads to select `SAFE_ESCALATE_EMERGENCY_TEMPLATE`.
 *   · {@link isDietQualifiedAsk} — the BKL-270 diet net (allergen family ∪
 *     diabetes/celiac/intolerance). It is the gate the INVESTIGATOR reads to
 *     suppress a `dietaryPosture: "abstain"` read (ibatexas-investigator.ts), and
 *     the gate the render adapter reads to select the ratified BKL-184
 *     abstain-plus-handoff copy.
 *
 * A THIRD, weaker spelling of "this is a safety turn" would be a second safety
 * authority: it could fire where the enforcement does not (routing a turn into a
 * flow that then answers it normally) or — worse — fail to fire where the
 * enforcement does. Composing the two exported predicates means any correction to
 * either net travels here for free, by construction.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
 *
 * The owner ruled (2026-08-04) that a safety marker OUTRANKS alias ambiguity: an
 * utterance that is BOTH a declared-ambiguous catalog surface AND a safety turn
 * ("a costela tem amendoim?", "sou celíaco, posso comer a costela?") must reach the
 * safety machinery rather than being short-circuited into the LE2-025b catalog
 * disambiguation with zero claims. The planner's ALIAS short-circuit therefore
 * consults this predicate — and ONLY the short-circuit: canonicalization itself,
 * the parse text, and the L1 key surface are untouched.
 *
 * Pure. `false` on an empty/absent utterance, so an absent text is byte-identical
 * to today's behaviour.
 */
export function carriesSafetyMarker(text: string): boolean {
  return isMedicalEmergencyAsk(text) || isDietQualifiedAsk(text);
}

/**
 * The IMPERATIVE-MUTATION net — TRUE iff this text carries a pt-BR mutation verb.
 *
 * EXTRACTED (BKL-262 Stage 1) from {@link classifyRequestSpans}, where it has always
 * lived as a local const, with the two regexes and the OR moved verbatim to module
 * scope. Behaviour is unchanged: `classifyRequestSpans` calls this and branches on
 * the identical boolean.
 *
 * It is exported because a SECOND consumer now needs the SAME answer — the ops
 * write-twin read rescue (`ops-write-twin-rescue.ts`) must distinguish a staff
 * QUESTION that mis-parsed into a write from a staff MUTATION that the kernel
 * refused. Spelling a second mutation net there would be a second source of truth
 * for "is this an imperative", and the two would drift on the very next pt-BR
 * correction (this net has already absorbed BKL-206 / BKL-238 / BKL-271 fixes).
 * Callers may pass raw text — the lowercase is applied here and is idempotent.
 *
 * ── F-27 — WHY `mud` CARRIES A PAST-TENSE LOOKAHEAD ──────────────────────────
 *
 * `mud` was the one EDIT root whose PAST forms could not be told from its imperative
 * ones, so a genuine READ phrased in the preterite was classified as a command and
 * lost every read span in {@link classifyRequestSpans}. Measured at c9e871c4:
 * `classifyRequestSpans("meu histórico de pedidos mudou?")` → `[]` and
 * `classifyRequestSpans("meu pedido mudou?")` → `[]` (ORDER_HISTORY_Q / ORDER_STATUS_Q
 * both suppressed). The precedent for the fix shape sat one line below the whole time:
 * `fech(?!ad|ament|ou|am)` already excludes its own `ou` preterite.
 *
 * THE THREE ARMS, and why each is exactly the set of forms that CANNOT be a command:
 *
 *   · `ou` — `mudou`. 3rd-person singular preterite, and pt-BR has NO imperative,
 *     subjunctive or infinitive reading of it: the command forms are `muda` (tu/você),
 *     `mude`/`mudem` (formal), `mudar` (infinitive-as-request), none of which this arm
 *     can reach. The only mutation sense `mudou` can carry is the IMPLICATURE of a
 *     report ("meu endereço mudou" ⇒ please update it) — the identical implicature
 *     BKL-271 deliberately gave up for `cancelad*` and `fechou`. THE FILED DEFECT.
 *   · `ad` — `mudado`/`mudada`/`mudad{os,as}`. The past participle, i.e. the SAME
 *     `(?!ad)` all three ORDER-LIFECYCLE roots below already carry, for the same
 *     reason: a participle is a status REPORT ("o horário foi mudado?"), never an
 *     imperative. `mud` was simply the outlier that never got it.
 *   · `aram` — `mudaram`. The plural of the filed preterite, one paraphrase away
 *     ("vocês mudaram o cardápio?"), and equally incapable of being a command.
 *
 * REJECTED, with the reason, so nobody re-proposes them:
 *
 *   · `am` (`mudam`, `mudamos`). The `fech` sibling carries it, but only because
 *     "que horas fecham?" is the commonest hours phrasing in this domain. There is no
 *     comparable `mudam` READ — the sweep below attests ZERO — so adding it would
 *     widen the lookahead surface for no measured true positive.
 *   · `anç` (`mudança`, `mudanças`). REJECTED: BKL-271 explicitly KEPT `cancelamento`
 *     as a mutation, and "quero uma mudança no meu pedido" is that same request shape.
 *     Excluding it would be a false NEGATIVE on a real amend request — the dangerous
 *     direction this file names below.
 *   · `ei` (`mudei`). REJECTED for the same reason BKL-271 kept `cancelei`. The sweep
 *     shows the arm would buy NOTHING: of the 16 `mudei` rows, 12 already carry
 *     `cancel`/`tir` in the same utterance and so do not depend on `mud` at all, and
 *     the 4 the arm would actually flip are the bare "mudei de ideia" reason clause,
 *     which classifies to `[]` on both sides of the change. Zero gain, and it would
 *     cost the 1st-person amend frame ("mudei o endereço, é esse aqui").
 *
 * THE SWEEP (frozen 6889-utterance harvest of every pt-BR string literal and YAML
 * corpus utterance in apps/ + packages/, the #531 method): FIVE rows change, all five
 * `mudou`, and every one is SYSTEM-AUTHORED OUTPUT prose (the admin approval mappers,
 * the PIX regenerate message, an audit-redaction note fixture) that no code path ever
 * feeds to a classifier. ZERO harvested INPUT utterances change: not one of the 106
 * `mud`-stem rows that is a genuine mutation is phrased in the preterite — they are
 * `muda` / `mudar` / `mudei de ideia` without exception.
 *
 * BOTH PLANES, since this predicate is shared. CUSTOMER: a preterite read regains its
 * span. OPS: `ops-write-twin-rescue.ts` conjunct 4 stops treating a staff QUESTION
 * ("o horário de funcionamento mudou?") as a mutation, which makes the BKL-234 rescue
 * reachable for it — a preterite cannot be the "staff really tried to change the
 * hours" case that conjunct exists to protect, and that case ("muda o horário de
 * amanhã…") is untouched.
 *
 * THE ONE MOVEMENT IN THE FALSE-NEGATIVE DIRECTION, recorded rather than buried:
 * "meu endereço mudou[, atualiza por favor]" left the model path for the STORE_INFO
 * read. It joined a hole that was ALREADY seven phrasings wide at c9e871c4 —
 * `atualiz`/`corrig`/`cadastr`/`alter` were in NONE of the three literals, so
 * "atualiza meu endereço" already rode that same read before F-27. Filed as F-31.
 * **F-31 IS NOW CLOSED** (see below and the STORE_INFO_Q guard in
 * {@link classifyRequestSpans}); the change detector that pinned the degraded routing
 * has been DELETED rather than re-baselined, per its own stated exit condition.
 *
 * ── F-31 — THE RECORD-EDIT ROOTS, AND WHY THEY ARE A FOURTH LITERAL ──────────
 *
 * THE DEFECT: a customer asking to change THEIR delivery address was answered with
 * the RESTAURANT's address. `endere[çc]o` is a STORE_INFO_Q marker and STORE_INFO is
 * classify-only-eligible, so the whole turn rendered deterministically and the edit
 * request was dropped — a wrong-FAMILY render, not a mild over-inclusion.
 *
 * THE FAMILY NEEDED BOTH HALVES, and the roots alone do not close it. Six of the nine
 * pinned phrasings carry a verb and are fixed HERE; three carry NO verb at all
 * ("meu endereço mudou", "meu endereço agora é rua X", "meu novo endereço é rua X")
 * and no verb root can reach them. Those are closed by the SELF-SCOPED ADDRESS
 * conjunct on STORE_INFO_Q's guard — a 1st-person possessive on `endereço` is never
 * the store's address — which is deliberately NOT in this predicate: it is a
 * customer-plane READ discrimination with no meaning on the ops plane. Forcing the
 * verbless declaratives through `hasMutationImperative` would also be a FALSE claim
 * about the text, and it is shared with two other consumers.
 *
 * WHY A FOURTH LITERAL rather than four more alternatives in the AMEND half: the cut
 * is the same kind of pt-BR SPEECH ACT boundary the other three are. MEMBERSHIP
 * changes WHICH items are in the order; AMEND changes WHAT IS ALREADY THERE; these
 * change a RECORD — an address, a profile, a registration, a value that is simply
 * WRONG. It also keeps the other three literals BYTE-IDENTICAL, so their measured
 * S5843 scores (28 → split; the AMEND half at 23) cannot move, and the union identity
 * is the trivial one: the OR gains a disjunct, no existing arm is touched.
 *
 * PER-ROOT DECISIONS, each with its own TP/FP sweep — the bar
 * {@link hasReservationCreateImperative} set when it REJECTED `marc`/`agend` for
 * riding on someone else's evidence. Sweep = the frozen 183,325-row / 61,378-distinct
 * harvest of every string literal and YAML scalar in apps/ + packages/ (the #531/#537
 * method, widened from #537's pt-BR-filtered 6,889 to the unfiltered superset, which
 * is strictly harder).
 *
 *   · `atualiz(?!ad)` — IN. 12 attested INPUT utterances, EVERY ONE a mutation
 *     ("coca pra 5, atualiza o carrinho", "quero atualizar minhas preferências, sou
 *     vegano", "Solicito a atualização do pedido…"); ZERO attested input READ. The
 *     participle arm is the `(?!ad)` all three lifecycle roots carry, for the identical
 *     reason — "meu pedido foi atualizado?" is a status REPORT and keeps
 *     ORDER_STATUS_Q. MEASURED LIVE: the arm rescues 17 span-bearing corpus rows.
 *     `atualização` is KEPT (the BKL-271 `cancelamento` / F-27 `mudança` ruling — a
 *     request shape), and "atualiza a página" is a NON-ISSUE, measured: it classifies
 *     to `[]` on both sides, and every in-repo occurrence is system-authored output.
 *   · `corrig(?!id)` — IN. 2 attested INPUT utterances, both mutations ("sobre o
 *     pedido 12345, quero corrigir a quantidade"); the whole family is 5 rows and has
 *     NO non-mutation sense in pt-BR (the noun is `correção`, a different stem). The
 *     participle arm is the `(?!ad)` rule spelled for this stem's own participle
 *     (`corrigido`). HONEST LIMIT: `corrigid*` has ZERO corpus attestation, so unlike
 *     its three siblings this arm rescues no measured row — it is justified by grammar
 *     (a participle cannot be an imperative) plus an AUTHORED live probe pinned in the
 *     arm roll call ("meu pedido foi corrigido?" keeps ORDER_STATUS_Q). Kept rather
 *     than dropped because dropping it plants a fresh F-27 with the probe in hand.
 *   · `cadastr(?!o|ad)` — IN, and the most narrowed. `cadastro` is the NOUN for the
 *     customer's RECORD in 8 of 8 attested rows and in ZERO as a 1st-person verb, so
 *     the `o` arm follows the `fech(?!…|ament|…)` precedent (a noun naming a THING is
 *     excluded) rather than the `cancelamento` one (a noun naming a REQUEST is kept).
 *     The `ad` arm is not a judgement call: "quais sao minhas reservas cadastradas" is
 *     a LIVE read-harness fixture whose RESERVATION_STATUS_Q a bare root would have
 *     killed. TP kept: "quero cadastrar minha chave pix".
 *     KNOWN RESIDUAL, measured and named: "posso passar meu email e cpf agora pro
 *     cadastro do pix?" is a SAVE request that keeps riding PAYMENT_STATUS_Q, because
 *     the `o` arm excludes it. Its verb is `passar`, not a `cadastr` command; widening
 *     a NOUN is not the narrow instrument for it, and the defect pre-dates F-31.
 *   · `alter(?!n|ad)` — IN, and the riskiest, so it carries two arms. 9 attested INPUT
 *     utterances, EVERY ONE a mutation ("Gostaria de alterar minha reserva para 3
 *     pessoas", "por gentileza, altere a quantidade do pedido 12345"); `alteração` is
 *     KEPT for the `cancelamento` reason and is itself attested as a request
 *     ("Solicito a alteração do número de pessoas da minha reserva para 4").
 *     - `n` kills the ENTIRE `altern*` family in one character, and no pt-BR form of
 *       `alterar` has an `n` there (altera/altere/alterem/alterar/alterei/alterou/
 *       alteram/alteração — none). It is what keeps "tem alguma alternativa
 *       vegetariana?" a MENU_DIETARY read; `alternativa`/`alternativo` are attested
 *       in-repo pt-BR, though in no span-bearing row, so like `corrig(?!id)` this arm
 *       is pinned by an AUTHORED live probe rather than a rescued corpus row.
 *     - `ad` is the participle rule again, and here it is the most MEASURED of the
 *       four: 20 span-bearing rows ("Pedido pronto — não pode ser alterado").
 *     The English/SQL collision the stem invites (`ALTER TABLE`, `ALTER TYPE`) is
 *     measured and inert: every occurrence is DDL inside migration code or a CLI test,
 *     never classifier input, and the `(?<![a-z])` left guard already blocks the
 *     within-word case.
 *
 * REJECTED ARMS, so nobody re-proposes them:
 *
 *   · `ou`/`aram` on any of the four (the F-27 preterite shape). REJECTED: ZERO
 *     attested rows for `atualizou`/`alterou`/`cadastrou`/`corrigiu` and their plurals,
 *     which is exactly the ground F-27 itself rejected `am` on — an arm nothing in the
 *     sweep can witness, paid for out of a budget already measured at 23.
 *   · `ação`/`amento` on `alter`/`atualiz`. REJECTED: `alteração`/`atualização` are
 *     ATTESTED REQUESTS ("Solicito a alteração…"), so the arm would be a false
 *     NEGATIVE on a real amend — the dangerous direction, and the same call BKL-271
 *     made for `cancelamento`.
 *
 * BOTH SHARED-CONSUMER PLANES, since this predicate has three callers. Of the 72
 * span-bearing rows that change, 70 are SYSTEM-AUTHORED OUTPUT prose (renders,
 * refusals, admin labels, route summaries, tool descriptions) that no code path feeds
 * to a classifier; the 2 that are real INPUT are both mutations that were riding a
 * read. OPS (`ops-write-twin-rescue.ts` conjunct 4): the write-twin rescue becomes
 * UNAVAILABLE for a staff record-edit ("Por favor, atualize o status do pedido mais
 * recente para 'pronto'"), which is the conjunct working as designed — a genuine
 * refused mutation must surface its refusal, not be answered with today's status.
 * ZERO ops rows move in the read direction. RESPONDER (`ibatexas-responder.ts`
 * BKL-262 Stage 2): the same turns stop appending the proposition-free abstain, which
 * is the non-sequitur that guard exists to suppress.
 *
 * Pure. See the block comment inside the function for the full provenance of every
 * root and lookahead.
 */
export function hasMutationImperative(text: string): boolean {
  const t = text.toLowerCase();
  // ── THE NET IS FOUR LITERALS, AND THEY MUST STAY FOUR ───────────────────────
  //
  // DO NOT "tidy" these back into one. Every split here is a Sonar S5843
  // regex-complexity forcing move, each one MEASURED on CI rather than predicted:
  //
  //   · SPLIT 1 (original) — CART-EDIT vs ORDER-LIFECYCLE. The fused literal scored
  //     28 against the budget of 20.
  //   · SPLIT 2 (F-27) — the CART-EDIT half itself split into MEMBERSHIP and AMEND.
  //     Adding `mud`'s three-arm lookahead took that half to 23 (PR #537, the
  //     SonarCloud PR analysis). A local complexity model predicted 20 and was wrong
  //     by 3 — hence "measured on CI", and hence NOT "drop an arm to fit": the arms
  //     are behaviour, the budget is a lint, and the lint does not get to decide
  //     which pt-BR reads keep their span.
  //   · SPLIT 3 (F-31) — the RECORD-EDIT roots arrive as their OWN literal rather
  //     than as four more alternatives in the AMEND half. That half is the one
  //     already measured at 23, and the four roots carry five lookahead arms between
  //     them; putting them there would have gambled a known-tight score. As a
  //     separate literal the other three are BYTE-IDENTICAL, so their scores cannot
  //     move at all and the union identity is the trivial one — the OR gains a
  //     disjunct, no existing arm is touched.
  //
  // WHY THE SPLIT IS SEMANTICS-PRESERVING, not merely "equivalent": for a boolean
  // `.test()`, `(?<![a-z])(A|B)` matches iff `(?<![a-z])(A)` matches or
  // `(?<![a-z])(B)` matches — the left guard is a zero-width assertion at the SAME
  // position in all three literals, and the alternation is the only thing being
  // partitioned. The two halves below are the ORIGINAL 13 alternatives in their
  // ORIGINAL order, cut once at the 7|8 boundary; no root was reordered, added or
  // dropped. This is the same argument (and the same `(?<![a-z])` observation) the
  // original split recorded, applied one level down.
  //
  // WHERE THE CUT IS, and why THERE. The boundary is a pt-BR SPEECH ACT, not a
  // score: MEMBERSHIP verbs change WHICH items are in the order ("põe uma coca",
  // "tira a batata"); AMEND verbs change WHAT IS ALREADY THERE — substitute it,
  // move its quantity, or clear the lot; RECORD-EDIT verbs (F-31) change a stored
  // RECORD rather than the order — an address, a profile, a registration, a value
  // that is simply wrong. It also lands the one lookahead-bearing AMEND root next to
  // the five verbs a future pt-BR correction would most likely touch alongside it,
  // which is where a reader will go looking for it.
  //
  // PROVEN, not asserted: re-classifying the FROZEN corpus across the split gives
  // byte-identical rows and ZERO delta on `hasMutationImperative`, the span list and
  // the classify-only route (see this function's docblock for the harvest). The
  // 20-root roll call in `required-claim-decomposer.test.ts` is the standing guard:
  // it names every root in all four literals, so a root lost to a future re-split
  // reds by NAME rather than vanishing silently.
  const MUTATION_EDIT_MEMBERSHIP_ROOTS =
    /(?<![a-z])(adicion|acrescent|remov|tir|colo[cq]|p[õo]e|ponh)/;
  const MUTATION_EDIT_AMEND_ROOTS =
    /(?<![a-z])(mud(?!ou|ad|aram)|tro[cq]|limp|esvazi|aument|diminu)/;
  // F-31 — the RECORD-EDIT roots. Every lookahead arm is enumerated, with its
  // measured true/false-positive evidence, in this function's docblock.
  const MUTATION_RECORD_EDIT_ROOTS =
    /(?<![a-z])(atualiz(?!ad)|corrig(?!id)|cadastr(?!o|ad)|alter(?!n|ad))/;
  const MUTATION_LIFECYCLE_ROOTS =
    /(?<![a-z])(cancel(?!ad)|fech(?!ad|ament|ou|am)|finaliz(?!ad))/;
  return (
    MUTATION_EDIT_MEMBERSHIP_ROOTS.test(t) ||
    MUTATION_EDIT_AMEND_ROOTS.test(t) ||
    MUTATION_RECORD_EDIT_ROOTS.test(t) ||
    MUTATION_LIFECYCLE_ROOTS.test(t)
  );
}

/**
 * BKL-285 — the RESERVATION-CREATE net: TRUE iff this text is a request to BOOK a
 * table, as opposed to a question about a booking that already exists.
 *
 * ── WHY THIS CANNOT BE A ROOT IN {@link hasMutationImperative} ────────────────
 *
 * Every other customer mutation is caught by a VERB STEM that the matching READ
 * vocabulary does not contain: `cancel` is not in "meu pedido chegou?", `adicion`
 * is not in "o que tem no carrinho?". The reservation family is the ONE place
 * where that separation fails — the mutation verb and the read anchor are THE SAME
 * STEM. `reserv` is simultaneously the create verb ("reserva uma mesa") and the
 * noun the status read is anchored on ("minha reserva está confirmada?"), so
 * adding `reserv` to the shared net would suppress the very span it anchors.
 * That is exactly why BKL-217 closed cancel/modify — whose verbs (`cancel`,
 * `mud`/`tro[cq]`) ARE in the shared net — and left CREATE open: create's verb is
 * the anchor itself. Measured on dev d8e5ca60, all six create phrasings below
 * returned `["RESERVATION_STATUS_Q"]` with `hasMutationImperative` FALSE.
 *
 * The discriminator therefore cannot be the stem. It is the SHAPE: a booking
 * REQUEST names an INDEFINITE table ("uma mesa", "2 mesas", "mesa"), or uses a
 * verb form that can only be a request (the infinitive `reservar`, the imperative
 * `reserve`/`reservem`); a booking QUESTION names a DEFINITE, POSSESSED one
 * ("minha reserva", "a minha mesa", "o status da minha reserva").
 *
 * ── THE FOUR PARTS, AND WHY EACH IS SHAPED THE WAY IT IS ─────────────────────
 *
 *   1. {@link RESERVATION_BOOK_VERB_RE} — `reservar` / `reserve` / `reservem`.
 *      These forms CANNOT refer to an existing reservation: pt-BR has no reading
 *      of "reservar" that asks about a booking you already hold. The trailing
 *      guard is what keeps the READ preterites out, and it is load-bearing in
 *      both directions: `reservaram` ("vocês reservaram minha mesa?") and
 *      `reservei` are STATUS phrasings and must NOT match, and they do not —
 *      `reservar` + `am` fails the guard, and `reserv` + `ei` is in no arm.
 *      The `(?<![a-z])` left guard is the SAME one FE-T17 added for the
 *      `preserv*` family, and it is needed for the identical reason: `preservar`
 *      contains `reservar`, `preserve` contains `reserve` (both pinned).
 *   2. {@link RESERVATION_BOOK_OBJECT_RE} — the AMBIGUOUS `reserva`/`reserve`
 *      form followed by an INDEFINITE table object ("reserva uma mesa",
 *      "me reserva 2 mesas", "reserve mesa pra 4"). The determiner is the whole
 *      discriminator and it is spelled tightly on purpose: the group admits only
 *      `um`/`uma`/`umas`/a numeral, or nothing at all when `mesa` is ADJACENT.
 *      It deliberately cannot span an intervening word, because `de` is what a
 *      READ puts there — "minha reserva DE mesa está confirmada?" must keep its
 *      span, and a `[^.!?]{0,N}` window would have swallowed it.
 *   3. {@link RESERVATION_BOOK_NOUN_RE} — `fazer uma reserva`, the commonest
 *      pt-BR booking phrasing of all, where `reserva` is a NOUN and so part 2
 *      cannot see it. The verb list is CLOSED (fazer/faz/fazem/faço) rather than
 *      `faz\w*` for one measured reason: the PRETERITE is a READ. "fiz uma
 *      reserva ontem, está confirmada?" is a customer asking about a booking they
 *      already made, so `fiz`/`fez` are excluded and pinned as must-not-fire.
 *   4. {@link RESERVATION_BOOK_WANT_RE} — the volitional head governing an
 *      INDEFINITE table, for the create phrasings that never say "reservar" at
 *      all ("quero uma mesa para 4 pessoas às 20h"). Same harm, same family, one
 *      paraphrase away — leaving it out would have closed the ticket's literal
 *      utterance while the customer's next rewording still lost their booking.
 *      The indefinite determiner is REQUIRED here too, which is what keeps the
 *      read frame out: "quero saber da MINHA mesa" carries a possessive, not
 *      `uma`, and the head must GOVERN the object directly.
 *
 * ── REJECTED, with the reason, so nobody re-proposes them ────────────────────
 *
 *   · A bare TEXT-INITIAL `reserva` arm ("verb-initial position decides it").
 *     REJECTED: position does not disambiguate this word. "reserva confirmada?"
 *     and "reserva pra hoje?" open with the NOUN, and the FE-T17 anchoring test's
 *     own must-fire list contains the bare token "reserva". Requiring the OBJECT
 *     (part 2) or an unambiguous verb form (part 1) is the measured discriminator;
 *     position alone is not one.
 *   · `marc`/`agend` ("quero marcar uma mesa", "agendar uma mesa"). REJECTED for
 *     THIS ticket, and the reason is `marc`: "marca" is the everyday word for
 *     BRAND ("qual a marca da cerveja?"), so the stem needs its own TP/FP sweep
 *     rather than a free ride on this one. Out of scope, named here so it is a
 *     decision and not an oversight.
 *   · Folding these roots into {@link hasMutationImperative}. REJECTED: that
 *     predicate has a SECOND consumer (`ops-write-twin-rescue.ts`, BKL-262
 *     Stage 1), and the ops plane has no reservation-create surface at all — it
 *     would be carrying a customer-plane-only meaning into a staff-plane
 *     question/mutation decision. The narrow net below is OR'd into this
 *     function's LOCAL gate instead, which buys the identical customer-plane
 *     routing with zero ops blast radius.
 *
 * ── THE FAILURE DIRECTION IS FAIL-SAFE, AS IT IS FOR EVERY GATE HERE ─────────
 *
 * A false POSITIVE routes a reservation READ to the model path — the same mild
 * inefficiency BKL-201/206/217 accept, never a wrong render. A false NEGATIVE is
 * the registered defect: the customer's booking is silently dropped while a status
 * read answers confidently. KNOWN RESIDUAL, narrowed but not closed: an imperative
 * with NO table noun and no indefinite determiner ("reserva pra 4 às 20h") still
 * rides the read, because that string is genuinely ambiguous with the noun frame.
 *
 * Pure. Callers may pass raw text — the lowercase is applied here and is idempotent.
 */
export function hasReservationCreateImperative(text: string): boolean {
  const t = text.toLowerCase();
  return (
    RESERVATION_BOOK_VERB_RE.test(t) ||
    RESERVATION_BOOK_OBJECT_RE.test(t) ||
    RESERVATION_BOOK_NOUN_RE.test(t) ||
    RESERVATION_BOOK_WANT_RE.test(t)
  );
}

/**
 * The booking verb in a form that can ONLY request a booking: infinitive
 * `reservar`, imperative/subjunctive `reserve`/`reservem`. Ordered longest-first
 * so `reservem` is not shadowed by `reserve`. The trailing guard is spelled
 * against the REAL pt-BR alphabet (`à-ÿ` covers ç/á/ã…) — the BKL-271 lesson that
 * a bare `[a-z]` guard lets `porção` through the `por` branch.
 */
const RESERVATION_BOOK_VERB_RE = /(?<![a-z])reserv(?:ar|em|e)(?![a-zà-ÿ])/;
/** An INDEFINITE table object governed directly by `reserva`/`reserve`. */
const RESERVATION_BOOK_OBJECT_RE =
  /(?<![a-z])reserv[ae]\s+(?:(?:umas?|um|\d+)\s+)?mesas?(?![a-zà-ÿ])/;
/** `fazer uma reserva` — the noun frame. Preterites excluded (they are READS). */
const RESERVATION_BOOK_NOUN_RE =
  /(?<![a-z])f(?:azer|azem|a[çc]o|az)\s+(?:uma\s+)?reservas?(?![a-zà-ÿ])/;
/** A volitional head governing an INDEFINITE table, with no `reserv` stem at all. */
const RESERVATION_BOOK_WANT_RE =
  /(?<![a-z])(?:quero|queria|gostaria|preciso)\s+(?:de\s+)?(?:umas?|um|\d+)\s+mesas?(?![a-zà-ÿ])/;

/**
 * inv.18 v2 / R2-S7 — the ORDER_STATUS_Q net's THREE PROVENANCES, and the one index this
 * module still needs to know about them.
 *
 * The whole net — the flat strong-token literal, the BKL-221 arrival pair
 * (`ORDER_ON_THE_WAY_RE` / `ORDER_DELIVERED_RE`, previously spelled as separate literals here
 * for Sonar S5843's regex-complexity budget of 20) and the composed arrival-ETA sequence
 * (`ORDER_ETA_RE` and its four named parts) — now lives in
 * `./claimdefs/order-fulfillment-stage.claim.ts` as the generated `markers` array, together
 * with every rationale that used to sit beside these constants: the both-sides anchoring on
 * `a caminho`, the question frame on `entregue`, the four ETA parts and why the sequence is
 * composed rather than distributed, and the four REJECTED arms with their measured reasons.
 * `markers.some((m) => m.test(t))` at the use site is character-for-character the
 * `||`-disjunction these constants used to feed.
 *
 * This constant is the ARM BOUNDARY between the first provenance and the other two. It exists
 * only so the byte pins in {@link __SPAN_NET_SOURCES_FOR_TEST} can address the three groups
 * separately — the pre-migration values they assert against are three different strings, so a
 * single whole-array join could not carry the proof. The test asserts the total arm count
 * against this bound, so an arm added to the source cannot silently fall inside the wrong pin.
 */
const ORDER_STATUS_STRONG_ARMS = 5;

// ── The MENU_OVERVIEW net, split at its TOP-LEVEL alternation (Sonar S5843) ───
// Three independent ways to ask for the whole menu, one arm each. `A|B|C`
// under `.test` is true iff some alternative matches, which is what the `||` at
// the use site spells out — so the split is behaviour-preserving by
// construction, and each arm is now individually named and testable.
//
// The SPLIT IS ALSO WHAT MAKES THE BKL-205 ORDERING LEGIBLE: the locative
// lookahead belongs to the BARE-interrogative arm ALONE. The menu-WORD arm is
// separate precisely because "o que tem no cardápio?" must keep firing
// the overview through the menu WORD even though it carries a locative — the
// property the fused literal expressed only by the accident of alternation
// order, and which a future edit could have destroyed without any test noticing
// that the two arms had been conflated.
//
// inv.18 v2 / R2-S9 — the three arms are now GENERATED from
// `./claimdefs/menu-overview.claim.ts`, IN THIS ORDER, and read back through
// `MENU_OVERVIEW_CLOSURE.markers`. They were ALREADY three separate literals `||`-ed at
// the use site, so this is the R2-S4 relocation-with-no-splitting case and
// `markers.some((m) => m.test(t))` is the same predicate; the byte pin they rejoin to
// (`__SPAN_NET_SOURCES_FOR_TEST.menuOverview`) PRE-DATES the migration with its expected
// value unchanged, which is the strongest form the "not an equivalent regex, THE SAME
// regex" claim can take. THREE arms and not four: the menu-WORD arm splits further at a
// top-level `|` (measured, and it would rejoin), but it is kept whole because BKL-205 made
// it one unit ON PURPOSE — see the source's header.
//
// The BKL-205 NEGATIVE LOOKAHEAD lives INSIDE arm 1 and travelled into the source with it,
// so the byte pin sees it. What the byte pin CANNOT see is the SPECIFICITY ORDERING below
// (`isMenuOverview` consumed as `!isMenuOverview` by the per-ITEM contents span) — that is
// sequencing between two DIFFERENT types, it stays hand-written, and it carries behavioural
// pins instead.

/**
 * The REASSEMBLED sources of the three nets that were split or composed to fit
 * Sonar's S5843 regex-complexity budget. Exposed (the `__…ForTest` idiom this
 * codebase already uses for `__resetMenuItemMemoForTest` and friends) for exactly
 * one assertion: that each reassembly is BYTE-IDENTICAL to the single literal it
 * replaced.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. Splitting `A|B` at a top-level `|`, or
 * composing a sequence from named parts, cannot change what a pattern matches —
 * but only while the parts still concatenate back to the same string. A future
 * edit to one part is unreviewable against that promise unless something checks
 * it, and "I ran a differential once" is not a property of the repository. The
 * test that consumes this holds the pre-restructure sources verbatim, so any
 * drift in any part fails with the two strings side by side.
 *
 * Pure data; no runtime consumer.
 */
export const __SPAN_NET_SOURCES_FOR_TEST = {
  /**
   * inv.18 v2 / R2-S7 — the ORDER_STATUS_Q strong-token net, now GENERATED as FIVE arms from
   * `order-fulfillment-stage.claim.ts`, rejoined in declaration order. Same statement as its
   * predecessors: if this reassembly is byte-identical to the pre-migration literal, it is not
   * an equivalent regex, it is THE SAME regex.
   *
   * Byte-identity here holds the ACCENT CHARACTER CLASSES `sa[ií]u` and `cad[êe]` — the
   * BKL-205/BKL-270/BKL-271 lesson, where an ASCII-only stem has an EMPTY true-positive set on
   * the real phrasing ("cadê meu pedido?" is how customers actually spell it) and no
   * false-positive sweep reveals it.
   *
   * These are the arms of ONE flat literal; the net's other three arms have a DIFFERENT
   * provenance and are pinned separately below, which is why this entry is a SLICE of the
   * markers array rather than the whole of it. The slice bounds are asserted against
   * `markers.length` so a future arm cannot silently land inside the wrong pin.
   */
  orderStatusStrong: ORDER_FULFILLMENT_STAGE_CLOSURE.markers
    .slice(0, ORDER_STATUS_STRONG_ARMS)
    .map((m) => m.source)
    .join("|"),
  /**
   * `ORDER_ON_THE_WAY_RE | ORDER_DELIVERED_RE` — the BKL-221 arrival pair, now arms 6-7 of the
   * GENERATED ORDER_STATUS_Q net (R2-S7). Unlike the five above, these two were never one
   * literal: they were ALREADY separate regex literals `||`-ed at the use site (the Sonar
   * S5843 split), so this migration is the R2-S4 relocation-with-no-splitting case and the
   * pin's VALUE is unchanged from before the migration — which is the whole claim. Byte-
   * identity holds the BOTH-SIDES anchoring on `a caminho` (standalone preposition+noun,
   * never a substring) and the `(?:foi|est[áa]|j[áa])` QUESTION FRAME on `entregue`, without
   * which a bare participle fires on an order-PLACING utterance and on the ops-plane status
   * value. Each arm is ALSO pinned individually by the test, since a joined two-arm string
   * cannot witness where the boundary is.
   */
  orderArrival: ORDER_FULFILLMENT_STAGE_CLOSURE.markers
    .slice(ORDER_STATUS_STRONG_ARMS, ORDER_STATUS_STRONG_ARMS + 2)
    .map((m) => m.source)
    .join("|"),
  /**
   * the four ETA parts, concatenated — now arm 8 of the GENERATED ORDER_STATUS_Q net (R2-S7),
   * still composed from its four named parts inside the source (a SEQUENCE has no top-level
   * split point, and distributing the head would copy the destination lookahead three times).
   * The pin's value is unchanged by the relocation. Byte-identity holds the trailing
   * `ETA_NOT_TRAVEL` lookahead, which is the only thing separating "quanto tempo para chegar?"
   * (the food arriving — an ORDER question) from "quanto tempo para chegar aí de carro?" (the
   * customer travelling — not one).
   */
  orderEta:
    ORDER_FULFILLMENT_STAGE_CLOSURE.markers[ORDER_STATUS_STRONG_ARMS + 2]?.source ?? "",
  /**
   * inv.18 v2 / R2-S7 — the PAYMENT_STATUS_Q strong-token net, now GENERATED as FIVE arms from
   * `payment-status.claim.ts`, rejoined in declaration order. The accent-class point above
   * applies identically (`cobran[çc]a`).
   *
   * This net is the WHOLE of the type's generated markers, so unlike its order sibling the
   * join is over the entire array. What it deliberately does NOT contain is the pair of
   * DUAL-USE tokens (`pagamento`, `pix`): each classifies only in conjunction with the ABSENCE
   * of a capability/payment-methods frame, so both stay GUARD-conjoined at the classifier. A
   * pin that swept them in would be asserting a net the runtime does not use.
   */
  paymentStatusStrong: PAYMENT_STATUS_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * `MENU_WORD_RE | MENU_BARE_ASK_RE | MENU_LIST_ASK_RE` — now the THREE GENERATED arms of
   * `menu-overview.claim.ts` (R2-S9), rejoined in declaration order.
   *
   * THE ONE PIN IN THIS TABLE WHOSE EXPECTED VALUE PRE-DATES ITS OWN MIGRATION. Every
   * other entry was written when its net moved into a source, freezing the literal as it
   * stood; this one was already here, asserting the same string against three hand-written
   * constants, and the adoption did not touch it. So for this net the "if the reassembly is
   * byte-identical it is not an equivalent regex, it is THE SAME regex" claim is made
   * against a value no one could have adjusted to fit.
   *
   * Byte-identity here holds the BKL-205 NEGATIVE LOOKAHEAD `(?!\s+n[oa]s?\b|\s+em\b)`
   * INSIDE arm 2 — the entire fix for a measured WRONG-FAMILY render ("o que tem no
   * brisket?" answered with the whole catalogue), and the one direction the demote-only
   * argument does not cover. What it does NOT hold is the SPECIFICITY ORDERING that
   * lookahead works with (`!isMenuOverview` on the per-item contents span): that is outside
   * every arm, so this pin is blind to it and it carries behavioural pins instead.
   */
  menuOverview: MENU_OVERVIEW_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S9 — the DELIVERY_COVERAGE_Q markers, now GENERATED as TEN arms from
   * `delivery-coverage.claim.ts`, rejoined in declaration order. Same statement as its
   * predecessors: if this reassembly is byte-identical to the pre-migration literal, it is
   * not an equivalent regex, it is THE SAME regex. It is also the LARGEST net adopted in
   * the arc, and the depth-0 split was MEASURED to rejoin before a byte of it moved.
   *
   * Byte-identity here holds the trailing `(?![a-z])` on arms 3 and 6 (without which
   * "entregam em" fires inside a longer word) and the accent CHARACTER CLASSES
   * (`voc[êe]s`, `at[ée]`, `regi[õo]es`, `pre[çc]o`) — the BKL-205/BKL-270/BKL-271 lesson.
   *
   * WHAT THIS PIN DOES NOT SAY: the runtime span is `¬selfReference && ¬mutationImperative
   * && <this net>`, and only the net is generated. Delete the SELF-REFERENCE guard inside
   * `isDeliveryCoverageAsk` and this value is still byte-identical while "cadê minha
   * entrega?" starts classifying as a store-policy coverage question. A byte pin is
   * guard-blind BY CONSTRUCTION; the guard carries behavioural must-not-fire cases.
   */
  deliveryCoverage: DELIVERY_COVERAGE_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S9 — the coupon NOUN, the ONE generated arm of `coupon-valid.claim.ts`.
   * The DEGENERATE reassembly (the R2-S6 `cartContents` shape): with a single arm the
   * `join("|")` is the arm's own source and `markers.some((m) => m.test(t))` is literally
   * the `.test(t)` the pre-migration `COUPON_NOUN_RE` ran — a relocation, not a split, and
   * measured as such (no conjunct of this span's predicate decomposes; every one is a
   * single lookbehind-anchored literal).
   *
   * Byte-identity holds the LEFT anchor `(?<![a-z])` and — the load-bearing part — the
   * QUALIFICATION of `código`: a bare "código" is deliberately NOT a coupon noun, because
   * "qual o código do meu pedido?" is an order question. Dropping the
   * `(?:desconto|promo…)` tail would widen the span onto a whole unrelated family while
   * every coupon true-positive still passed.
   *
   * This net is the TOPIC conjunct only. The three DISCRIMINATOR regexes and the
   * code-extraction FUNCTION stay hand-written, so this pin cannot see the read-vs-mutation
   * split at all: delete the apply-imperative guard and "aplica o cupom X" rides the read
   * with this value unchanged.
   */
  couponNoun: COUPON_VALID_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S9 — the PAIRING_Q markers, now GENERATED as TWO arms from
   * `menu-pairings.claim.ts`, rejoined in declaration order. Like RESERVATION_STATUS this
   * is NOT a split of a pre-existing alternation: the two arms were ALREADY separate regex
   * literals, `||`-ed inside `classifyPairingAsk`, so the migration relocated them verbatim
   * and `markers.some((m) => m.test(t))` is the SAME predicate `isPairingAsk` ran.
   *
   * THE ORDER IS PART OF WHAT IS PINNED, and for this net alone that matters at RUNTIME:
   * arm 0 is the SUBSTITUTION vocabulary and arm 1 the PAIRING vocabulary, in the order
   * `classifyPairingAsk` tests them, and swapping them would invert every borrowed-
   * vocabulary utterance's relation ("o que vai bem no lugar da costela" → `pairs-with`)
   * with no other assertion in this file noticing. Both arms contain top-level-looking `|`s
   * INSIDE their groups, so the joined value alone cannot witness where the boundary is —
   * the test therefore pins each arm's source INDIVIDUALLY as well, and this entry carries
   * the shared non-empty / well-formed backstop.
   */
  pairing: MENU_PAIRINGS_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S1 — the STORE_INFO_Q markers, now GENERATED as SEVEN arms from
   * `store-info.claim.ts`, rejoined in declaration order. Same statement as the three
   * above, made about a split into a data array rather than into named constants: if
   * this reassembly is byte-identical to the pre-migration literal, it is not an
   * equivalent regex, it is THE SAME regex.
   */
  storeInfo: STORE_INFO_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S2 — the MENU_ITEM_PRICE_Q markers, now GENERATED as FOUR arms from
   * `menu-item-price.claim.ts`, rejoined in declaration order. Same statement as
   * `storeInfo` above: if this reassembly is byte-identical to the pre-migration literal,
   * it is not an equivalent regex, it is THE SAME regex.
   */
  menuItemPrice: MENU_ITEM_PRICE_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S3 — the MENU_ITEM_CONTENTS_Q markers, now GENERATED as FOUR arms from
   * `menu-item-contents.claim.ts`, rejoined in declaration order. Same statement as
   * `menuItemPrice` above, and it carries the extra weight here that BKL-205's ACCENTED
   * forms (`v[êe]m` / `t[êe]m`) live INSIDE these arms: an accented vowel sits exactly
   * where the plain one would, so losing one would empty the true-positive set on the real
   * phrasing while every false-positive sweep still passed.
   */
  menuItemContents: MENU_ITEM_CONTENTS_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S3 — the MENU_DIETARY_Q markers, now GENERATED as TWO arms from
   * `menu-dietary.claim.ts`, rejoined in declaration order. Byte-identity is what pins the
   * ANCHORING ASYMMETRY between the arms (`vegetarian[ao]?` unanchored so it also matches
   * inside "comida vegetariano"; `\bvegan[ao]?\b` word-bounded) — an "equivalent" rewrite
   * that anchored both would silently narrow the net.
   */
  menuDietary: MENU_DIETARY_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S4 — the RESERVATION_STATUS_Q markers, now GENERATED as TWO arms from
   * `reservation-status.claim.ts`, rejoined in declaration order. Unlike its four
   * predecessors this is NOT a split of one pre-existing alternation: the two arms were
   * ALREADY separate regex literals `||`-ed in `classifyRequestSpans`, so the migration
   * relocated them verbatim and `markers.some((m) => m.test(t))` is the SAME predicate
   * the classifier ran before.
   *
   * Byte-identity here holds the ANCHORING ASYMMETRY the FE-T17 review fix installed:
   * arm 1 is anchored on the LEFT only (`(?<![a-z])reserv(?!at)…` — it must still match
   * "reservas"/"reservado" with their trailing letters, while the lookbehind closes the
   * preserv* family and the `(?!at)` lookahead closes "reservatório"), arm 2 on BOTH
   * sides (`(?<![a-z])mesas?(?![a-z])` — standalone "mesa"/"mesas" only, never "mesada").
   * An "equivalent" rewrite that anchored both alike would silently narrow the net on the
   * real phrasing while every false-positive sweep still passed.
   *
   * NOTE for the reader of the joined value: arm 1 contains top-level-looking `|`s
   * INSIDE its `(a|ar|ad|…)` group, so a joined string alone cannot witness where the
   * arm boundary is. The test therefore pins each arm's source INDIVIDUALLY off
   * `RESERVATION_STATUS_CLOSURE.markers` as well — this entry exists so the shared
   * non-empty / well-formed backstop below covers this net too.
   */
  reservationStatus: RESERVATION_STATUS_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S5 — the ORDER_HISTORY_Q markers, now GENERATED as THREE arms from
   * `order-history.claim.ts`, rejoined in declaration order. Same statement as its
   * predecessors: if this reassembly is byte-identical to the pre-migration literal, it is
   * not an equivalent regex, it is THE SAME regex.
   *
   * Byte-identity here holds two things a rewrite would quietly lose. (1) The accent
   * CHARACTER CLASSES `hist[óo]rico` and `[úu]ltimos` — the BKL-205/BKL-270/BKL-271
   * lesson, where an ASCII-only stem has an EMPTY true-positive set on the real phrasing
   * and no false-positive sweep reveals it. (2) The REVERSED arm 2
   * (`pedido[^.!?]{0,25}hist[óo]rico`), which this net has and its payment twin does NOT —
   * the asymmetry is pre-existing and load-bearing, and a "tidy the pair to match" rewrite
   * would change one net or the other.
   *
   * NOTE for the reader of the joined value: arm 3 contains top-level-looking `|`s INSIDE
   * its `(meus|todos os meus|[úu]ltimos)` group, so a joined string alone cannot witness
   * where the arm boundaries are. The test therefore pins each arm's source INDIVIDUALLY
   * off `ORDER_HISTORY_CLOSURE.markers` as well — this entry exists so the shared
   * non-empty / well-formed backstop below covers this net too.
   */
  orderHistory: ORDER_HISTORY_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S5 — the PAYMENT_HISTORY_Q markers, now GENERATED as TWO arms from
   * `payment-history.claim.ts`, rejoined in declaration order. The accent-class point
   * above applies identically.
   *
   * The arm-boundary ambiguity is STRONGER here than on the order twin: with only two arms
   * and internal `|`s in BOTH of them (`(pagamento|pagar)` and
   * `(meus|todos os meus|[úu]ltimos)`), the joined string is genuinely ambiguous about the
   * split point — so the individual per-arm pins are what carry the proof, and this entry
   * carries the shared backstop.
   */
  paymentHistory: PAYMENT_HISTORY_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S6 — the CART_CONTENTS_Q marker, now GENERATED as ONE arm from
   * `cart-contents.claim.ts`. This is the DEGENERATE case of the reassembly statement its
   * six predecessors make: with a single arm the `join("|")` is the arm's own source, and
   * `markers.some((m) => m.test(t))` is literally the `.test(t)` the pre-migration `cartRef`
   * const ran — no alternation was split and no `||` was folded, so the migration is a
   * relocation and byte-identity says so.
   *
   * Byte-identity here holds ONE property a rewrite would lose and ONE it merely preserves,
   * and the difference is measured rather than assumed. (1) LOAD-BEARING: the LEFT anchor
   * `(?<![a-z])`, without which a cart word matches mid-word — dropping it turns both this
   * pin and a must-not-fire case red. (2) BYTE-PIN-ONLY: the PLURALS spelled out as their own
   * alternatives. The net has no RIGHT anchor, so `carrinho` already matches inside
   * "carrinhos"; deleting the three plural alternatives changes NO row of the corpus below,
   * and an `s?` suffix is equivalent. The R2-S5 byte-pin-only-arm shape, recorded because a
   * comment claiming otherwise would be a safety property the measurement denies.
   */
  cartContents: CART_CONTENTS_CLOSURE.markers.map((m) => m.source).join("|"),
  /**
   * inv.18 v2 / R2-S8 — the SCHEDULE-CONTEXT half of the STORE_HOURS_FOR_DATE_Q predicate,
   * now GENERATED as NINE arms from `store-hours-for-date.claim.ts`, rejoined in declaration
   * order. Same statement as its predecessors: if this reassembly is byte-identical to the
   * pre-migration literal, it is not an equivalent regex, it is THE SAME regex.
   *
   * WHAT THIS PIN DOES NOT SAY, and why the distinction is the whole slice. Every earlier
   * entry here pins a WHOLE span net. This one pins ONE CONJUNCT of a two-conjunct
   * predicate: the runtime span is `dateAnchor && scheduleContext`, and only the second half
   * is generated. So this value staying byte-identical is consistent with the span being
   * COMPLETELY BROKEN — delete the `dateAnchor` conjunct at `classifyRequestSpans` and this
   * pin is still green while every bare hours question starts classifying as day-specific.
   * That is not a hypothetical: it is RTR-2 of this slice, and it is why the guard half
   * carries BEHAVIOURAL must-fire / must-not-fire cases in
   * `__tests__/required-claim-decomposer.test.ts` rather than trusting a byte pin that
   * cannot see it. A byte pin is guard-blind BY CONSTRUCTION.
   *
   * Byte-identity here holds the ACCENT CHARACTER CLASS `hor[áa]rio` — the
   * BKL-205/BKL-270/BKL-271 lesson, where an ASCII-only stem has an EMPTY true-positive set
   * on the real phrasing ("qual o horário de domingo?" is the attested SCN-002 utterance)
   * and no false-positive sweep reveals it — and the `abre|abrem|abert` TRIPLE, whose middle
   * arm is redundant under prefix matching but is part of the literal the runtime has always
   * run. A "tidy the redundant arm away" rewrite would be a behaviour-preserving edit that
   * this pin correctly refuses, because the next such edit might not be.
   */
  storeHoursForDate: STORE_HOURS_FOR_DATE_CLOSURE.markers.map((m) => m.source).join("|"),
} as const;

export function classifyRequestSpans(text: string): SpanClass[] {
  const t = text.toLowerCase();
  const classes: SpanClass[] = [];

  // BKL-201 — an IMPERATIVE MUTATION verb ("tira/remove/muda/troca/adiciona/põe/
  // coloca…") that co-occurs with a cart or menu noun must NOT let this text fire a
  // classify-only-eligible READ span (CART_CONTENTS_Q / the #348 MENU + STORE_INFO
  // spans). Otherwise a write turn ("tira o refrigerante do carrinho", "muda o preço
  // do brisket") rides the deterministic read path, renders the read, and the
  // mutation is SILENTLY DROPPED (no model call, no proposed intent) — live-caught as
  // SCN-046. MUTATION verbs only — never a READ imperative ("mostra/mostre/diz/quero
  // ver"), so "me mostra o cardápio" still fires MENU_OVERVIEW_Q. Word-boundary
  // anchored so "retirar"/"partir"/"sentir" never false-match "tir". The suppression
  // is fail-SAFE: a false positive only routes a read to the model path (mild
  // inefficiency), never a wrong render; a false negative (the pre-BKL-201 state)
  // drops a customer's mutation.
  // BKL-206 — `cancel` joins the net so an ORDER cancel imperative ("cancela meu
  // pedido") is recognised as a mutation and routed off the owner-scoped STATUS
  // read spans (gated below), not just the cart/menu reads. A how-to interrogative
  // ("como cancelo meu pedido?") also matches and routes to the model path, where
  // it gets a helpful answer — the fail-SAFE direction (model, never a wrong read).
  // BKL-238 — the CHECKOUT roots (`fech`/`finaliz`) join the net for the same reason
  // BKL-206 added `cancel`: "quero fechar o pedido e pagar com pix" is a checkout
  // MUTATION, but `pagar` is a STRONG payment-status token (and a bare `pix` pushes
  // too), so it fired PAYMENT_STATUS_Q → the unsatisfiable PAYMENT_STATUS closure →
  // RENDER degraded to UNKNOWN on every checkout turn (live-caught as SCN-049).
  // `pedido` did the same to ORDER_STATUS_Q. Both status spans are gated below, so
  // recognising the checkout verb is the whole fix — the mutation then takes the
  // model/intent path that actually closes the order.
  // The two roots carry a NEGATIVE lookahead (the `reserv(?!at)` idiom used below)
  // because their non-verb families are exactly the READ vocabulary this net must
  // NOT capture: `fechad*` ("vocês estão fechados?" — and `fechadura`), `fechament*`
  // ("horário de fechamento"), `fechou`/`fecham*` ("o restaurante já fechou?", "que
  // horas vocês fecham?"), and `finalizad*` ("meu pedido foi finalizado?" — a
  // GENUINE order-status ask). What survives is the verb proper: fecha/fecho/fechar/
  // feche/fechei/fechem/fechando, finaliza/finalizo/finalizar/finalize/finalizei.
  // BKL-271 — the `p[õo]r` branch is DELETED (not guarded). It had an EMPTY true-
  // positive set and matched read vocabulary only. Three measured facts, in the order
  // that forces the conclusion:
  //   1. The character class was `[õo]` — NOT `ô` (U+00F4) — so the branch never
  //      matched the infinitive `pôr` it was written for. Its intended true positive
  //      was already unreachable.
  //   2. It DID match the prefix "por" inside `pork` (the `(?<![a-z])` left guard is
  //      satisfied by the space/hyphen in "pulled pork" / `pulled-pork`, a SEEDED
  //      product), and likewise `porção` (the variant title of six seeded products),
  //      `porco`, `portão`, `porta`, `porque`, `português`, `porém`. Note a trailing
  //      ASCII guard alone does NOT close these — `ç` and the accented vowels sit
  //      outside [a-z], so `porção` survives `(?![a-z])`; any such guard has to be
  //      spelled against the REAL pt-BR alphabet (`[a-zà-ÿ]`, which covers ç U+00E7).
  //   3. It also matched the BARE preposition, which no trailing guard can reach. Of
  //      144 word-initial "por " bigrams across every pt-BR corpus in this repo, 111
  //      (77%) are the politeness markers "por favor" / "por gentileza" and ZERO are
  //      the verb. A politeness marker attaches to reads and writes alike, so the
  //      branch suppressed EVERY read span on a polite utterance ("me mostra o
  //      cardápio, por favor" classified to []).
  // Restoring the branch as `p[õô]r` (i.e. actually matching `pôr`) was tried and is
  // WRONG: `pôr` is not reliably a mutation verb. LE2-029's committed pairing e2e
  // pins "o que combina com a costela bovina e o que posso pôr no lugar?" as a READ —
  // a SUBSTITUTION question — and the modal frame "posso/pode pôr" is exactly how the
  // infinitive shows up in this domain. Adding `ô` turned that read into a mutation
  // and broke the e2e. The imperative forms carry the mutation, so `p[õo]e`
  // (põe/poe) stays and `ponh` (ponha/ponho — never covered before, and grammatically
  // incapable of the "posso X" read frame) joins it.
  // `colo[cq]` / `tro[cq]` close the pt-BR c→q orthographic alternation: `colocar` →
  // "coloque" and `trocar` → "troque" were NOT matched, so "coloque uma coca no
  // carrinho" fired CART_CONTENTS_Q and the add was SILENTLY DROPPED (a live BKL-201
  // hole, measured). `troq` is load-bearing for THIS change specifically: "troque a
  // costela POR brisket" only suppressed before via the "por" defect, so deleting the
  // branch without it would have regressed that mutation onto the read path.
  // BKL-271 — `cancel` gains the SAME `(?!ad)` lookahead `finaliz` already carries,
  // for the same reason and with the same evidence shape: `cancelad*` is a STATUS
  // participle, not an imperative ("meu pedido foi cancelado?" / "minha reserva está
  // cancelada?" both classified to [], losing ORDER_STATUS_Q / RESERVATION_STATUS_Q).
  // 66 attested `cancelad[oa]s?` occurrences in-repo are status text; not one is a
  // customer mutation request. The imperative family is untouched: cancela / cancelar
  // / cancele / cancelei / cancelamento ("quero o cancelamento do pedido") all still
  // match, exactly as fecha/finaliza do past their own lookaheads.
  // BKL-262 Stage 1 — the net itself now lives in the exported
  // {@link hasMutationImperative} (verbatim move, same two literals, same OR), so the
  // ops write-twin read rescue asks the SAME question rather than spelling a rival
  // one. Every span below still gates on this identical boolean.
  // F-27 — `mud` gains the past-tense lookahead `(?!ou|ad|aram)` its `fech(?!…|ou|…)`
  // sibling has always carried, so a preterite READ ("meu histórico de pedidos
  // mudou?", "meu pedido mudou?") stops being read as a command and keeps its span.
  // The three arms, the rejected ones, and the both-planes sweep are enumerated in
  // {@link hasMutationImperative}'s docblock — it is a SHARED-net change.
  // BKL-285 — the RESERVATION-CREATE family joins the gate, but ONLY here, in this
  // function's LOCAL variable. The shared `hasMutationImperative` is deliberately
  // NOT widened: it has a second consumer on the OPS plane
  // (`ops-write-twin-rescue.ts`), which has no reservation-create surface, so the
  // roots would mean nothing there while changing staff-plane routing. OR-ing at
  // this seam gives the create imperative exactly the treatment every other
  // customer mutation already gets — every span below is gated on this one boolean,
  // so a booking request stops riding ANY classify-only read, not just its own.
  // See {@link hasReservationCreateImperative} for why the discriminator cannot be
  // the `reserv` stem (it IS the read anchor) and for the four-part shape net.
  const mutationImperative = hasMutationImperative(t) || hasReservationCreateImperative(t);

  // F-13(b) — the COUPON reading is resolved HERE, ahead of the schedule span,
  // because it is what tells a spurious `funciona` from a real one. It is the same
  // boolean the coupon span below pushes on, evaluated ONCE: the two questions "is
  // this a coupon ask?" and "does the schedule marker mean anything?" must be
  // answered from one classification or they can disagree. The RAW `text` is
  // passed, never `t` — see {@link isCouponValidityAsk}'s caller note.
  const couponValidityAsk = !mutationImperative && isCouponValidityAsk(text);

  if (/retir|buscar|pegar/.test(t)) classes.push("PICKUP_Q");
  // inv.18 v2 — the STORE_OPEN_NOW_Q markers are GENERATED from the def source
  // (replaces the previously-handwritten /abert|fechad|.../ regex — the runtime
  // image can no longer drift from the ClaimDefinition closure).
  // F-13(b) — and they are read through {@link hasIndependentStoreOpenNowMarker},
  // which DROPS this span when its only evidence is a marker the coupon validity
  // vocabulary also owns ("funciona"). DEMOTE-ONLY; see that predicate's header.
  if (hasIndependentStoreOpenNowMarker(t, couponValidityAsk)) {
    classes.push(STORE_OPEN_NOW_CLOSURE.spanClass);
  }

  // BKL-138 — a DAY-SPECIFIC hours question (SCN-002/003). Fires ONLY on the
  // CONJUNCTION of a DATE ANCHOR (a named weekday / "amanhã" / "feriado") AND schedule
  // phrasing, so a bare "que horas funciona?" stays STORE_OPEN_NOW_Q-only and a greeting
  // that merely names a day ("bom domingo!") is NOT swept in. DEMOTE-ONLY safe:
  // over-inclusion only forces the STORE_HOURS_FOR_DATE companion; the resolver then
  // degrades honestly if no date is truly resolvable (a bare "feriado" with no anchor).
  //
  // inv.18 v2 / R2-S8 — the SCHEDULE-CONTEXT conjunct is now the GENERATED marker net from
  // `store-hours-for-date.claim.ts` (a `.some()` over its nine arms is exactly the `.test()`
  // on the flat alternation it replaces — pinned byte-identical by
  // `__SPAN_NET_SOURCES_FOR_TEST.storeHoursForDate`). The DATE-ANCHOR conjunct stays
  // HAND-WRITTEN here, verbatim and in place, because a `markers` array is DISJUNCTIVE and
  // this span is a CONJUNCTION: only one conjunct can be the generated net. `dateAnchor` is
  // the one that cannot be it — its `|`s sit INSIDE a group under a shared `\b`, so no
  // per-arm split rejoins to the same bytes, and it is also the half that DISCRIMINATES this
  // span from its STORE_OPEN_NOW sibling, which is the half a reviewer most needs in front
  // of them. Deleting it leaves the generated net byte-identical while every bare hours
  // question in the corpus starts firing this span — so it carries BEHAVIOURAL pins
  // (__tests__/required-claim-decomposer.test.ts), not only a source-byte one.
  const dateAnchor =
    /\b(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|amanh[ãa]|feriado)/.test(t);
  const scheduleContext = STORE_HOURS_FOR_DATE_CLOSURE.markers.some((m) => m.test(t));
  if (dateAnchor && scheduleContext) {
    classes.push(STORE_HOURS_FOR_DATE_CLOSURE.spanClass);
  }

  // BKL-142 — PUBLIC menu-catalog questions. DISJOINT from the BKL-152 date-anchor
  // suppression above (which only touches the schedule spans). Guarded away from the
  // cart/order/delivery families so a "quanto custa a ENTREGA" or "o que tem no
  // CARRINHO" is NOT swept in as an item question (those already route to their own
  // spans). Over-inclusion is DEMOTE-ONLY safe: an item that doesn't resolve →
  // resolveMenuItem `undefined` → ABSENT evidence → honest UNKNOWN, never a wrong price.
  const notOrderScoped = !/pedido|carrinho|entrega|frete/.test(t);
  // BKL-142 — a menu-WIDE overview question ("o que tem no cardápio?", "me mostra o
  // menu", "quais os pratos?"). Anchored on the WHOLE-menu markers (cardápio/menu) or a
  // bare "o que vocês têm/servem", DISJOINT from the per-item spans below and from the
  // BKL-152 date-anchor family (which only touches the schedule spans). Over-inclusion is
  // DEMOTE-ONLY safe: an empty/unreadable catalog → ABSENT evidence → honest UNKNOWN.
  //
  // BKL-273 — the `!ALLERGEN_FAMILY_RE` condition that used to sit here is GONE, and
  // its removal is the ticket. Suppressing the SPAN did not route an allergen-marked
  // overview ask to the conservative abstain: it left the turn with NO read span at
  // all, so §O#15 had nothing to complete, no claims render fired, and the REAL
  // responder authored the dietary sentence itself — measured at the customer seam
  // (BKL-270 audit). The span now always fires and the guard lives on the READ
  // (menu-item-resolver.ts `resolveMenuOverviewText`), exactly as LE2-029 placed the
  // pairing guard on `resolvePairings` for the same reason.
  // BKL-205 — SPECIFICITY ORDERING (half 2 of the ticket). The bare-interrogative
  // arm carries a NEGATIVE LOOKAHEAD for a LOCATIVE complement, so "o que tem NO
  // BRISKET?" stops being answered with the whole menu.
  //
  // THE DEFECT, measured on dev: `o que (voc[êe]s )?(t[êe]m|servem)` matched the
  // "o que tem" prefix of an ITEM question, MENU_OVERVIEW_Q fired, and the
  // `!isMenuOverview` guard on the per-item span below then SUPPRESSED the very
  // span the customer's question was about. The turn did not degrade — it
  // CONFIDENTLY rendered the entire catalogue as the answer to "what is in the
  // brisket". A wrong-FAMILY render is the one direction the demote-only argument
  // does not cover, which is why this is a span fix and not a resolver fix.
  //
  // WHY A LOCATIVE AND NOT "a resolvable product name" (which is what the ticket
  // asked for): this module is PURE — no catalog IO, by construction — so it
  // cannot know whether a name resolves. The deterministic proxy for "the customer
  // named a SPECIFIC subject" is the locative complement itself: "o que tem" +
  // no/na/nos/nas/em + <thing>. The whole-menu asks keep their own arms and are
  // therefore untouched — `\bcard[áa]pio\b` and `\bmenu\b` are INDEPENDENT
  // alternatives, so "o que tem no cardápio?" / "o que tem no menu de hoje?" still
  // fire the overview through them, ahead of this lookahead.
  //
  // The complement-less overview phrasings are likewise untouched, because none of
  // them puts a locative right after the verb: "o que vocês têm?", "o que tem pra
  // comer?", "o que vocês servem?", "o que tem de sobremesa?" (a `de` complement is
  // deliberately NOT excluded — a category ask is an overview, not an item).
  //
  // inv.18 v2 / R2-S9 — the MARKERS are now GENERATED from the def source (three arms
  // rejoining to the pinned literal character-for-character —
  // `__SPAN_NET_SOURCES_FOR_TEST.menuOverview`, whose expected value is unchanged by the
  // migration). The GUARD conjunction is NOT generated and stays here, and so does the
  // `isMenuOverview` BINDING ITSELF: it is read below as `!isMenuOverview` by the per-ITEM
  // contents span, which is sequencing between two DIFFERENT types and is the half no
  // source can express — nor any byte pin catch.
  const isMenuOverview =
    notOrderScoped &&
    !mutationImperative &&
    MENU_OVERVIEW_CLOSURE.markers.some((m) => m.test(t));
  if (isMenuOverview) classes.push(MENU_OVERVIEW_CLOSURE.spanClass);

  // inv.18 v2 / R2-S2 — the MARKERS are now GENERATED from the def source (they were one
  // flat top-level alternation, so the four generated arms REJOIN to that literal
  // character-for-character — pinned by `__SPAN_NET_SOURCES_FOR_TEST.menuItemPrice`). The
  // GUARD conjunction is NOT generated and stays here: the compiler models which markers
  // classify INTO a span, not which contexts must suppress it — `notOrderScoped` is what
  // keeps "quanto custa a ENTREGA/o FRETE/o PEDIDO" off the per-item price span, and
  // `!mutationImperative` keeps "muda o preço do brisket" on the mutation path.
  if (
    notOrderScoped &&
    !mutationImperative &&
    MENU_ITEM_PRICE_CLOSURE.markers.some((m) => m.test(t))
  ) {
    classes.push(MENU_ITEM_PRICE_CLOSURE.spanClass);
  }
  // BKL-273 — allergen-family phrasing ("ingredientes", "contém glúten/lactose") NO
  // LONGER suppresses this span. It still never produces a rendered CONTENTS answer,
  // but the refusal now happens on the READ (menu-item-resolver.ts
  // `composeMenuContentsText` returns `undefined` for an allergen-marked ask → NO
  // evidence → honest UNKNOWN → the BKL-184 abstain + staff handoff). Suppressing the
  // span instead dropped the turn off the deterministic path entirely and handed the
  // dietary question to the model, which is the failure this ticket fixes.
  // `!isMenuOverview` keeps a WHOLE-menu question ("o que tem no cardápio") disjoint from
  // the per-ITEM contents span ("o que vem no combo") — the overview owns it.
  // BKL-205 — the ACCENTED forms join the net (half 1 of the ticket). `vem`/`tem`
  // were spelled ASCII-only, so the plural `vêm` and `têm` — which is how a
  // customer writes "o que vêm no combo família?" — matched NOTHING here. This is
  // the BKL-270/BKL-271 accent lesson recurring for the third time (`diabet` never
  // matched "diabético"; `p[õo]r` never matched "pôr"): the accented vowel sits
  // exactly where the plain one would, so the stem's true-positive set on the real
  // phrasing was EMPTY, and no false-positive sweep can reveal that. Both spellings
  // are asserted individually by test for that reason.
  //
  // `t[êe]m` is load-bearing TOGETHER WITH the overview lookahead above, not
  // merely nice to have: that lookahead sends "o que têm no combo?" away from the
  // overview span, so without the accented form here the utterance would have
  // classified to NOTHING — trading a wrong-family render for no span at all,
  // which BKL-273 established is the worse of the two.
  // The `[ée]` is a CHARACTER CLASS, not the `(é|e)` alternation it replaces
  // (Sonar S6035). Same single character, same matched language; the group was
  // capturing and this is not, which is invisible here because the only use is
  // `.test`. Pinned byte-for-byte against the pre-restructure source by test.
  // inv.18 v2 / R2-S3 — the MARKERS are now GENERATED from the def source (they were one
  // flat top-level alternation, so the four generated arms REJOIN to that literal
  // character-for-character — pinned by `__SPAN_NET_SOURCES_FOR_TEST.menuItemContents`).
  // Everything the two BKL-205/BKL-273 notes above assert about the accented forms and
  // the `[ée]` character class is a statement about those arms and travels with them. The
  // GUARD conjunction is NOT generated and stays here: `notOrderScoped` keeps "o que tem
  // no meu PEDIDO" off the per-item span, `!mutationImperative` keeps "tira o que vem no
  // combo" on the mutation path, and `!isMenuOverview` keeps a WHOLE-menu ask disjoint
  // from this per-ITEM one.
  if (
    notOrderScoped &&
    !mutationImperative &&
    !isMenuOverview &&
    MENU_ITEM_CONTENTS_CLOSURE.markers.some((m) => m.test(t))
  ) {
    classes.push(MENU_ITEM_CONTENTS_CLOSURE.spanClass);
  }

  // BKL-214 — a dietary-PREFERENCE question ("tem opção vegetariana?", "prato vegano?").
  // RESTRICTED to pure-preference tags (vegetariano/vegano) — matches ONLY those stems.
  // `!mutationImperative` keeps "tira o vegetariano do carrinho" on the mutation path.
  // Over-inclusion is DEMOTE-ONLY safe: no tagged product → ABSENT evidence → honest
  // UNKNOWN, never a fabricated option.
  //
  // BKL-273 — the `!ALLERGEN_FAMILY_RE` condition that used to sit here is GONE. An
  // allergen-adjacent diet ("tem opção vegetariana sem glúten?") still NEVER produces a
  // rendered dietary list — the guard moved to the READ (menu-item-resolver.ts
  // `resolveDietaryOptionsText`), which returns `undefined` for such an ask → NO
  // evidence → honest UNKNOWN → the BKL-184 abstain + staff handoff. Suppressing the
  // span sent the turn to the model instead, which authored the "sem glúten" answer.
  // inv.18 v2 / R2-S3 — the MARKERS are now GENERATED from the def source (they were one
  // flat top-level alternation, so the two generated arms REJOIN to that literal
  // character-for-character — pinned by `__SPAN_NET_SOURCES_FOR_TEST.menuDietary`,
  // including the load-bearing anchoring asymmetry: `vegetarian[ao]?` unanchored,
  // `\bvegan[ao]?\b` word-bounded). The GUARD conjunction is NOT generated and stays here.
  if (
    notOrderScoped &&
    !mutationImperative &&
    MENU_DIETARY_CLOSURE.markers.some((m) => m.test(t))
  ) {
    classes.push(MENU_DIETARY_CLOSURE.spanClass);
  }

  // BKL-136 — a store-LOCATION/parking question ("onde fica o restaurante?", "qual o
  // endereço?", "tem estacionamento?", "como chegar?"). GUARDED away from the
  // order/delivery/cart/reservation/payment families: "onde fica meu PEDIDO" is an
  // order-status ask, and letting STORE_INFO validate there would render the
  // restaurant's address as a confident non-answer to a different question (a
  // VALIDATED claim is not demote-only — the guard must be precise, not
  // over-inclusive). A guarded miss degrades honestly (no span → no forced
  // companion; the planner's own nets still run).
  //
  // inv.18 v2 / R2-S1 — the MARKERS are now GENERATED from the def source (they were one
  // flat top-level alternation, so the seven generated arms REJOIN to that literal
  // character-for-character — pinned by `__SPAN_NET_SOURCES_FOR_TEST.storeInfo`). The
  // GUARD conjunction is NOT generated and stays here: the compiler models which markers
  // classify INTO a span, not which contexts must suppress it.
  const notResourceScoped = !/pedido|entrega|frete|carrinho|reserva|pagamento/.test(t);
  // F-31 — the SELF-SCOPED ADDRESS conjunct, and the half of that defect no verb root
  // can reach. `notResourceScoped` above already keeps "o endereço de entrega do meu
  // PEDIDO" out; what it cannot see is the customer's OWN address named with nothing
  // but a possessive, which is how three of the nine pinned phrasings are spelled:
  //
  //     "meu endereço mudou"                    (a preterite REPORT — F-27 correctly
  //                                              refuses to read it as a command)
  //     "meu endereço agora é rua das flores 123"
  //     "meu novo endereço é rua das flores 123"
  //
  // None carries a mutation VERB, so no root in `hasMutationImperative` can reach
  // them, and every one was answered with the RESTAURANT's address — a wrong-FAMILY
  // render, because STORE_INFO is classify-only-eligible and the turn never reached
  // the model. Suppressing the span leaves the turn with NO read span at all, which
  // is the correct routing: the planner then sees an address-change turn.
  //
  // WHY A 1st-PERSON POSSESSIVE IS THE DISCRIMINATOR, and why it is not
  // over-inclusive: a customer asking where the restaurant IS never says "MEU
  // endereço". The BKL-136 must-fire list is untouched by construction — "onde fica o
  // restaurante?", "qual o endereço de vocês?", "como chego até vocês?" carry no
  // 1st-person possessive at all — and the STORE's own move stays a read ("vocês
  // mudaram de endereço?" keeps STORE_INFO_Q; `mud(?!…|aram)` keeps it off the
  // mutation path too). MEASURED over the frozen corpus: of the 63 rows that fire
  // STORE_INFO_Q, exactly 11 are suppressed — ten are the F-31 family itself and the
  // eleventh is the literal `"meu endereco"`, a `resolve-and-assemble.ts` marker
  // FRAGMENT that is matched AGAINST utterances and is never one.
  //
  // WHY IT LIVES HERE AND NOT IN `hasMutationImperative`: that predicate has two
  // other consumers (the ops write-twin rescue, the BKL-262 Stage-2 recovery), and a
  // verbless declarative is NOT an imperative — claiming otherwise would be false
  // about the text and would carry a customer-plane read discrimination onto the
  // staff plane. This is the same placement ruling BKL-285 made for the
  // reservation-create net, for the same reason.
  //
  // KNOWN RESIDUAL: an address edit that names neither a verb nor a possessive ("o
  // endereço que eu cadastrei está errado" reaches this via `cadastr`, but a bare
  // "endereço novo: rua X" does not) still rides the read.
  const notSelfScopedAddress = !/(?<![a-z])(meu|minha|meus|minhas)\s+(?:nov[oa]\s+)?endere[çc]o/.test(
    t,
  );
  if (
    notResourceScoped &&
    notSelfScopedAddress &&
    !mutationImperative &&
    STORE_INFO_CLOSURE.markers.some((m) => m.test(t))
  ) {
    classes.push(STORE_INFO_CLOSURE.spanClass);
  }

  // LE2-002 / NEW-007 — a delivery-COVERAGE question ("vocês entregam em Ibaté?",
  // "entregam no CEP 14815000?", "qual a taxa de entrega?"). Gated on
  // `!mutationImperative` like every other classify-only-eligible READ span (the
  // BKL-201/206 read-vs-mutation split), and DISJOINT from ORDER_STATUS_Q by the
  // shared self-reference guard inside `isDeliveryCoverageAsk` — "cadê MINHA
  // entrega?" stays an owner-scoped order question and never fires this span.
  // Over-inclusion is DEMOTE-ONLY safe: an unmatched place resolves to the
  // CLARIFY-for-CEP ask, never a guessed coverage answer.
  //
  // inv.18 v2 / R2-S9 — the MARKERS live in `./claimdefs/delivery-coverage.claim.ts` and are
  // consumed inside `isDeliveryCoverageAsk`, which is where the SELF-REFERENCE guard is too
  // (one exported predicate, so the span and the render seam ask the same question). The
  // class key is the generated `spanClass`.
  if (!mutationImperative && isDeliveryCoverageAsk(t)) {
    classes.push(DELIVERY_COVERAGE_CLOSURE.spanClass);
  }

  // LE2-019 / spec Decision 18 — a coupon-VALIDITY question ("o cupom X1234
  // vale?"). Gated on `!mutationImperative` like every other classify-only-eligible
  // READ span (the BKL-201/206 read-vs-mutation split — "tira o cupom do carrinho"
  // stays a mutation), and `isCouponValidityAsk` applies its OWN apply-imperative
  // guard on top, so "aplica o cupom X" never rides this read either. The two guards
  // are complementary, not redundant: the shared net catches the cart-verb family,
  // the coupon net catches the coupon-specific apply verbs it does not list.
  // Over-inclusion is DEMOTE-ONLY safe: an unextractable code resolves to the
  // CLARIFY-for-code ask, never a guessed validity answer.
  //
  // inv.18 v2 / R2-S9 — the coupon NOUN marker is generated; the apply/modal/validity
  // discrimination stays inside `isCouponValidityAsk`. The class key is the generated
  // `spanClass`.
  //
  // F-13 — the boolean is computed ABOVE (it gates the schedule span too) and from
  // the RAW `text`, which is also what fixed the measured span/render divergence on
  // ALL-CAPS codes: this call used to pass the lowercased `t`, so "cupom
  // FRETEGRATIS?" produced NO span here while the render seam's raw-text call to the
  // same predicate said `true`.
  if (couponValidityAsk) {
    classes.push(COUPON_VALID_CLOSURE.spanClass);
  }

  // LE2-029 — a PAIRING / SUBSTITUTION question. Gated on `!mutationImperative`
  // like every other classify-only-eligible READ span: "põe uma farofa junto do
  // brisket" is an add, not a question about what goes with what. The resolver
  // applies the SAME `classifyPairingAsk` net to pick which relation was asked
  // about, so the span and the read can never disagree about the question (the
  // BKL-184 / LE2-002 one-net idiom). Over-inclusion is DEMOTE-ONLY safe: an
  // utterance naming no item the graph knows resolves to the honest UNKNOWN,
  // never a guessed suggestion.
  //
  // inv.18 v2 / R2-S9 — both relation MARKERS are generated (and ORDERED: see the
  // ordered-arm contract above `PAIRING_SPAN_SUBSTITUTION_ARM`). The class key is the
  // generated `spanClass`.
  if (!mutationImperative && isPairingAsk(t)) {
    classes.push(MENU_PAIRINGS_CLOSURE.spanClass);
  }

  // Precise discriminators that DISAMBIGUATE the polysemous "status" (A's F2 fix —
  // do NOT regress to a coarse `/pedido|cad[êe]|status/` rule that misroutes a
  // payment "status" to ORDER-only).
  //
  // BKL-204 — a CAPABILITY / POLICY question about what the restaurant OFFERS
  // ("vocês entregam no CEP X?", "aceitam vale-refeição?", "quanto custa a
  // entrega?") mentions delivery/payment vocabulary but is NOT about the
  // customer's OWN order/payment. Without a SELF-REFERENCE (a possessive or an
  // explicit order number) it must NOT force the owner-scoped ORDER/PAYMENT read —
  // for a ≥2-order customer that dead-ends in the candidates CLARIFY. Only the two
  // DUAL-USE tokens carry the over-match: "entrega" (order) and "pix" (payment);
  // every STRONG status token (`pedido`, `pago`, `pagamento`, `sa[ií]u`, `chegou`,
  // `cad[êe]`, …) is unambiguously about an EXISTING order/payment and fires as
  // before. A false positive only costs the model path (never a wrong render).
  // A SELF-REFERENCE is a possessive attached to an order/payment/delivery NOUN
  // ("meu pedido", "minha entrega", "meu pagamento") or an explicit order number —
  // NOT any bare possessive ("minha região" is a coverage question, not the
  // customer's order). It disables the capability guard so a genuine self-status
  // ask with a dual token still fires.
  const selfReference = isSelfResourceReference(t);
  const capabilityQuestion =
    !selfReference &&
    /voc[êe]s\s+(entregam|aceit\w*|fazem)|fazem\s+entrega|entregam?\s+(em|no|na|pra|para|at[ée])|aceit\w*\s+(vale|ticket|refei|cart|pix|dinheiro|pagamento|d[ée]bito|cr[ée]dito)|quais?\s+(as\s+|os\s+)?(formas?|op[çc][õo]es)\s+de\s+pagamento|quanto\s+(custa|fica|sai|[ée]|vale)\s+(a\s+entrega|o\s+frete)|taxa\s+de\s+entrega|valor\s+d[oa]\s+(entrega|frete)/.test(
      t,
    );
  // STRONG status tokens — unambiguously about an EXISTING order/payment, fire
  // regardless of the capability shape. `pagamento` is strong EXCEPT in "formas /
  // opções de pagamento" (a payment-METHODS acceptance question — a capability),
  // where it names the concept, not the customer's payment.
  const paymentMethodsQuestion = /(formas?|op[çc][õo]es)\s+de\s+pagamento/.test(t);
  // inv.18 v2 / R2-S7 — the STRONG-token nets for both status spans are now GENERATED from
  // the def sources. `markers.some((m) => m.test(t))` is character-for-character the
  // disjunction each of these lines used to spell:
  //
  //   - ORDER: EIGHT arms, three provenances. Arms 1-5 are the flat
  //     `/pedido|preparo|sa[ií]u|chegou|cad[êe]/` literal SPLIT at its top-level alternation;
  //     arms 6-7 are the BKL-221 arrival pair, which were ALREADY separate literals `||`-ed
  //     here (the R2-S4 relocation-with-no-split case); arm 8 is the composed arrival-ETA net,
  //     still composed from its four named parts inside the source. Pinned by
  //     `__SPAN_NET_SOURCES_FOR_TEST.orderStatusStrong` (the 5-arm rejoin), `.orderArrival`
  //     (arms 6-7 rejoined) and `.orderEta` (arm 8), each against the pre-migration value.
  //   - PAYMENT: FIVE arms, the flat `/pago|cobran[çc]a|pagar|paguei|aprovad/` literal split
  //     at its top-level alternation. Pinned by
  //     `__SPAN_NET_SOURCES_FOR_TEST.paymentStatusStrong`.
  //
  // WHAT DID NOT MOVE, and why: everything on these spans that is a GUARD rather than a
  // marker. The two DUAL-USE tokens below (`entrega`, `pix`) and the `pagamento` token each
  // classify only in CONJUNCTION with the ABSENCE of a capability/payment-methods frame, and a
  // `markers` arm cannot express an absence — folding any of them in as a bare arm would fire
  // an owner-scoped read on a store-policy question (the BKL-204 defect, and BKL-238/SCN-049
  // from the other side). `!mutationImperative`, the bare-"status" fallback and the history
  // splices are likewise guards/sequencing. The compiler models which markers classify INTO a
  // span, never which contexts must suppress it.
  const orderStatusStrong = ORDER_FULFILLMENT_STAGE_CLOSURE.markers.some((m) => m.test(t));
  const paymentStatusStrong =
    PAYMENT_STATUS_CLOSURE.markers.some((m) => m.test(t)) ||
    (/pagamento/.test(t) && !paymentMethodsQuestion);
  // DUAL-USE tokens (also capability vocabulary) fire status ONLY when this is NOT
  // a capability question.
  const orderPhrasing = orderStatusStrong || (/entrega/.test(t) && !capabilityQuestion);
  const paymentPhrasing = paymentStatusStrong || (/pix/.test(t) && !capabilityQuestion);

  // BKL-206 — an imperative ORDER/PAYMENT MUTATION ("cancela meu pedido") must
  // route to the model/mutation path, never ride the owner-scoped STATUS read
  // spans (the read-span-captures-mutation class #349 closed for cart/menu,
  // applied here to the status spans via the same shared `mutationImperative`
  // net). Genuine status asks carry no mutation verb, so they fire unchanged.
  if (orderPhrasing && !mutationImperative) {
    classes.push(ORDER_FULFILLMENT_STAGE_CLOSURE.spanClass);
  }
  if (paymentPhrasing && !mutationImperative) {
    classes.push(PAYMENT_STATUS_CLOSURE.spanClass);
  }

  // FE-T17 — reservation-bearing phrasing. An explicit marker set (not folded into the
  // bare-"status" polysemy resolution below — reservation questions name "reserva"
  // directly, unlike the order/payment "status" ambiguity this file's F2 fix
  // disambiguates).
  //
  // inv.18 v2 / R2-S4 — the two marker regexes are GENERATED from
  // `./claimdefs/reservation-status.claim.ts`, and the FE-T17 / BKL-219/224 anchoring
  // rationale (the preserv* and "reservatório" false-positive closes on arm 1; the
  // both-sides anchoring of the `mesa` synonym on arm 2) moved verbatim into that
  // source. This is the one marker migration with NO alternation-splitting step: the two
  // arms were ALREADY separate regex literals combined with `||`, and
  // `markers.some((m) => m.test(t))` is that same predicate. Both arms stay pinned
  // byte-for-byte by `__SPAN_NET_SOURCES_FOR_TEST.reservationStatus`.
  //
  // BKL-217 — EXCLUDE reservation MUTATIONS via the shared `mutationImperative`
  // net (the same read-vs-mutation split #349/BKL-201 applied to the cart span
  // and BKL-206 to the order/payment status spans). This GUARD is NOT part of the
  // generated contribution — the compiler models markers, not suppression contexts —
  // and stays here. RESERVATION_STATUS is classify-only-eligible, so without this gate
  // "cancela minha reserva" / "muda minha reserva para 20h" fire RESERVATION_STATUS_Q →
  // classify-only answers the READ and SILENTLY DROPS the reservation.cancel /
  // reservation.modify (the reservation sibling of the BKL-201 hole — live-caught: a
  // seeded-reservation "cancelar minha reserva das 18:30" degraded to "não encontrei"
  // with zero adjudication). Gating on `!mutationImperative` routes those to the model /
  // mutation path; a genuine reservation QUESTION ("minha reserva está confirmada?",
  // "qual minha reserva?") has no mutation verb and still fires. A how-to interrogative
  // ("como cancelo minha reserva?") also routes to the model for a helpful answer — the
  // fail-SAFE direction (never a wrong read).
  //
  // Hoisted to a const so the bare-"status" fallback below can de-shadow a
  // reservation-status ask (BKL-224) off the SAME predicate.
  const reservationRef = RESERVATION_STATUS_CLOSURE.markers.some((m) => m.test(t));
  if (!mutationImperative && reservationRef) {
    classes.push(RESERVATION_STATUS_CLOSURE.spanClass);
  }

  // BKL-139 — a cart-CONTENTS question ("o que tem no meu carrinho?", "minha sacola").
  // ANCHORED to a word boundary (never mid-word) and EXCLUDING cart-MUTATION verbs
  // (the shared `mutationImperative` net above), so this fires ONLY on a cart-READ,
  // never a cart write. The exclusion is load-bearing: classify-only would otherwise
  // skip the model path for a mutation turn ("adicione uma coca ao carrinho", "tira o
  // refrigerante do carrinho" — BKL-201) and mis-frame it as a read. The
  // read-vs-mutation split is the BKL-153 must-not-fire discipline (verified against
  // must-fire + must-not-fire word lists in required-claim-decomposer.test.ts). A
  // gratitude / order-status turn contains no cart word, so it is untouched.
  //
  // inv.18 v2 / R2-S6 — the MARKER is now GENERATED from `./claimdefs/cart-contents.claim.ts`.
  // ONE arm: the pre-migration `cartRef` const was a SINGLE regex literal, so
  // `markers.some((m) => m.test(t))` is that same `.test(t)` — the relocation-with-no-split
  // case (the R2-S4 disposition, at arm count one), pinned byte-for-byte by
  // `__SPAN_NET_SOURCES_FOR_TEST.cartContents`. The `!mutationImperative` GUARD is NOT part
  // of the generated contribution and stays here: the compiler models which markers classify
  // INTO a span, never which contexts must suppress it.
  const cartRef = CART_CONTENTS_CLOSURE.markers.some((m) => m.test(t));
  if (cartRef && !mutationImperative) classes.push(CART_CONTENTS_CLOSURE.spanClass);

  // Bare "status" with NO payment/order discriminator → over-include BOTH (never
  // silently drop either companion). If a discriminator is present, the precise
  // branch above already routed it; we add nothing here to avoid the old misroute.
  // BKL-206 — an imperative mutation ("cancela") never rides the status reads,
  // even via the bare-"status" fallback (routes to the model/mutation path).
  // BKL-224 — a RESERVATION-status ask ("qual o status da minha reserva?") already
  // fired RESERVATION_STATUS_Q above; `!reservationRef` keeps the bare-"status"
  // fallback from ALSO over-including ORDER/PAYMENT, which shadowed the reservation
  // read into the ≥2-owned order candidates CLARIFY (live-caught).
  if (
    /status/.test(t) &&
    !mutationImperative &&
    !paymentPhrasing &&
    !orderPhrasing &&
    !reservationRef
  ) {
    // inv.18 v2 / R2-S7 — the two class KEYS are now the generated `spanClass` values, but
    // this whole branch stays HAND-WRITTEN: it fires on the ABSENCE of all three
    // discriminators, so it reads three OTHER spans' predicates and pushes a class from
    // outside either type's own marker net. That is a sequencing fact about this function, not
    // a per-type facet a source can project.
    const orderSpan = ORDER_FULFILLMENT_STAGE_CLOSURE.spanClass;
    const paymentSpan = PAYMENT_STATUS_CLOSURE.spanClass;
    if (!classes.includes(orderSpan)) classes.push(orderSpan);
    if (!classes.includes(paymentSpan)) classes.push(paymentSpan);
  }

  // FE-D03 slice C — history/LIST phrasing ("meu histórico de pedidos", "meus últimos
  // pagamentos"). Fires on a plural/history marker and SUPPRESSES the co-fired singular
  // status span: a history ask is NOT a single-subject status ask, and leaving
  // ORDER_STATUS_Q/PAYMENT_STATUS_Q would force the ≥2-owned CLARIFY the list-shaped
  // type exists to REPLACE (the FE-D03 defect). A singular "cadê meu pedido" / "meu
  // pagamento foi aprovado?" carries no history marker → the singular stays untouched
  // (both directions pinned in the tests). "meus pedidos"/"meus pagamentos" trip the
  // order/payment phrasing above, so the suppression (not mere over-inclusion) is what
  // routes them to the history claim.
  // inv.18 v2 / R2-S5 — the MARKERS are now GENERATED from the def sources (each was one
  // flat top-level alternation, so the generated arms REJOIN to their literal
  // character-for-character — THREE arms for the order net, TWO for the payment net,
  // pinned by `__SPAN_NET_SOURCES_FOR_TEST.orderHistory` / `.paymentHistory` and
  // additionally arm-by-arm, since every net here contains `|`s inside its own groups).
  //
  // THE SPLICE IS NOT GENERATED and stays here. It is a SEQUENCING fact about this
  // function — it mutates the accumulated `classes` array and names the OTHER span's
  // class key (`ORDER_STATUS_Q` / `PAYMENT_STATUS_Q`, both GENERATED rows since R2-S7, read
  // here off their own closures rather than as string literals) — whereas a
  // def source contributes only its OWN span class, required set and markers. Same
  // division as every span GUARD conjunction since R2-S1: the compiler models which
  // markers classify INTO a span, never which classes a span must remove from the set.
  // The two splices are also ORDER-DEPENDENT on each other's index arithmetic when both
  // fire ("qual o status de tudo: meus pedidos e meus pagamentos?" → both singulars
  // removed, leaving `[ORDER_HISTORY_Q, PAYMENT_HISTORY_Q]`), which is precisely the kind
  // of fact that lives in an interpreter and not in data.
  //
  // F-8 — the two history spans now carry the SAME `!mutationImperative` conjunct every
  // other classify-only-eligible READ span in this function has carried since #349 /
  // BKL-201 (cart), BKL-206 (order/payment status) and BKL-217 (reservation status). They
  // were the outliers: the residual was recorded at R2-S5 in both def sources and left
  // open because adding a guard is a BEHAVIOUR change outside an adoption slice's remit.
  //
  // WHAT WAS OPEN. Both ORDER_HISTORY and PAYMENT_HISTORY are classify-only-eligible
  // (`classify-only-reads.ts` CLASSIFY_ONLY_ELIGIBLE_TYPES), so an unguarded history span
  // does not merely over-include — it hands the whole turn to the DETERMINISTIC route
  // with ZERO model call. Measured at fd589e10: `classifyRequestSpans("cancela meus
  // pedidos")` → `["ORDER_HISTORY_Q"]` and `classifyOnlyRequiredTypes("cancela meus
  // pedidos")` → `{ORDER_HISTORY}`, i.e. the turn answers the history READ and the
  // order.cancel is SILENTLY DROPPED — exactly the read-span-captures-mutation shape
  // those three tickets closed elsewhere, on the one span family they did not cover. The
  // singular sibling already declines: `classifyOnlyRequiredTypes("cancela meu pedido")`
  // → undefined, because ORDER_STATUS_Q is guarded. That asymmetry is what this closes.
  //
  // WHY THE GUARD IS ON THE `if` AND NOT THE `Ref` CONST: the const is the GENERATED
  // marker predicate (pinned byte-for-byte by `__SPAN_NET_SOURCES_FOR_TEST.orderHistory` /
  // `.paymentHistory`) and must keep meaning exactly "the marker net matched". The guard
  // is a SUPPRESSION CONTEXT — the R2-S1 division this block's own header states — so it
  // sits at the push, in the identical shape as the status twins above
  // (`if (orderPhrasing && !mutationImperative)`).
  //
  // THE SPLICE IS UNAFFECTED. Under `mutationImperative` the singular sibling was never
  // pushed in the first place (ORDER_STATUS_Q / PAYMENT_STATUS_Q are gated on the same
  // boolean at BKL-206, and so is the bare-"status" fallback), so the branch this guard
  // now skips had nothing to splice — verified: the pre-change output for "cancela meus
  // pedidos" is `["ORDER_HISTORY_Q"]`, with no ORDER_STATUS_Q present.
  //
  // FALSE-POSITIVE COST, measured over a 6857-utterance harvest of every pt-BR string in
  // apps/ + packages/ (source, tests and corpora): 49 utterances fire a history span and
  // exactly TWO of them carry a mutation imperative — "cancela meus pedidos" and "cancela
  // meus pagamentos", which are F-8's own filed examples. The other 47 are unchanged. The
  // BKL-271 `cancel(?!ad)` lookahead is what keeps the participle READS ("meus pedidos
  // foram cancelados?", "meus últimos pedidos estão cancelados?") on this span. A
  // genuinely mixed turn now takes the model path — this file's stated FAIL-SAFE
  // direction: mild inefficiency, never a wrong render.
  const orderHistoryRef = ORDER_HISTORY_CLOSURE.markers.some((m) => m.test(t));
  const paymentHistoryRef = PAYMENT_HISTORY_CLOSURE.markers.some((m) => m.test(t));
  if (orderHistoryRef && !mutationImperative) {
    classes.push(ORDER_HISTORY_CLOSURE.spanClass);
    const i = classes.indexOf(ORDER_FULFILLMENT_STAGE_CLOSURE.spanClass);
    if (i !== -1) classes.splice(i, 1);
  }
  if (paymentHistoryRef && !mutationImperative) {
    classes.push(PAYMENT_HISTORY_CLOSURE.spanClass);
    const i = classes.indexOf(PAYMENT_STATUS_CLOSURE.spanClass);
    if (i !== -1) classes.splice(i, 1);
  }

  return classes;
}

/** Is `value` a recognized, in-table span-class? Pure. */
export function isSpanClass(value: unknown): value is SpanClass {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(REQUIRED_CLAIM_CLOSURE, value)
  );
}

/**
 * The FIRST-PARTY, owner-scoped ACTIVE-RESOURCE signal for THIS turn's customer
 * (#8 — ownership-aware required companions). It answers the ONLY two questions
 * the decomposer needs to stop forcing a companion the customer cannot possibly
 * have:
 *
 *   - `hasActiveOrder`   — the customer OWNS ≥1 active order this turn.
 *   - `hasActivePayment` — the customer OWNS ≥1 active payment row this turn.
 *
 * WHY (the #8 over-inclusion bug): forcing `ORDER_FULFILLMENT_STAGE` /
 * `PAYMENT_STATUS` as a required companion FROM A KEYWORD degrades a legitimately-
 * VALIDATED answer when the customer has no such resource — the companion can only
 * resolve ABSENT/UNKNOWN/REFUSED, so the completeness gate demotes the turn to a
 * proposition-free UNKNOWN (#8a: a GUEST's pickup-phrased hours question loses its
 * VALIDATED store-hours answer to a forced ORDER companion; #8b: a bare "status"
 * from a customer with NO active payment row loses its order-status answer to a
 * forced PAYMENT companion). A companion about a resource that PROVABLY does not
 * exist hides NOTHING — there is no "easy half" to leak — so requiring it is pure
 * loss.
 *
 * SOUNDNESS + FAIL-CLOSED CONTRACT (load-bearing — do NOT weaken):
 *   - A field is `false` ONLY on a POSITIVE first-party determination that the
 *     resource does NOT exist for THIS customer (e.g. an owner-scoped
 *     `listActiveOrderIds(customerId)` returned empty; a guest owns nothing).
 *     `false` is the ONLY value that DROPS a companion.
 *   - On ANY uncertainty (a read error, an unknown/absent signal) the caller MUST
 *     pass `true` — or omit the whole `ownership` argument — so the companion is
 *     KEPT: the decomposer stays over-including / demote-only under doubt. NEVER
 *     derive this from the model, from customer free-text, or from the planner's
 *     `perClaim` verdicts — an ABSENT `perClaim` entry cannot be distinguished
 *     from a non-existent resource, which reintroduces the exact "render the easy
 *     half" ambiguity this whole stage exists to close.
 *   - The signal must be OWNER-SCOPED first-party (IDOR-safe): keyed only by the
 *     authenticated `customerId`, never by a model-extracted / cross-owner id.
 */
export interface ActiveResourceOwnership {
  /** Customer OWNS ≥1 active order this turn (positive first-party fact). */
  readonly hasActiveOrder: boolean;
  /** Customer OWNS ≥1 active payment row this turn (positive first-party fact). */
  readonly hasActivePayment: boolean;
}

/**
 * Maps each OWNERSHIP-GATED required claim type to the {@link ActiveResourceOwnership}
 * flag that must hold for it to STAY required. A required type NOT in this map
 * (e.g. `STORE_OPEN_NOW` — PUBLIC first-party config, owned by nobody) is NEVER
 * gated: it stays required whenever its span-class matches (so a guest's pickup /
 * hours question still requires — and can still render — the store-open answer).
 */
const OWNERSHIP_GATED_TYPES = {
  ORDER_FULFILLMENT_STAGE: "hasActiveOrder",
  PAYMENT_STATUS: "hasActivePayment",
} as const satisfies Partial<Record<RegistryClaimType, keyof ActiveResourceOwnership>>;

/**
 * DECOMPOSE the request's span-classes into the MANDATORY required-claim-type set
 * (SDD §O#15). CONSERVATIVE-OVER-DECOMPOSING: the result is the UNION over every
 * recognized class — over-including companions, never under-including. An
 * unrecognized class contributes nothing (the planner's own P4/§O#9 nets handle
 * it; this stage only ADDS required companions, never suppresses). Deterministic
 * + order-stable. Pure.
 *
 * `ownership` (#8) — the OPTIONAL first-party {@link ActiveResourceOwnership}
 * signal. When supplied, an ownership-gated companion ({@link OWNERSHIP_GATED_TYPES}
 * — `ORDER_FULFILLMENT_STAGE` / `PAYMENT_STATUS`) is DROPPED from the required set
 * iff its flag is a POSITIVE `false` (the customer PROVABLY has no such active
 * resource). It is sound: a companion about a non-existent resource can never
 * validate and hides nothing. When `ownership` is omitted (the default — the signal
 * is not yet threaded to this layer; see DEFER note below) or a flag is `true`,
 * NOTHING is dropped and the behavior is byte-identical to the pre-#8 over-including
 * decomposer.
 *
 * The required set SHRINKS in exactly TWO demote-only places: this ownership gate,
 * and the BKL-152 DATE-ANCHOR suppression below (a date-specific hours question drops
 * the STORE_OPEN_NOW "is it open right now" companion). Both only REMOVE a companion
 * that cannot soundly be required — neither adds a claim or prose authority.
 */
/**
 * F-12 — THE SCHEDULE CLUSTER'S DECOMPOSITION IS CLOCK-FREE, BY CONTRACT.
 *
 * This function is the SINGLE declared source for "what does a schedule ask
 * REQUIRE", consumed by every side of the turn: the claim planner's BKL-110
 * relevance filter + BKL-289 union (`ibatexas-claim-planner.ts`), the
 * deterministic classify-only eligibility gate (`classify-only-reads.ts`), and
 * the renderer's §O#15 completeness gate (`claims-renderer-adapter.ts`).
 *
 * It TAKES NO CLOCK, and that is the load-bearing property rather than an
 * implementation detail. Between BKL-152-edge (@claustrum/core 0.8.0) and F-12
 * it took an OPTIONAL `DateAnchorSignal`, and the three callers passed three
 * DIFFERENT things — the planner nothing (⇒ the pure #301 "always suppress"
 * arm), the renderer's gate the adopter's clock-resolved date (⇒ the
 * clock-aware arm), classify-only a seam-active signal with no date. One shared
 * function is NOT one shared answer when an optional input selects the arm: on
 * the day a named weekday resolved to TODAY the gate KEPT the STORE_OPEN_NOW
 * companion that the planner had already been told to SUPPRESS, so completeness
 * found it ABSENT and degraded an answerable turn to a proposition-free UNKNOWN
 * — a once-a-week loss of a question the reads had already answered (measured
 * on all three paths; pinned in `__tests__/r2s8-hours-for-date-claims.e2e.test.ts`).
 *
 * Removing the parameter is what makes that disagreement STRUCTURALLY
 * IMPOSSIBLE: with no clock input there is nothing for two callers to disagree
 * about. The surviving rule is the original #301 one, applied uniformly — a
 * date-SPECIFIC hours question does not semantically require "is it open right
 * now", and that judgement never depended on which day is being named.
 *
 * SOUNDNESS is unchanged and demote-only: this REMOVES a required companion, it
 * never adds a claim, sets a verdict, or grants prose authority. Every rendered
 * proposition still maps 1:1 to an independently-VALIDATED claim (Inv 6).
 * STORE_OPEN_NOW stays required wherever it is genuinely a half of the question:
 * PICKUP_Q (you can only collect from an OPEN store) and every bare/"hoje"
 * open-now ask, neither of which fires STORE_HOURS_FOR_DATE_Q.
 */
export function decomposeRequiredClaims(
  spanClasses: readonly string[],
  ownership?: ActiveResourceOwnership,
): ReadonlySet<RegistryClaimType> {
  const required = new Set<RegistryClaimType>();
  for (const cls of spanClasses) {
    if (!isSpanClass(cls)) continue; // unrecognized → no forced companion.
    for (const t of REQUIRED_CLAIM_CLOSURE[cls]) required.add(t);
  }

  // #8 OWNERSHIP GATE — drop a companion ONLY on a POSITIVE first-party `false`
  // (the resource provably does not exist for this customer). Undefined ownership
  // or a `true` flag keeps the companion (over-include / demote-only under doubt).
  if (ownership !== undefined) {
    for (const type of Object.keys(
      OWNERSHIP_GATED_TYPES,
    ) as (keyof typeof OWNERSHIP_GATED_TYPES)[]) {
      if (ownership[OWNERSHIP_GATED_TYPES[type]] === false) required.delete(type);
    }
  }

  // BKL-152 — DATE-ANCHOR companion suppression (SCN-002 blocker). A DATE-ANCHORED
  // hours question ("que horas vocês abrem amanhã?", "qual o horário de domingo?")
  // trips STORE_HOURS_FOR_DATE_Q, but its "horário"/"abrem"/"que horas" wording ALSO
  // trips STORE_OPEN_NOW_Q (the generated store-open-now markers). The required set
  // would then demand the TODAY open-now companion the planner never resolves for a
  // FUTURE-date question, completeness-degrading an otherwise-VALIDATED
  // STORE_HOURS_FOR_DATE render to UNKNOWN (the live-proven defect). A date-SPECIFIC
  // hours question does NOT semantically require "is it open right now", so SUPPRESS
  // the STORE_OPEN_NOW companion when a date-for span is present. DEMOTE-ONLY: this
  // REMOVES a required companion (never adds a claim or prose authority) — the
  // date-specific hours still render; suppression can never create a lie.
  //
  // GUARDS (why this keeps STORE_OPEN_NOW for the open-now-relevant cases):
  //   - PICKUP_Q ABSENT: a pickup question ("que horas posso retirar amanhã?")
  //     genuinely requires STORE_OPEN_NOW (you can only pick up from an OPEN store) —
  //     when PICKUP_Q is present, keep the companion.
  //   - "hoje"/undated questions never fire STORE_HOURS_FOR_DATE_Q at all (the
  //     date-anchor regex is weekday|amanhã|feriado, NOT "hoje"), so STORE_OPEN_NOW
  //     stays for "que horas abrem hoje?" and bare "vocês estão abertos?" — no clock
  //     is needed here to keep the today/undated open-now companion.
  //
  // F-12 — UNCONDITIONAL, and the unconditionality is the fix. This used to branch
  // on a clock-resolved `DateAnchorSignal`, KEEPING the companion when the named
  // weekday resolved to TODAY. That arm is gone: it was the only place where two
  // callers of this one function could compute two different required sets for the
  // same utterance, and it bought a "relevant" companion at the price of the whole
  // answer (see this function's header for the measured degrade). "Relevant" is not
  // "required" — §O#15 exists to stop HALF a question being answered, and a named
  // day's opening hours are the WHOLE of "que horas vocês abrem segunda?".
  //
  // Suppression is DEMOTE-ONLY on the REQUIREMENT, never on the claim: nothing here
  // forbids STORE_OPEN_NOW from being proposed, validated or rendered — it only stops
  // completeness from DEMANDING a companion this turn shape does not deliver.
  if (
    spanClasses.includes("STORE_HOURS_FOR_DATE_Q") &&
    !spanClasses.includes("PICKUP_Q")
  ) {
    required.delete("STORE_OPEN_NOW");
  }

  return required;
}

/**
 * The terminal disposition (after CLAIMS-VALIDATE) of one required claim type, as
 * the completeness check sees it:
 *   - a three-valued `ClaimVerdict` the kernel produced for that type, OR
 *   - `"ABSENT"` — the required type produced NO claim at all this turn (the
 *     planner never proposed it / it was dropped). ABSENT is the §O#15 hole this
 *     stage exists to catch: a required companion that simply did not appear.
 */
export type RequiredClaimResolution = ClaimVerdict | "ABSENT";

/** The result of the §O#15 required-set completeness check. */
export interface RequiredCompletenessResult {
  /**
   * Every required type RESOLVED to VALIDATED — the turn may render in full. The
   * turn must DEGRADE (a required companion is not VALIDATED) exactly when this is
   * `false` (equivalently `unsatisfied.length > 0`); callers derive "degrade" as
   * `!complete` rather than reading a redundant second boolean.
   */
  readonly complete: boolean;
  /** The required types that are NOT VALIDATED (ABSENT / UNKNOWN / REFUSED). */
  readonly unsatisfied: readonly RegistryClaimType[];
}

/**
 * BKL-163 (reopened) — PRESENCE-COMPLEMENT PAIRS. Each pair reads COMPLEMENTARY
 * evidence keys off the SAME owner-scoped read (`cart_contents:` vs `cart_empty:` —
 * exactly one is PRESENT after a successful cart read), so BY CONSTRUCTION exactly
 * one member can ever VALIDATE in a turn. Requiring both (the CART_CONTENTS_Q
 * closure row) therefore made completeness STRUCTURALLY unsatisfiable — every cart
 * turn, empty or full, degraded RENDER→UNKNOWN (the live SCN-030 non-render).
 *
 * A pair member's requirement is SATISFIED when its partner VALIDATED: the two are
 * mutually-exclusive dispositions of ONE underlying fact, so rendering the
 * validated member omits nothing — the §O#15 "render the easy half" hole needs an
 * INDEPENDENT companion fact, which a presence-complement partner is not. Types
 * outside this list keep the strict every-type-VALIDATED rule unchanged.
 *
 * R2-S9 — EXPORTED (additive; no runtime consumer outside this module) so the
 * shared-closure-row AGREEMENT can be pinned structurally in
 * `./claimdefs/__tests__/generated-drift.test.ts`. That pin exists because the generic
 * INV-4 cannot supply it for three of these four pairs: INV-4's forward direction obliges
 * TRIAD-SCOPED types only, and only the CART pair is Triad-scoped. MEASURED against the
 * real validator — a `requires` that drops CART_EMPTY is `DECOMPOSITION_UNREACHABLE`,
 * while dropping DELIVERY_NO_COVERAGE / COUPON_INVALID / MENU_SUBSTITUTIONS from their rows
 * is `{ ok: true }`. Quantifying over THIS table rather than a hand-listed pair list is
 * what makes a future pair inherit the check by registering here.
 */
export const PRESENCE_COMPLEMENT_PAIRS: ReadonlyArray<
  readonly [RegistryClaimType, RegistryClaimType]
> = [
  ["CART_CONTENTS", "CART_EMPTY"],
  // LE2-013 — the DELIVERY pair belongs here and was MISSED by LE2-002, which
  // built it "on the CART_CONTENTS/CART_EMPTY precedent" (its own commit message)
  // and gave DELIVERY_COVERAGE_Q a closure row requiring BOTH members, but never
  // registered the pair. The investigator records `delivery:coverage` only when a
  // zone matched and `delivery:no_coverage` only on a POSITIVE out-of-zone
  // determination, so exactly one can ever VALIDATE — which made completeness
  // STRUCTURALLY unsatisfiable and degraded EVERY coverage turn RENDER→UNKNOWN.
  // Byte-for-byte the BKL-163 cart bug, reproduced.
  //
  // WHY IT SURVIVED CI: LE2-002's turn-seam tests call `renderer-from-claims`
  // `render(...)` DIRECTLY, which bypasses this gate — the gate lives one layer up
  // in `claims-renderer-adapter.ts`. The defect only shows through the PRODUCTION
  // adapter, which is what LE2-013's ops turn-seam suite drives, and is where it
  // was caught. It is plane-NEUTRAL: the customer plane was equally affected, so
  // the fix lands here rather than being forked onto ops.
  ["DELIVERY_COVERAGE", "DELIVERY_NO_COVERAGE"],
  // LE2-019 — the COUPON pair, registered HERE IN THE SAME COMMIT that introduces
  // it. `coupon:valid` is recorded only when a SUCCESSFUL promotion lookup found a
  // usable record; `coupon:invalid` only when a SUCCESSFUL lookup positively
  // determined the code is not usable — complementary by construction, so exactly
  // one can ever VALIDATE and the COUPON_VALIDITY_Q closure row (which requires
  // BOTH) is satisfiable only because of this line. Omitting it is precisely the
  // LE2-002 latent defect documented above: every coupon turn, valid or invalid,
  // would degrade RENDER→UNKNOWN through the §O#15 gate one layer up in
  // `claims-renderer-adapter.ts` — invisible to any renderer-level test.
  ["COUPON_VALID", "COUPON_INVALID"],
  // LE2-029 — the PAIRING pair, registered HERE IN THE SAME COMMIT that
  // introduces it (the standing lesson above, applied rather than relearned).
  // `menu:pairings` is recorded only when the utterance asked about `pairs-with`
  // AND the graph had edges whose objects exist live; `menu:substitutions` only
  // for the `substitutes-for` ask — complementary by construction, so exactly one
  // can ever VALIDATE and the PAIRING_Q closure row (which requires BOTH) is
  // satisfiable only because of this line.
  ["MENU_PAIRINGS", "MENU_SUBSTITUTIONS"],
];

/** Partner lookup for {@link PRESENCE_COMPLEMENT_PAIRS} (symmetric). */
function presenceComplementPartner(type: RegistryClaimType): RegistryClaimType | undefined {
  for (const [a, b] of PRESENCE_COMPLEMENT_PAIRS) {
    if (type === a) return b;
    if (type === b) return a;
  }
  return undefined;
}

/**
 * The P4 COMPLETENESS check quantified over the REQUIRED set (SDD §O#15) — NOT the
 * planner's chosen candidates. `resolved` maps each produced claim type to its
 * kernel verdict; any required type absent from the map is treated as `"ABSENT"`.
 *
 * A required companion resolving ABSENT / UNKNOWN / REFUSED DEGRADES the turn —
 * the turn must NOT render the literal-true subset while silently omitting the
 * companion (the §O#15 "render the easy half" hole). `complete` is `true` IFF
 * EVERY required type is VALIDATED — except a {@link PRESENCE_COMPLEMENT_PAIRS}
 * member, whose requirement is ALSO satisfied by its partner validating (exactly
 * one of the pair can ever validate; see the pair doc above). Pure; order-stable
 * over the required set's insertion order.
 */
export function checkRequiredClaimCompleteness(
  required: ReadonlySet<RegistryClaimType>,
  resolved: ReadonlyMap<string, ClaimVerdict>,
): RequiredCompletenessResult {
  const unsatisfied: RegistryClaimType[] = [];
  for (const type of required) {
    const verdict: RequiredClaimResolution = resolved.get(type) ?? "ABSENT";
    if (verdict === "VALIDATED") continue;
    const partner = presenceComplementPartner(type);
    if (partner !== undefined && resolved.get(partner) === "VALIDATED") continue;
    unsatisfied.push(type);
  }
  return { complete: unsatisfied.length === 0, unsatisfied };
}
