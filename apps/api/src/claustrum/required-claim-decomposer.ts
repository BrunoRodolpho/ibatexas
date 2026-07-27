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
// inv.18 v2 — STORE_OPEN_NOW's closure row (span class + required companions) AND its
// pt-BR span markers are GENERATED from its ClaimDefinition source by the
// claimdef-compiler (./claimdefs/store-open-now.generated.ts — DO NOT EDIT). The
// previously-handwritten closure entry + the marker regex collapse into these splices.
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
  // BKL-138 — a day-specific hours question requires the date-hours claim. This row
  // ALSO auto-enrols STORE_HOURS_FOR_DATE into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES (ibatexas-claim-planner.ts) via the closure-value union,
  // so an over-proposed date-hours claim is DEMOTED on a turn whose date-hours span did
  // not fire (the smalltalk-hijack guard) yet KEPT when it did.
  STORE_HOURS_FOR_DATE_Q: ["STORE_HOURS_FOR_DATE"],
  ORDER_STATUS_Q: ["ORDER_FULFILLMENT_STAGE"],
  PAYMENT_STATUS_Q: ["PAYMENT_STATUS"],
  // FE-T17 — a reservation-status question requires the reservation claim. This row
  // ALSO auto-enrols RESERVATION_STATUS into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES (ibatexas-claim-planner.ts BKL-110) via the closure-value
  // union, so an over-proposed reservation claim is DEMOTED on a turn whose
  // reservation span did not fire, yet KEPT when it did.
  RESERVATION_STATUS_Q: ["RESERVATION_STATUS"],
  // BKL-139 — a cart-contents question requires the cart claim. Like
  // RESERVATION_STATUS_Q, CART_CONTENTS is required ONLY by its own span (no unrelated
  // span force-requires it), so it also auto-enrols CART_CONTENTS into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES via the closure-value union (an over-proposed cart claim is
  // DEMOTED on a turn whose cart span did not fire, KEPT when it did).
  // BKL-163 — the row ALSO requires CART_EMPTY, the provable-empty complement:
  // the two claims read COMPLEMENTARY keys (`cart_contents:` vs `cart_empty:` —
  // exactly one is PRESENT after a successful owner-scoped cart read), so exactly
  // one validates and the other resolves honest UNKNOWN and is dropped by the
  // kernel's §D filter — never a rendered contradiction. Requiring both here is
  // what auto-enrols CART_EMPTY into the classify-only candidate set (an
  // empty-cart question deterministically frames the claim that CAN validate) and
  // into RELEVANCE_GOVERNED_TYPES (an over-proposed CART_EMPTY demotes on a
  // non-cart turn).
  CART_CONTENTS_Q: ["CART_CONTENTS", "CART_EMPTY"],
  // FE-D03 slice C — a history/list question requires its own list-shaped claim. Like
  // CART_CONTENTS_Q, each is required ONLY by its own span (no unrelated span
  // force-requires it), so it auto-enrols into the claim-planner RELEVANCE_GOVERNED_TYPES
  // via the closure-value union (over-proposed history claim demoted on a non-history turn).
  ORDER_HISTORY_Q: ["ORDER_HISTORY"],
  PAYMENT_HISTORY_Q: ["PAYMENT_HISTORY"],
  // BKL-142 — a menu question requires ONLY its own PUBLIC claim (no unrelated span
  // force-requires it; like CART_CONTENTS_Q / RESERVATION_STATUS_Q). An unresolvable
  // item → ABSENT evidence → honest UNKNOWN; it never demotes a co-occurring answer
  // beyond its own span. Public (`not_applicable`) → never Triad-scoped.
  MENU_ITEM_PRICE_Q: ["MENU_ITEM_PRICE"],
  MENU_ITEM_CONTENTS_Q: ["MENU_ITEM_CONTENTS"],
  // BKL-142 — a menu-WIDE overview question requires ONLY its own PUBLIC claim (like the
  // per-item menu spans). Empty catalog → ABSENT evidence → honest UNKNOWN; never demotes
  // a co-occurring answer. Public (`not_applicable`) → never Triad-scoped.
  MENU_OVERVIEW_Q: ["MENU_OVERVIEW"],
  // BKL-214 — a dietary-PREFERENCE question ("tem opção vegetariana?") requires the
  // MENU_DIETARY claim. Its own span, no unrelated span force-requires it, so it
  // auto-enrols into RELEVANCE_GOVERNED_TYPES like the other menu claims. Allergen-
  // adjacent diets (glúten/lactose) never reach this span (ALLERGEN_FAMILY_RE gate).
  MENU_DIETARY_Q: ["MENU_DIETARY"],
  // BKL-136 — a store-location/parking question requires ONLY its own PUBLIC claim
  // (like the menu spans). Absent/blank store metadata → ABSENT evidence → honest
  // UNKNOWN; never demotes a co-occurring answer. Public (`not_applicable`) → never
  // Triad-scoped.
  STORE_INFO_Q: ["STORE_INFO"],
  // LE2-002 / NEW-007 — a delivery-COVERAGE question requires the complementary
  // PAIR, exactly like CART_CONTENTS_Q requires CART_CONTENTS + CART_EMPTY. The two
  // read COMPLEMENTARY keys (`delivery:coverage` vs `delivery:no_coverage` — at most
  // one is ever PRESENT), so exactly one can validate and the other resolves honest
  // UNKNOWN and is dropped by the kernel's §D filter — never a rendered
  // contradiction. Requiring both here is also what auto-enrols the pair into the
  // classify-only candidate set and into the claim-planner's RELEVANCE_GOVERNED_TYPES
  // (an over-proposed coverage claim is DEMOTED on a turn whose coverage span did not
  // fire, KEPT when it did). PUBLIC (`not_applicable`) → never Triad-scoped, and no
  // unrelated span force-requires either type.
  DELIVERY_COVERAGE_Q: ["DELIVERY_COVERAGE", "DELIVERY_NO_COVERAGE"],
  // LE2-019 — a coupon-VALIDITY question requires the complementary PAIR, exactly
  // like DELIVERY_COVERAGE_Q. The two read COMPLEMENTARY keys (`coupon:valid` vs
  // `coupon:invalid` — at most one is ever PRESENT after a SUCCESSFUL lookup), so
  // exactly one can validate and the other resolves honest UNKNOWN and is dropped
  // by the kernel's §D filter — never a rendered contradiction. Requiring both
  // here is also what auto-enrols the pair into the classify-only candidate set
  // and into the claim-planner's RELEVANCE_GOVERNED_TYPES (an over-proposed coupon
  // claim is DEMOTED on a turn whose coupon span did not fire, KEPT when it did).
  // The pair is ALSO registered in PRESENCE_COMPLEMENT_PAIRS below — without that
  // registration this very row would make §O#15 completeness STRUCTURALLY
  // unsatisfiable (the LE2-002 defect; see the pair table's comment). PUBLIC
  // (`not_applicable`) → never Triad-scoped, and no unrelated span force-requires
  // either type.
  COUPON_VALIDITY_Q: ["COUPON_VALID", "COUPON_INVALID"],
  // LE2-029 — a pairing/substitution question requires the complementary PAIR, on
  // the COUPON_VALIDITY_Q shape. The resolver classifies the utterance as ONE ask
  // or the other and records at most one key, so exactly one can validate and the
  // other resolves honest UNKNOWN and is dropped by the kernel's §D filter — never
  // a rendered contradiction. Requiring both here is also what auto-enrols the
  // pair into the classify-only candidate set and into RELEVANCE_GOVERNED_TYPES.
  // The pair is ALSO registered in PRESENCE_COMPLEMENT_PAIRS below — without that
  // registration this row would make §O#15 completeness STRUCTURALLY unsatisfiable
  // (the LE2-002 defect). PUBLIC (`not_applicable`) → never Triad-scoped.
  PAIRING_Q: ["MENU_PAIRINGS", "MENU_SUBSTITUTIONS"],
  // §O#15 worked example — a pickup question requires BOTH companions.
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
const DELIVERY_COVERAGE_ASK_RE =
  /voc[êe]s\s+entregam|(?:faz|fazem)\s+entrega|entregam?\s+(?:em|no|na|nos|nas|pra|para|at[ée])(?![a-z])|(?:onde|at[ée]\s+onde)\s+(?:voc[êe]s\s+)?entregam|(?:[áa]rea|regi[õo]es?|regi[ãa]o|zona)\s+de\s+entrega|atende[m]?\s+(?:em|no|na|nos|nas)(?![a-z])|taxa\s+de\s+(?:entrega|frete)|(?:valor|pre[çc]o)\s+d[oa]\s+(?:entrega|frete)|quanto\s+(?:custa|fica|sai|[ée])\s+(?:a\s+entrega|o\s+frete)|quanto\s+tempo\s+(?:demora|leva)\s+(?:a\s+)?(?:entrega|pra\s+entregar)/;

