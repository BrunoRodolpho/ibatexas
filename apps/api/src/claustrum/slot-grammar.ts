/**
 * The PROPOSITION-FREE SLOT GRAMMAR (SDD §J.6 / §O#3 / §Q.7; registry §5).
 *
 * This is the declarative vocabulary the renderer-from-claims (`./renderer-from-claims.ts`)
 * fills. It is the §O#3 "proposition-free slot grammar" + the §J.6 Inv 6 surface:
 * every template is STATIC pt-BR text with TYPED slots, and every PROPOSITION slot
 * is bound 1:1 to a specific VALIDATED claim TYPE + FIELD. There is NO free-text /
 * prose generation here and NONE downstream — the renderer is a deterministic
 * template-filler, never a model (SDD §O#3 / §R "no customer-facing sentence is
 * authored by a probabilistic model").
 *
 * Two slot KINDS, and the distinction is the whole point of Inv 6:
 *
 *   - `PROPOSITION` — a slot whose filled value ASSERTS a domain/world fact (an
 *     order stage, a payment status, an ETA). It MUST name the backing claim
 *     `claimType` + `field`. The renderer fills it ONLY from an independently
 *     VALIDATED claim of that exact type, reading that exact field (Inv 6: "every
 *     proposition and placeholder corresponds to an independently-validated
 *     claim/field"). A proposition slot with no backing validated claim is
 *     UNFILLABLE → the renderer abstains; it NEVER fabricates a fact.
 *
 *   - `LITERAL` — static template text. Asserts nothing on its own.
 *
 * A template is `propositionFree` IFF it has ZERO `PROPOSITION` slots. The
 * UNKNOWN / REFUSED / ESCALATE templates (registry §5 "permitted") are
 * proposition-free BY CONSTRUCTION: they are epistemic self-reports ("não consegui
 * confirmar…", "não localizei… agora") and/or offers ("quer que eu verifique?")
 * that describe the SYSTEM's state — never a fact about the order / payment /
 * restaurant. A static asserter (a `validated`-tier template) is NOT
 * proposition-free; it earns its propositions from VALIDATED backing claims.
 *
 * SCOPE (SDD §Q scope guard): a REPRESENTATIVE set of claim types proves the
 * machinery + the invariants. The full 37-row registry population is the deferred
 * follow-on — this is the kernel-foundation grammar, not the whole vocabulary.
 *
 * PURE & self-contained: no clock / RNG / IO, no model import, no kernel-downstream
 * import beyond the `@adjudicate/core` claims types it consumes.
 */

// inv.18 v2 — STORE_OPEN_NOW's validated template is GENERATED from its
// ClaimDefinition source by the claimdef-compiler (DO NOT EDIT the generated file).
import { STORE_OPEN_NOW_TEMPLATE } from "./claimdefs/store-open-now.generated.js";

/**
 * A typed slot in a template.
 *
 *   - `LITERAL`     — static pt-BR text; asserts nothing.
 *   - `PROPOSITION` — a domain-fact placeholder bound 1:1 to a VALIDATED claim's
 *                     `claimType` + `field` (Inv 6). The renderer fills it ONLY
 *                     from a VALIDATED claim of that type, reading that field.
 */
export type TemplateSlot =
  | { readonly kind: "LITERAL"; readonly text: string }
  | {
      readonly kind: "PROPOSITION";
      /** The registry claim TYPE that must be VALIDATED to fill this slot (Inv 6). */
      readonly claimType: string;
      /** The field on that claim's value this slot reads (the 1:1 proposition binding). */
      readonly field: string;
    };

