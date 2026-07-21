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
import {
  isRegistryClaimType,
  type RegistryClaimType,
} from "./claim-registry.js";
// inv.18 v2 — STORE_OPEN_NOW's closure row (span class + required companions) AND its
// pt-BR span markers are GENERATED from its ClaimDefinition source by the
// claimdef-compiler (./claimdefs/store-open-now.generated.ts — DO NOT EDIT). The
// previously-handwritten closure entry + the marker regex collapse into these splices.
import { STORE_OPEN_NOW_CLOSURE } from "./claimdefs/store-open-now.generated.js";

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
  const mutationImperative =
    /(?<![a-z])(adicion|acrescent|remov|tir|coloc|p[õo]e|p[õo]r|mud|troc|limp|esvazi|aument|diminu|cancel)/.test(
      t,
    );

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
  const isMenuOverview =
    notOrderScoped &&
    !mutationImperative &&
    !ALLERGEN_FAMILY_RE.test(t) &&
    /\bcard[áa]pio\b|\bmenu\b|o que (voc[êe]s )?(t[êe]m|servem)( (pra|para) comer)?|quais (os |as )?(pratos|op[çc][õo]es)/.test(t);
  if (isMenuOverview) classes.push("MENU_OVERVIEW_Q");

  if (notOrderScoped && !mutationImperative && /quanto custa|quanto (custam|é|fica|sai|tá|ta)|qual (o |é o )?pre[çc]o|pre[çc]o d[aoe]/.test(t)) {
    classes.push("MENU_ITEM_PRICE_Q");
  }
  // NB: allergen-family phrasing ("ingredientes", "contém glúten/lactose") is
  // DELIBERATELY excluded — it routes to the carved-out MENU_ITEM_ALLERGENS
  // (honest-UNKNOWN + staff handoff, BKL-123/143), never a rendered CONTENTS answer.
  // `!isMenuOverview` keeps a WHOLE-menu question ("o que tem no cardápio") disjoint from
  // the per-ITEM contents span ("o que vem no combo") — the overview owns it.
  if (notOrderScoped && !mutationImperative && !isMenuOverview && !ALLERGEN_FAMILY_RE.test(t) && /o que (vem|tem|acompanha)|do que (é|e) (é |)feit|que vem (n|em)|composi[çc][ãa]o d/.test(t)) {
    classes.push("MENU_ITEM_CONTENTS_Q");
  }

  // BKL-214 — a dietary-PREFERENCE question ("tem opção vegetariana?", "prato vegano?").
  // RESTRICTED to pure-preference tags (vegetariano/vegano) — matches ONLY those stems.
  // GATED on `!ALLERGEN_FAMILY_RE`: an allergen-adjacent diet ("sem glúten", "sem
  // lactose", "contém…") trips the allergen net and routes to the carved-out conservative
  // abstain path (BKL-143/123), NEVER a rendered dietary list. `!mutationImperative` keeps
  // "tira o vegetariano do carrinho" on the mutation path. Over-inclusion is DEMOTE-ONLY
  // safe: no tagged product → ABSENT evidence → honest UNKNOWN, never a fabricated option.
  if (
    notOrderScoped &&
    !mutationImperative &&
    !ALLERGEN_FAMILY_RE.test(t) &&
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
  const selfReference =
    /(?<![a-z])(meu|minha|meus|minhas)\s+(pedido|pagamento|entrega|reserva)/.test(t) ||
    /(?<![a-z])pedido\s*n?[ºo°.]?\s*#?\d{2,}|#\d{2,}/.test(t);
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
> = [["CART_CONTENTS", "CART_EMPTY"]];

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