/** LE2-002 — does this request text ask about DELIVERY COVERAGE (not the
 *  customer's own delivery)? Pure. Exported so the render seam can select the
 *  CLARIFY-for-CEP ask without a second, drifting regex (the BKL-184 idiom). */
export function isDeliveryCoverageAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (isSelfResourceReference(t)) return false;
  return DELIVERY_COVERAGE_ASK_RE.test(t);
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
 * deliberately NOT enough — "qual o código do meu pedido?" is an order question.
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
const COUPON_NOUN_RE =
  /(?<![a-z])(?:cupom|cupons|cup[ãa]o|vouchers?|c[óo]digos?\s+(?:de\s+)?(?:desconto|promo[çc][ãa]o|promocional))/;

/** Validity/usability phrasing — "vale?", "é válido?", "ainda funciona?", "tá valendo?" */
const COUPON_VALIDITY_PHRASE_RE =
  /(?<![a-z])(?:vale(?:m|ndo)?|v[áa]lid[oa]s?|validade|funciona(?:m|ndo)?|serve|ativ[oa]|expir|venceu|vencid[oa]|caduc|est[áa]\s+ok|t[áa]\s+ok|confer(?:e|ir)|checa(?:r)?)/;

/** An APPLY/USE IMPERATIVE aimed at a coupon — a MUTATION, never this read. */
const COUPON_APPLY_IMPERATIVE_RE =
  /(?<![a-z])(?:aplica(?:r|e)?|resgata(?:r)?|ativa(?:r)?|usa(?:r|e)?|coloca(?:r)?|p[õo]e|p[õo]r|adiciona(?:r)?|insere|inserir)\s+(?:o\s+|a\s+|esse\s+|este\s+|essa\s+|meu\s+|minha\s+)?(?:cupom|c[óo]digo|voucher|desconto)/;