/**
 * Which terminal posture a template serves. A template may render only under its
 * declared posture — a `validated` (asserting) template is NEVER used to render an
 * UNKNOWN/REFUSED claim, and a `unknown`/`refused`/`escalate` template carries NO
 * proposition (registry §5 "permitted"; §O#5 render-half).
 *
 *   - `validated` — asserts the claim's domain proposition(s); HAS proposition slots.
 *   - `unknown`   — epistemic self-report + offer; proposition-free.
 *   - `refused`   — epistemic self-report (cannot confirm); proposition-free.
 *   - `escalate`  — safe handoff template; proposition-free (the §O#5 render-half).
 *   - `clarify`   — disambiguation self-report + ask (BKL-148); proposition-free.
 *                   Asks the customer for a disambiguating detail WITHOUT asserting
 *                   any domain fact (it never says WHICH/HOW MANY records exist —
 *                   that would be a proposition; it reports only the system's own
 *                   "more than one possible match" state and offers to confirm).
 */
export type TemplatePosture = "validated" | "unknown" | "refused" | "escalate" | "clarify";

/**
 * A declarative template: an ordered list of typed slots, plus the posture it
 * serves and the claim TYPE it is keyed to (so the renderer can select it).
 *
 * `propositionFree` is DERIVED, not declared, by `isPropositionFree()` — a template
 * is proposition-free IFF it contains zero `PROPOSITION` slots. We never let an
 * author hand-assert "this is proposition-free"; the grammar PROVES it structurally
 * (the Inv 6 / §O#3 guarantee must be mechanical, not a promise).
 */
export interface Template {
  /** The registry claim TYPE this template renders (or is keyed to for the safe postures). */
  readonly claimType: string;
  /** The terminal posture this template serves. */
  readonly posture: TemplatePosture;
  /** The ordered slots (LITERAL + PROPOSITION). */
  readonly slots: readonly TemplateSlot[];
}

/**
 * STRUCTURAL predicate (SDD §O#3 / Inv 6): a template is proposition-free IFF it
 * has NO `PROPOSITION` slot. This is the mechanical guarantee the safe-posture
 * templates rely on — the renderer asserts it at render time so a mis-declared
 * UNKNOWN/REFUSED/ESCALATE template (one that smuggled in a proposition slot)
 * cannot leak a domain fact.
 */
export function isPropositionFree(template: Template): boolean {
  return template.slots.every((slot) => slot.kind !== "PROPOSITION");
}

/**
 * Render a PROPOSITION-FREE template (a safe posture — unknown / refused / escalate)
 * to its pt-BR text by concatenating its LITERAL slots. THROWS if handed a template
 * carrying a PROPOSITION slot (those require a VALIDATED-claim binding — use the
 * claims renderer, not this). Pure. Exists so a caller that needs the safe text
 * WITHOUT the full renderer (the BKL-078 responder gate) reuses the ONE canonical
 * template string instead of re-typing the literal (no drift from SAFE_TEMPLATES).
 */
export function renderPropositionFreeText(template: Template): string {
  if (!isPropositionFree(template)) {
    throw new Error(
      `[slot-grammar] renderPropositionFreeText requires a proposition-free template; '${template.claimType}' carries a PROPOSITION slot`,
    );
  }
  return template.slots
    .map((slot) => (slot.kind === "LITERAL" ? slot.text : ""))
    .join("");
}

/** Convenience constructors — keep the table below readable; pure, no behaviour. */
const lit = (text: string): TemplateSlot => ({ kind: "LITERAL", text });
const prop = (claimType: string, field: string): TemplateSlot => ({
  kind: "PROPOSITION",
  claimType,
  field,
});

/**
 * The REPRESENTATIVE template grammar (SDD §Q scope guard: representative, not the
 * full 37-row registry). Each claim type carries:
 *
 *   - exactly ONE `validated` template whose PROPOSITION slots bind 1:1 to that
 *     type's fields (Inv 6); and
 *   - the shared safe-posture templates (unknown / refused / escalate) that are
 *     proposition-free by construction (registry §5; §O#5 render-half).
 *
 * The set is deliberately small but covers the three load-bearing domains the SDD
 * names as safety-critical (order fulfillment stage, payment status, ETA) so the
 * "UNKNOWN must not assert a status/payment/order fact" acceptance test has real
 * propositions to suppress.
 */

