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
 *   - `ORDER_STATUS_Q`   — "cadê meu pedido?" → ORDER_FULFILLMENT_STAGE.
 *   - `PAYMENT_STATUS_Q` — "meu pagamento foi aprovado?" → PAYMENT_STATUS.
 *   - `PICKUP_Q`         — a PICKUP / "posso retirar agora?" question logically
 *     requires BOTH the store-open companion AND the order stage (you can only
 *     retrieve a ready order from an OPEN store) → {STORE_OPEN_NOW,
 *     ORDER_FULFILLMENT_STAGE}. This is the §O#15 worked example: a pickup/hours
 *     question's required set is MORE than the one type the planner might pick.
 */
export type SpanClass =
  | "STORE_OPEN_NOW_Q"
  | "ORDER_STATUS_Q"
  | "PAYMENT_STATUS_Q"
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
  ORDER_STATUS_Q: ["ORDER_FULFILLMENT_STAGE"],
  PAYMENT_STATUS_Q: ["PAYMENT_STATUS"],
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
export function classifyRequestSpans(text: string): SpanClass[] {
  const t = text.toLowerCase();
  const classes: SpanClass[] = [];

  if (/retir|buscar|pegar/.test(t)) classes.push("PICKUP_Q");
  // inv.18 v2 — the STORE_OPEN_NOW_Q markers are GENERATED from the def source
  // (replaces the previously-handwritten /abert|fechad|.../ regex — the runtime
  // image can no longer drift from the ClaimDefinition closure).
  if (STORE_OPEN_NOW_CLOSURE.markers.some((m) => m.test(t))) {
    classes.push(STORE_OPEN_NOW_CLOSURE.spanClass);
  }

  // Precise discriminators that DISAMBIGUATE the polysemous "status" (A's F2 fix —
  // do NOT regress to a coarse `/pedido|cad[êe]|status/` rule that misroutes a
  // payment "status" to ORDER-only).
  const paymentPhrasing = /pagamento|pago|pix|cobran[çc]a|pagar|paguei|aprovad/.test(t);
  const orderPhrasing = /pedido|entrega|preparo|sa[ií]u|chegou|cad[êe]/.test(t);

  if (orderPhrasing) classes.push("ORDER_STATUS_Q");
  if (paymentPhrasing) classes.push("PAYMENT_STATUS_Q");

  // Bare "status" with NO payment/order discriminator → over-include BOTH (never
  // silently drop either companion). If a discriminator is present, the precise
  // branch above already routed it; we add nothing here to avoid the old misroute.
  if (/status/.test(t) && !paymentPhrasing && !orderPhrasing) {
    if (!classes.includes("ORDER_STATUS_Q")) classes.push("ORDER_STATUS_Q");
    if (!classes.includes("PAYMENT_STATUS_Q")) classes.push("PAYMENT_STATUS_Q");
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
 * resource). This is the only place the required set SHRINKS, and it is sound: a
 * companion about a non-existent resource can never validate and hides nothing.
 * When `ownership` is omitted (the default — the signal is not yet threaded to
 * this layer; see DEFER note below) or a flag is `true`, NOTHING is dropped and
 * the behavior is byte-identical to the pre-#8 over-including decomposer.
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
 * The P4 COMPLETENESS check quantified over the REQUIRED set (SDD §O#15) — NOT the
 * planner's chosen candidates. `resolved` maps each produced claim type to its
 * kernel verdict; any required type absent from the map is treated as `"ABSENT"`.
 *
 * A required companion resolving ABSENT / UNKNOWN / REFUSED DEGRADES the turn —
 * the turn must NOT render the literal-true subset while silently omitting the
 * companion (the §O#15 "render the easy half" hole). `complete` is `true` IFF
 * EVERY required type is VALIDATED. Pure; order-stable over the required set's
 * insertion order.
 */
export function checkRequiredClaimCompleteness(
  required: ReadonlySet<RegistryClaimType>,
  resolved: ReadonlyMap<string, ClaimVerdict>,
): RequiredCompletenessResult {
  const unsatisfied: RegistryClaimType[] = [];
  for (const type of required) {
    const verdict: RequiredClaimResolution = resolved.get(type) ?? "ABSENT";
    if (verdict !== "VALIDATED") unsatisfied.push(type);
  }
  return { complete: unsatisfied.length === 0, unsatisfied };
}