/** A MODAL/interrogative frame that makes an apply-shaped verb a QUESTION. */
const COUPON_MODAL_QUESTION_RE =
  /(?<![a-z])(?:posso|consigo|d[áa]\s+(?:pra|para)|ser[áa]\s+que|quero\s+saber|gostaria\s+de\s+saber|como\s+(?:fa[çc]o|uso|usar))/;

// ── LE2-029: the PAIRING / SUBSTITUTION ask ──────────────────────────────────
// Pure regexes, defined HERE beside the other span nets and imported by
// `pairing-resolver.ts`, so the SPAN and the READ are the same judgement.

/**
 * SUBSTITUTION phrasing — "no lugar", "em vez de", "substitui", "troco por",
 * "acabou o X, e agora". Tested FIRST: "o que vai bem no lugar da costela"
 * carries both vocabularies but asks ONE question, and the customer's operative
 * word is the one saying they cannot have the thing they asked for. Pure.
 *
 * A genuine TWO-question utterance is a different case and is NOT resolved by
 * this precedence — see {@link isBothPairingAsk}.
 */
const SUBSTITUTION_PHRASE_RE =
  /(?<![a-z])(?:no\s+lugar|em\s+vez|ao\s+inv[ée]s|substitui(?:r|ção|cao)?|substitut[oa]s?|troc(?:o|ar|a)\s+por|parecid[oa]\s+com|similar\s+a|acabou|esgotad[oa]|sem\s+estoque|n[ãa]o\s+tem\s+mais)/;