/** The representative claim types this kernel-foundation grammar models. */
export const ORDER_FULFILLMENT_STAGE = "ORDER_FULFILLMENT_STAGE";
export const PAYMENT_STATUS = "PAYMENT_STATUS";
/** FE-T17 — the owner-scoped reservation-status read. */
export const RESERVATION_STATUS = "RESERVATION_STATUS";
/** Triad slice (Plan 1 Phase 3) — the override-aware "is it open right now" type. */
export const STORE_OPEN_NOW = "STORE_OPEN_NOW";
/** BKL-121 — the today's-hours read (public, non-Triad; override/holiday falsified). */
export const STORE_HOURS = "STORE_HOURS";
/** BKL-138 — the DAY-SPECIFIC hours read (public, non-Triad; per-date override/holiday
 *  falsified). The per-date twin of STORE_HOURS (SCN-002/003). */
export const STORE_HOURS_FOR_DATE = "STORE_HOURS_FOR_DATE";
/** BKL-139 — the owner-scoped IN-PROGRESS cart read (pre-composed summary scalar). */
export const CART_CONTENTS = "CART_CONTENTS";
/** BKL-163 — the provably-empty cart twin (presence-complement of CART_CONTENTS). */
export const CART_EMPTY = "CART_EMPTY";
/** FE-D03 slice C — the owner-scoped list/history reads (pre-composed summary scalar). */
export const ORDER_HISTORY = "ORDER_HISTORY";
export const PAYMENT_HISTORY = "PAYMENT_HISTORY";
/** BKL-142 — the PUBLIC per-item menu price read (pre-composed pt-BR scalar). */
export const MENU_ITEM_PRICE = "MENU_ITEM_PRICE";
/** BKL-142 — the PUBLIC per-item menu contents read (first-party description scalar). */
export const MENU_ITEM_CONTENTS = "MENU_ITEM_CONTENTS";
/** BKL-142 — the PUBLIC menu-WIDE overview read (deterministic first-party listing scalar). */
export const MENU_OVERVIEW = "MENU_OVERVIEW";
/** BKL-136 — the PUBLIC store-info read (owner-attested address/parking scalar). */
export const STORE_INFO = "STORE_INFO";

/**
 * Per-type `validated` (asserting) templates, keyed by claim type. Each is the ONE
 * template whose proposition slots are bound 1:1 to the type's validated fields
 * (Inv 6). Static pt-BR around the slots; no free text.
 */
