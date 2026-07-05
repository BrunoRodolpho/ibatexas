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
 */
export type TemplatePosture = "validated" | "unknown" | "refused" | "escalate";

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
/** Triad slice (Plan 1 Phase 3) — the override-aware "is it open right now" type. */
export const STORE_OPEN_NOW = "STORE_OPEN_NOW";
/** BKL-121 — the today's-hours read (public, non-Triad; override/holiday falsified). */
export const STORE_HOURS = "STORE_HOURS";

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
// (STORE_OPEN_NOW, STORE_HOURS, ORDER_FULFILLMENT_STAGE, PAYMENT_STATUS) are a
// STRICT SUBSET of the proposable CLAIM_REGISTRY enum (claim-registry.ts). TWO
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
// SAFE_UNKNOWN. The drift test pin was shrunk to {MENU_ITEM_ALLERGENS,
// PURCHASE_COMPLETED} to match, and its RENDERABLE==triadScoped block was updated to
// allow STORE_HOURS as the ONE deliberate non-Triad renderable (see that test).
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
};