/**
 * PAIRING phrasing — "combina", "vai bem", "acompanha", "harmoniza", "pedir
 * junto", "o que peço com". Pure.
 */
const PAIRING_PHRASE_RE =
  /(?<![a-z])(?:combina(?:m|ç[ãa]o|coes|ções)?|vai\s+bem|v[ãa]o\s+bem|acompanha(?:m|mento)?s?|harmoniza(?:m)?|junto\s+com|pedir\s+junto|pra\s+acompanhar|para\s+acompanhar|sugest[ãa]o|sugere|recomenda)/;

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
 * LE2-019 — does this request text ask whether a COUPON is valid? Pure. Exported
 * so the render seam can select the CLARIFY-for-code ask without a second,
 * drifting regex (the BKL-184 / LE2-002 idiom).
 */
export function isCouponValidityAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (!COUPON_NOUN_RE.test(t)) return false;
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
  // The net is spelled as TWO literals — the CART-EDIT roots and the ORDER-LIFECYCLE
  // roots — OR'd into the same `mutationImperative` boolean every span below gates
  // on, because the fused literal scored 28 on Sonar's regex-complexity budget of 20
  // (S5843). BOTH carry the same `(?<![a-z])` left guard, so the union of matched
  // strings is exactly what the single literal matched.
  const MUTATION_EDIT_ROOTS =
    /(?<![a-z])(adicion|acrescent|remov|tir|colo[cq]|p[õo]e|ponh|mud|tro[cq]|limp|esvazi|aument|diminu)/;
  const MUTATION_LIFECYCLE_ROOTS =
    /(?<![a-z])(cancel(?!ad)|fech(?!ad|ament|ou|am)|finaliz(?!ad))/;
  const mutationImperative =
    MUTATION_EDIT_ROOTS.test(t) || MUTATION_LIFECYCLE_ROOTS.test(t);

  if (/retir|buscar|pegar/.test(t)) classes.push("PICKUP_Q");
  // inv.18 v2 — the STORE_OPEN_NOW_Q markers are GENERATED from the def source
  // (replaces the previously-handwritten /abert|fechad|.../ regex — the runtime
  // image can no longer drift from the ClaimDefinition closure).
  if (STORE_OPEN_NOW_CLOSURE.markers.some((m) => m.test(t))) {
    classes.push(STORE_OPEN_NOW_CLOSURE.spanClass);
  }

  // BKL-138 — a DAY-SPECIFIC hours question (SCN-002/003). Fires ONLY on the
  // CONJUNCTION of a DATE ANCHOR (a named weekday / "amanhã" / "feriado") AND schedule
  // phrasing, so a bare "que horas funciona?" stays STORE_OPEN_NOW_Q-only and a greeting
  // that merely names a day ("bom domingo!") is NOT swept in. DEMOTE-ONLY safe:
  // over-inclusion only forces the STORE_HOURS_FOR_DATE companion; the resolver then
  // degrades honestly if no date is truly resolvable (a bare "feriado" with no anchor).
  const dateAnchor =
    /\b(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|amanh[ãa]|feriado)/.test(t);
  const scheduleContext =
    /hor[áa]rio|que horas|abre|abrem|abert|fecha|funciona|expediente|atend/.test(t);
  if (dateAnchor && scheduleContext) classes.push("STORE_HOURS_FOR_DATE_Q");

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
  const isMenuOverview =
    notOrderScoped &&
    !mutationImperative &&
    /\bcard[áa]pio\b|\bmenu\b|o que (voc[êe]s )?(t[êe]m|servem)( (pra|para) comer)?|quais (os |as )?(pratos|op[çc][õo]es)/.test(t);
  if (isMenuOverview) classes.push("MENU_OVERVIEW_Q");

  if (notOrderScoped && !mutationImperative && /quanto custa|quanto (custam|é|fica|sai|tá|ta)|qual (o |é o )?pre[çc]o|pre[çc]o d[aoe]/.test(t)) {
    classes.push("MENU_ITEM_PRICE_Q");
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
  if (notOrderScoped && !mutationImperative && !isMenuOverview && /o que (vem|tem|acompanha)|do que (é|e) (é |)feit|que vem (n|em)|composi[çc][ãa]o d/.test(t)) {
    classes.push("MENU_ITEM_CONTENTS_Q");
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
  if (
    notOrderScoped &&
    !mutationImperative &&
    /vegetarian[ao]?|\bvegan[ao]?\b/.test(t)
  ) {
    classes.push("MENU_DIETARY_Q");
  }

  // BKL-136 — a store-LOCATION/parking question ("onde fica o restaurante?", "qual o
  // endereço?", "tem estacionamento?", "como chegar?"). GUARDED away from the
  // order/delivery/cart/reservation/payment families: "onde fica meu PEDIDO" is an
  // order-status ask, and letting STORE_INFO validate there would render the
  // restaurant's address as a confident non-answer to a different question (a
  // VALIDATED claim is not demote-only — the guard must be precise, not
  // over-inclusive). A guarded miss degrades honestly (no span → no forced
  // companion; the planner's own nets still run).
  const notResourceScoped = !/pedido|entrega|frete|carrinho|reserva|pagamento/.test(t);
  if (
    notResourceScoped &&
    !mutationImperative &&
    /onde (fica|é|estão|est[áa]|se localiza)|endere[çc]o|localiza[çc][ãa]o|localizad|estacionamento|estacionar|como (chego|chegar)/.test(
      t,
    )
  ) {
    classes.push("STORE_INFO_Q");
  }

  // LE2-002 / NEW-007 — a delivery-COVERAGE question ("vocês entregam em Ibaté?",
  // "entregam no CEP 14815000?", "qual a taxa de entrega?"). Gated on
  // `!mutationImperative` like every other classify-only-eligible READ span (the
  // BKL-201/206 read-vs-mutation split), and DISJOINT from ORDER_STATUS_Q by the
  // shared self-reference guard inside `isDeliveryCoverageAsk` — "cadê MINHA
  // entrega?" stays an owner-scoped order question and never fires this span.
  // Over-inclusion is DEMOTE-ONLY safe: an unmatched place resolves to the
  // CLARIFY-for-CEP ask, never a guessed coverage answer.
  if (!mutationImperative && isDeliveryCoverageAsk(t)) {
    classes.push("DELIVERY_COVERAGE_Q");
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
  if (!mutationImperative && isCouponValidityAsk(t)) {
    classes.push("COUPON_VALIDITY_Q");
  }

  // LE2-029 — a PAIRING / SUBSTITUTION question. Gated on `!mutationImperative`
  // like every other classify-only-eligible READ span: "põe uma farofa junto do
  // brisket" is an add, not a question about what goes with what. The resolver
  // applies the SAME `classifyPairingAsk` net to pick which relation was asked
  // about, so the span and the read can never disagree about the question (the
  // BKL-184 / LE2-002 one-net idiom). Over-inclusion is DEMOTE-ONLY safe: an
  // utterance naming no item the graph knows resolves to the honest UNKNOWN,
  // never a guessed suggestion.
  if (!mutationImperative && isPairingAsk(t)) {
    classes.push("PAIRING_Q");
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
  const orderStatusStrong = /pedido|preparo|sa[ií]u|chegou|cad[êe]/.test(t);
  const paymentStatusStrong =
    /pago|cobran[çc]a|pagar|paguei|aprovad/.test(t) ||
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
  if (orderPhrasing && !mutationImperative) classes.push("ORDER_STATUS_Q");
  if (paymentPhrasing && !mutationImperative) classes.push("PAYMENT_STATUS_Q");

  // FE-T17 — reservation-bearing phrasing. An explicit marker (not folded into the
  // bare-"status" polysemy resolution below — reservation questions name "reserva"
  // directly, unlike the order/payment "status" ambiguity this file's F2 fix
  // disambiguates).
  //
  // ANCHORED, not a bare substring test (review fix — the original unanchored
  // `/reserva/` false-fired on the unrelated preserv* family — "preservar" /
  // "preservam" / "preservação" / "preservativo" all contain "reserva" as a
  // substring — and, via the completeness gate, a false span match can degrade an
  // otherwise-valid answer to a DIFFERENT question to UNKNOWN. It also did NOT
  // actually match "reservei" / "reservou" despite the old comment claiming it did
  // — `/reserva/` requires the literal substring "reserva", which neither verb form
  // contains). The negative lookbehind `(?<![a-z])` requires the match start at a
  // word boundary (never mid-word, closing the preserv* false-positive); the
  // alternation covers the verb forms this domain actually sees: reserva(s)
  // (noun/verb), reservar (infinitive), reservad-o/a (participle), reservam
  // (3p-pl present), reservando (gerund), reservei / reservou (1s/3s preterite).
  // The `(?!at)` lookahead right after "reserv" excludes "reservatório" (reservoir/
  // tank) — a real word sharing the "reserva-" prefix but never the domain this
  // decomposer models (a restaurant table reservation) — cheaply, since no verb
  // form in the alternation is ever followed by "at". Verified empirically against
  // both a must-fire and a must-not-fire word list (RESERVATION_STATUS_Q tests
  // below).
  //
  // BKL-217 — EXCLUDE reservation MUTATIONS via the shared `mutationImperative`
  // net (the same read-vs-mutation split #349/BKL-201 applied to the cart span
  // and BKL-206 to the order/payment status spans). RESERVATION_STATUS is
  // classify-only-eligible, so without this gate "cancela minha reserva" / "muda
  // minha reserva para 20h" fire RESERVATION_STATUS_Q → classify-only answers the
  // READ and SILENTLY DROPS the reservation.cancel / reservation.modify (the
  // reservation sibling of the BKL-201 hole — live-caught: a seeded-reservation
  // "cancelar minha reserva das 18:30" degraded to "não encontrei" with zero
  // adjudication). Gating on `!mutationImperative` routes those to the model /
  // mutation path; a genuine reservation QUESTION ("minha reserva está
  // confirmada?", "qual minha reserva?") has no mutation verb and still fires.
  // A how-to interrogative ("como cancelo minha reserva?") also routes to the
  // model for a helpful answer — the fail-SAFE direction (never a wrong read).
  //
  // BKL-219/224 — the `mesa` (table) synonym: a customer asks about their booking
  // by "mesa" as often as "reserva" ("minha mesa está confirmada?"). Anchored on
  // BOTH sides (`(?<![a-z])mesas?(?![a-z])`) so it matches standalone "mesa"/"mesas"
  // only — never mid-word ("mesada" allowance, "mesas" is fine). Hoisted to a const
  // so the bare-"status" fallback below can de-shadow a reservation-status ask.
  const reservationRef =
    /(?<![a-z])reserv(?!at)(a|ar|ad|am|as|ando|ei|ou)/.test(t) ||
    /(?<![a-z])mesas?(?![a-z])/.test(t);
  if (!mutationImperative && reservationRef) {
    classes.push("RESERVATION_STATUS_Q");
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
  const cartRef = /(?<![a-z])(carrinho|carrinhos|cesta|cestas|sacola|sacolas)/.test(t);
  if (cartRef && !mutationImperative) classes.push("CART_CONTENTS_Q");

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
    if (!classes.includes("ORDER_STATUS_Q")) classes.push("ORDER_STATUS_Q");
    if (!classes.includes("PAYMENT_STATUS_Q")) classes.push("PAYMENT_STATUS_Q");
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
  const orderHistoryRef =
    /hist[óo]rico[^.!?]{0,25}pedido|pedido[^.!?]{0,25}hist[óo]rico|(?<![a-z])(meus|todos os meus|[úu]ltimos)\s+pedidos/.test(
      t,
    );
  const paymentHistoryRef =
    /hist[óo]rico[^.!?]{0,25}(pagamento|pagar)|(?<![a-z])(meus|todos os meus|[úu]ltimos)\s+pagamentos/.test(
      t,
    );
  if (orderHistoryRef) {
    classes.push("ORDER_HISTORY_Q");
    const i = classes.indexOf("ORDER_STATUS_Q");
    if (i !== -1) classes.splice(i, 1);
  }
  if (paymentHistoryRef) {
    classes.push("PAYMENT_HISTORY_Q");
    const i = classes.indexOf("PAYMENT_STATUS_Q");
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
 * BKL-152-edge — the DATE-ANCHOR exactness signal (@claustrum/core 0.8.0). The
 * clock lives in the ADOPTER (the RenderCarriersForTurn seam, wired at
 * claustrum-bootstrap): it resolves the queried date and threads
 * `ClaimsRenderContext.resolvedQueryDate` PRESENT iff the queried date is a
 * CONFIRMED NON-TODAY day (absent ⟺ the date resolved to TODAY, or was
 * unresolvable). This decomposer stays CLOCK-PURE — it only reads that pre-resolved
 * signal. `seamActive` says the adopter wired the seam this turn (so absent means
 * "today", not "unwired"); when `false`/omitted the pure rule below runs
 * byte-identically (the seam-unwired / test path).
 */
export interface DateAnchorSignal {
  readonly seamActive: boolean;
  /** The resolved queried ISO date, PRESENT ⟺ a confirmed NON-TODAY day. */
  readonly resolvedQueryDate?: string;
}

export function decomposeRequiredClaims(
  spanClasses: readonly string[],
  ownership?: ActiveResourceOwnership,
  dateAnchor?: DateAnchorSignal,
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
  // BKL-152-edge (@claustrum/core 0.8.0) — the weekday==today edge, now EXACT where
  // the RenderCarriersForTurn seam is wired. The `dateAnchor` signal carries the
  // adopter's clock-resolved date (this decomposer stays clock-pure):
  //   - seam ACTIVE + resolvedQueryDate PRESENT (confirmed NON-TODAY) → SUPPRESS (the
  //     precise SCN-002 case; a genuine future/other-day hours question).
  //   - seam ACTIVE + resolvedQueryDate ABSENT → the queried date resolved to TODAY
  //     (a named weekday that IS today) → KEEP STORE_OPEN_NOW: the open-now fact is
  //     relevant when the named day is today. (An unresolvable "feriado" also lands
  //     here and keeps it — harmless: its STORE_HOURS_FOR_DATE claim can't validate
  //     without a resolvable date, so the turn degrades regardless of this companion.)
  //   - seam INACTIVE (unwired / tests) → the pure #301 rule: SUPPRESS whenever a
  //     date-for span is present. Byte-identical to the pre-0.8.0 behavior.
  // Guards unchanged: PICKUP_Q present keeps STORE_OPEN_NOW (pickup needs open-now);
  // "hoje"/undated never fire STORE_HOURS_FOR_DATE_Q, so they keep it with no seam.
  if (
    spanClasses.includes("STORE_HOURS_FOR_DATE_Q") &&
    !spanClasses.includes("PICKUP_Q")
  ) {
    const suppress =
      dateAnchor?.seamActive === true
        ? dateAnchor.resolvedQueryDate !== undefined // exact: only a confirmed non-today date
        : true; // pure #301 fallback (seam unwired)
    if (suppress) required.delete("STORE_OPEN_NOW");
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
 */
const PRESENCE_COMPLEMENT_PAIRS: ReadonlyArray<
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