export const VALIDATED_TEMPLATES: Readonly<Record<string, Template>> = {
  // inv.18 v2 — the STORE_OPEN_NOW template is GENERATED from its ClaimDefinition
  // source (./claimdefs/store-open-now.generated.ts — DO NOT EDIT). The proposition
  // slot prop(STORE_OPEN_NOW, "mealPeriod") is derived from the source's
  // render.prop("mealPeriod") with claimType filled = self; the ~11-line handwritten
  // entry collapsed into this single spliced import.
  [STORE_OPEN_NOW]: STORE_OPEN_NOW_TEMPLATE,
  // BKL-121 — the STORE_HOURS validated template. Static pt-BR around the single
  // ledger-bound proposition prop(STORE_HOURS, "hoursText"), bound 1:1 to the C6
  // value-binding FIELD (claim-registry.ts `valueBinding.path = ["hoursText"]`); the
  // StoreHoursRead shape's field is `hoursText` (turn-reads.ts). The value is a
  // FREE-FORM pt-BR hours string ("11h–15h / 18h–23h" | "fechado"), evidence-bound
  // from the real weekly schedule (never an enum, so no claims-labels localization).
  [STORE_HOURS]: {
    claimType: STORE_HOURS,
    posture: "validated",
    slots: [
      lit("Hoje nosso horário de funcionamento é: "),
      prop(STORE_HOURS, "hoursText"),
      lit("."),
    ],
  },
  // BKL-138 — the DAY-SPECIFIC hours template (SCN-002/003). A SINGLE ledger-bound
  // proposition prop(STORE_HOURS_FOR_DATE, "hoursText"), bound 1:1 to the C6
  // value-binding FIELD (claim-registry.ts `valueBinding.path = ["hoursText"]`) — the
  // per-date twin of STORE_HOURS. Deliberately DAY-GENERIC static text ("nesse dia" —
  // the day the customer asked about): the single-proposition shape mirrors the proven
  // STORE_HOURS chain and its ONE `buildClaimDefinition` value projection exactly, so
  // it stays sound-by-construction (a second, differently-projected day-name
  // proposition would fight the auto-assembled ClaimDefinition — see claim-definition-
  // registry.ts). Renders the QUERIED date's REAL weekly hours; a holiday/override on
  // that date already demoted the claim to UNKNOWN upstream (never reaches here).
  [STORE_HOURS_FOR_DATE]: {
    claimType: STORE_HOURS_FOR_DATE,
    posture: "validated",
    slots: [
      lit("Nesse dia, nosso horário de funcionamento é: "),
      prop(STORE_HOURS_FOR_DATE, "hoursText"),
      lit("."),
    ],
  },
  [ORDER_FULFILLMENT_STAGE]: {
    claimType: ORDER_FULFILLMENT_STAGE,
    posture: "validated",
    slots: [
      lit("Seu pedido está na etapa: "),
      // F1 — bind 1:1 to the C6 value-binding FIELD. The kernel validates this
      // claim's value at `valueBinding.path = ["fulfillmentStatus"]` (claim-
      // registry.ts) against the ledger; the OrderFulfillmentRead shape's field is
      // `fulfillmentStatus` (turn-reads.ts), NOT `stage`. The old `stage` slot read
      // a field the validated value never carries → the proposition was UNFILLABLE
      // and a legitimately-VALIDATED ORDER claim abstained to UNKNOWN. Reading the
      // ACTUAL value field makes a VALIDATED ORDER claim render.
      prop(ORDER_FULFILLMENT_STAGE, "fulfillmentStatus"),
      lit("."),
    ],
  },
  [PAYMENT_STATUS]: {
    claimType: PAYMENT_STATUS,
    posture: "validated",
    slots: [
      lit("O status do seu pagamento é: "),
      prop(PAYMENT_STATUS, "status"),
      lit("."),
    ],
  },
  // FE-T17 — the reservation-status validated template. ONE proposition slot
  // (self-type, "status"), mirroring PAYMENT_STATUS / ORDER_FULFILLMENT_STAGE
  // exactly. NOT multi-field: the linked kernel's mint step (SDD §5 C6 / the
  // published `runClaimsKernel` "F2" narrowing — `kernels.js`) reconstructs the
  // CanonicalClaim's value carrying ONLY the C6-`valueBinding.path`-proven slice
  // and drops every sibling field of the read as unvalidated content (by design —
  // only the bound path was ever compared against the ledger). A second
  // proposition slot reading a sibling field (e.g. `partySize`) would therefore
  // ALWAYS be UNFILLABLE post-mint, aborting the whole template to UNKNOWN (Inv 6
  // is all-or-nothing per template) — so this template, like every other Triad
  // type here, renders exactly the one C6-bound field.
  // BKL-185 — the ONE proposition slot binds the pre-composed `statusLine`
  // (status + optional "— DD/MM às HH:MM, para N pessoa(s)" detail; see the
  // registry's valueBinding note). Detail-absent → statusLine === status → the
  // render is byte-identical to the pre-BKL-185 status-only form.
  [RESERVATION_STATUS]: {
    claimType: RESERVATION_STATUS,
    posture: "validated",
    slots: [
      lit("O status da sua reserva é: "),
      prop(RESERVATION_STATUS, "statusLine"),
      lit("."),
    ],
  },
  // BKL-139 — the cart-contents validated template. ONE proposition slot binding 1:1
  // to the C6 valueBinding FIELD (`itemsSummaryText`, claim-registry.ts
  // `valueBinding.path = ["itemsSummaryText"]`). The value is a DETERMINISTICALLY
  // PRE-COMPOSED pt-BR summary ("2x Costela — total R$123,00"), evidence-bound from the
  // owner-scoped cart read (turn-reads.ts `composeCartItemsSummary`) — never an enum
  // (so no claims-labels localization), never model-authored (FE-D04 / BKL-149). Same
  // single-C6-field shape as STORE_HOURS_FOR_DATE / RESERVATION_STATUS (the frozen
  // single-scalar kernel drops every sibling read field post-mint).
  [CART_CONTENTS]: {
    claimType: CART_CONTENTS,
    posture: "validated",
    slots: [
      lit("No seu carrinho: "),
      prop(CART_CONTENTS, "itemsSummaryText"),
      lit("."),
    ],
  },
  // BKL-163 — the provably-empty cart template. ONE proposition slot bound 1:1 to
  // the C6 valueBinding FIELD (`emptinessText`, claim-registry.ts) — the
  // code-composed literal "vazio" the investigator records ONLY when the
  // owner-scoped cart read proved `hasItems: false`. Friendly VALIDATED answer for
  // the empty cart (replacing the honest-UNKNOWN degrade of PR #291 deviation (a));
  // the menu pointer is STATIC literal text (an offer, not a proposition).
  [CART_EMPTY]: {
    claimType: CART_EMPTY,
    posture: "validated",
    slots: [
      lit("Seu carrinho está "),
      prop(CART_EMPTY, "emptinessText"),
      lit(" no momento — quer dar uma olhada no cardápio?"),
    ],
  },
  // FE-D03 slice C — the ORDER_HISTORY / PAYMENT_HISTORY validated templates. ONE
  // proposition slot each, bound 1:1 to the C6 valueBinding FIELD (`historySummaryText`,
  // claim-registry.ts). The value is a DETERMINISTICALLY PRE-COMPOSED, bounded
  // most-recent-N pt-BR summary (turn-reads.ts composeOrderHistorySummary /
  // composePaymentHistorySummary) — never an enum, never model-authored. Same
  // single-C6-field shape as CART_CONTENTS (the frozen single-scalar kernel drops every
  // sibling field post-mint, so a list renders as one bound string).
  [ORDER_HISTORY]: {
    claimType: ORDER_HISTORY,
    posture: "validated",
    slots: [
      lit("Seu histórico de pedidos: "),
      prop(ORDER_HISTORY, "historySummaryText"),
      lit("."),
    ],
  },
  [PAYMENT_HISTORY]: {
    claimType: PAYMENT_HISTORY,
    posture: "validated",
    slots: [
      lit("Seu histórico de pagamentos: "),
      prop(PAYMENT_HISTORY, "historySummaryText"),
      lit("."),
    ],
  },
  // BKL-142 — the menu price/contents validated templates. ONE proposition slot each,
  // bound 1:1 to the C6 valueBinding FIELD (`priceText` / `contentsText`, claim-
  // registry.ts). The value is a DETERMINISTICALLY PRE-COMPOSED pt-BR scalar
  // (menu-item-resolver.ts `composeMenuPriceText` / `composeMenuContentsText`) — the
  // full clause ("Costela Defumada custa R$ 89,00"), evidence-bound from the resolved
  // product, never an enum, never model-authored. Same single-C6-field shape as
  // CART_CONTENTS / STORE_HOURS_FOR_DATE (the frozen single-scalar kernel drops every
  // sibling read field post-mint).
  [MENU_ITEM_PRICE]: {
    claimType: MENU_ITEM_PRICE,
    posture: "validated",
    slots: [prop(MENU_ITEM_PRICE, "priceText"), lit(".")],
  },
  [MENU_ITEM_CONTENTS]: {
    claimType: MENU_ITEM_CONTENTS,
    posture: "validated",
    slots: [prop(MENU_ITEM_CONTENTS, "contentsText"), lit(".")],
  },
  // BKL-142 — the menu-WIDE overview validated template. ONE proposition slot bound
  // 1:1 to the C6 `overviewText` (the deterministic first-party listing composed in
  // menu-item-resolver.ts `composeMenuOverviewText`), never model-authored.
  [MENU_OVERVIEW]: {
    claimType: MENU_OVERVIEW,
    posture: "validated",
    slots: [prop(MENU_OVERVIEW, "overviewText")],
  },
  // BKL-136 — the store-info validated template. ONE proposition slot bound 1:1 to
  // the C6 valueBinding FIELD (`infoText`, claim-registry.ts) — the deterministic
  // pre-composed pt-BR address/parking sentence (store-info-resolver.ts), derived
  // from OWNER-ATTESTED Medusa store.metadata. Bare single-prop shape like
  // MENU_OVERVIEW (the scalar is already a complete sentence).
  [STORE_INFO]: {
    claimType: STORE_INFO,
    posture: "validated",
    slots: [prop(STORE_INFO, "infoText")],
  },
  // NOTE: ORDER_ESTIMATED_ARRIVAL was REMOVED here (inv.18 validator wiring). It
  // had a `validated` template (a PROPOSITION slot prop(…, "etaMinutes")) but NO
  // registered ClaimDefinition — it is absent from CLAIM_REGISTRY/REGISTRY_SPECS
  // (claim-registry.ts), so it carried no requiredEvidence, no valueBinding for
  // `etaMinutes`, and no falsifiers. That is exactly the dangling-template
  // alignment-convention violation the ClaimDefinition validator (INV-3:
  // template → registered-definition) now REJECTS at registry load. Deleting the
  // dangling entry is the cleanest hygiene fix; promote it to a real
  // ClaimDefinition (registry row + eta read evidence + value-binding) if an ETA
  // claim is ever genuinely needed.
};

// PROPOSABLE-BUT-UNRENDERABLE COVERAGE (BKL-112; the pin lives in
// __tests__/proposable-renderable-drift.test.ts). The keys of VALIDATED_TEMPLATES
// (STORE_OPEN_NOW, STORE_HOURS, STORE_HOURS_FOR_DATE, ORDER_FULFILLMENT_STAGE,
// PAYMENT_STATUS, RESERVATION_STATUS) are a STRICT SUBSET of the proposable
// CLAIM_REGISTRY enum (claim-registry.ts). TWO
// registered proposable types still have NO validated template, so a
// genuinely-VALIDATED claim of one of them can only SAFE-DEGRADE to the UNKNOWN
// template (renderer-from-claims.ts abstains an untemplated VALIDATED claim — §O#3,
// never free-authored prose). They split into two DISTINCT reasons — see the
// by-design partition note at claim-definition-registry.ts:68-70:
//
//   · MENU_ITEM_ALLERGENS — a read_claim that degrades to UNKNOWN PENDING its
//     validated read-template (tracker BKL-123). Adding it is soundness-sensitive +
//     decision-gated (allergens are Hard-Rule-1 safety-critical; a renderer
//     list-slot capability + an owner liability policy are prerequisites) — a
//     separate focused effort, not a template edit here.
//   · PURCHASE_COMPLETED — an action_claim rendered via the responder's
//     SUCCESS_CLAIM_CLASSES path (ibatexas-responder.ts), NOT the read-template
//     grammar. It is DELIBERATELY + PERMANENTLY not in VALIDATED_TEMPLATES; it is
//     NOT pending any template and must NOT be filed under BKL-121/-123.
//
// STORE_HOURS GRADUATED (BKL-121): it now has the validated template above (the full
// read→evidence→falsifier→derive→template chain), so it is NO LONGER in the gap — a
// today's-hours question renders today's real hours instead of dead-ending at
// SAFE_UNKNOWN. The drift test pin stays {MENU_ITEM_ALLERGENS, PURCHASE_COMPLETED}
// (the only proposable types with no validated template), and its
// RENDERABLE==triadScoped block allows the DELIBERATE non-Triad renderables — the
// public read types STORE_HOURS / STORE_HOURS_FOR_DATE + BKL-142's MENU_ITEM_PRICE /
// MENU_ITEM_CONTENTS (all `not_applicable` ownership, never Triad-scoped).
//
// The drift test pins this exact gap so a future proposable type added without a
// template (or a template added/removed for a pinned type) trips CI.

/**
 * The SAFE-POSTURE templates (registry §5 "permitted"; §O#5 render-half). These
 * are proposition-free BY CONSTRUCTION — pure epistemic self-report + offer; they
 * assert NOTHING about the order / payment / restaurant. They are shared across
 * claim types (the system's-state language is type-agnostic).
 *
 *   - UNKNOWN  — honest ignorance + offer (registry §5: "não localizei… agora").
 *   - REFUSED  — could-not-confirm; a self-report, no domain assertion.
 *   - ESCALATE — safe human handoff (the §O#5 render-half: carries NO suppressed
 *                proposition, only the system's posture).
 *   - CLARIFY  — disambiguation ask (BKL-148): the system reports it has more than
 *                one possible match and asks for a specifying detail. Like UNKNOWN,
 *                it asserts NO domain fact — it never names or counts the candidate
 *                records (that would be a proposition); it speaks only about the
 *                system's own ambiguity. This replaces the pre-BKL-148 CLARIFY→UNKNOWN
 *                fallback, so a forced-CLARIFY turn asks a useful question instead of
 *                the generic "não localizei". (Naming the SPECIFIC candidate display
 *                numbers is BKL-170, BLOCKED on the @claustrum/core ClaimsRenderContext
 *                seam-bump — the candidates never reach this renderer today.)
 *
 * Keyed `posture → Template`. `claimType` is the literal posture name because these
 * templates are NOT keyed to a domain type — they are the system speaking about
 * itself.
 */
export const SAFE_TEMPLATES: Readonly<Record<Exclude<TemplatePosture, "validated">, Template>> = {
  unknown: {
    claimType: "__SAFE_UNKNOWN__",
    posture: "unknown",
    slots: [
      lit("Não localizei essa informação confirmada agora. Quer que eu verifique?"),
    ],
  },
  refused: {
    claimType: "__SAFE_REFUSED__",
    posture: "refused",
    slots: [lit("Não consegui confirmar essa informação. Quer que eu verifique?")],
  },
  escalate: {
    claimType: "__SAFE_ESCALATE__",
    posture: "escalate",
    slots: [
      lit(
        "Não consegui confirmar isso com segurança agora — vou encaminhar para um atendente verificar. Posso ajudar em mais alguma coisa?",
      ),
    ],
  },
  clarify: {
    claimType: "__SAFE_CLARIFY__",
    posture: "clarify",
    slots: [
      lit(
        "Tenho mais de um registro possível para isso — pode me dizer o número do pedido ou da reserva para eu confirmar o certo?",
      ),
    ],
  },
};

/**
 * BKL-184 — the ALLERGEN-ask UNKNOWN variant: the honest abstain PLUS the
 * human-handoff OFFER. Selected ONLY when the request carries allergen-family
 * phrasing (required-claim-decomposer.ts `isAllergenFamilyAsk` — the SAME net the
 * span classifier uses to route allergen questions away from a contents render)
 * AND the terminal is UNKNOWN; every other UNKNOWN renders the generic
 * {@link SAFE_TEMPLATES}.unknown, byte-identical. Proposition-free BY
 * CONSTRUCTION: it asserts NOTHING about any product's contents (the CONSERVATIVE
 * allergen ruling stands — never a "não contém X" from tags); it speaks only the
 * system's epistemic state, its safety posture, and an offer. Standalone const
 * (not a SAFE_TEMPLATES member — that Record is closed over the posture union).
 */
export const SAFE_UNKNOWN_ALLERGEN_TEMPLATE: Template = {
  claimType: "__SAFE_UNKNOWN_ALLERGEN__",
  posture: "unknown",
  slots: [
    lit(
      "Não localizei essa informação de alérgenos confirmada agora — por segurança, prefiro não arriscar uma resposta. Quer que eu peça para um atendente confirmar com a cozinha?",
    ),
  ],
};

/**
 * BKL-209 — the medical-EMERGENCY ESCALATE variant. Selected ONLY when the request
 * carries medical-distress phrasing (required-claim-decomposer.ts
 * `isMedicalEmergencyAsk` — the SAME deterministic net that forces the §O#9 ESCALATE
 * in the planner) AND the terminal is ESCALATE; every other ESCALATE renders the
 * generic {@link SAFE_TEMPLATES}.escalate, byte-identical.
 *
 * PROPOSITION-FREE BY CONSTRUCTION (Inv 6 / §O#5): it asserts NO domain/world fact
 * and — critically — NO medical instruction and NO phone number (the live bug was a
 * responder-authored, hallucinated "190"). It states the ONE universally-safe,
 * number-free directive (seek emergency medical care immediately), the system's
 * honest limit ("não posso orientar"), and offers a human. The staff surface
 * (support.handoff_requested) is fired by the render adapter's best-effort sink, so
 * "vou avisar nossa equipe" is TRUE. Standalone const (SAFE_TEMPLATES is closed over
 * the posture union).
 */
export const SAFE_ESCALATE_EMERGENCY_TEMPLATE: Template = {
  claimType: "__SAFE_ESCALATE_EMERGENCY__",
  posture: "escalate",
  slots: [
    lit(
      "Isto parece uma emergência médica e eu não posso orientar sobre isso. Se você ou alguém aí está passando mal, procure atendimento médico de emergência imediatamente. Vou avisar nossa equipe para ajudar.",
    ),
  ],
};

/**
 * BKL-170 (CLARIFY-with-candidates, @claustrum/core 0.8.0 `disambiguationCandidates`
 * carrier) — the proposition-free CLARIFY *ask* that VOICES the specific candidate
 * handles the customer can pick, superseding the generic {@link SAFE_TEMPLATES}.clarify
 * ("pode me dizer o número do pedido") when the render context carries first-party,
 * owner-scoped candidate labels. The labels are IDOR-closed by construction — the
 * resolver only ever lists the AUTHENTICATED customer's OWN records (the read-executor
 * multi-order / ≥2-owned CLARIFY path), never a cross-owner id.
 *
 * PROPOSITION-FREE (Inv 6 / §O#5): the frame asserts NO domain/world fact about any
 * candidate — it lists their opaque display LABELS and asks which one. The labels are
 * ADOPTER carrier vocabulary (not model prose, not a suppressed-value re-leak). The
 * caller keeps the generic clarify on an EMPTY list (this builder is never called with
 * `[]`). Deterministic + pure.
 */
export function clarifyWithCandidatesText(labels: readonly string[]): string {
  return `Tenho mais de um registro possível para isso — qual deles: ${joinPtBrList(labels)}?`;
}

/** pt-BR enumerated list join: `[a]`→"a"; `[a,b]`→"a ou b"; `[a,b,c]`→"a, b ou c". Pure. */
function joinPtBrList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ou ${items[items.length - 1]}`;
}
