/**
 * FE-T09b (BKL-154 live-disproof follow-up) — deterministic amend-preference
 * correction.
 *
 * Live disproof on FE-T09/PR #264 (Drive F, 5/5 attempts, system-wide
 * turn_trace zero order.amend.* occurrences ever): the granular amend
 * kinds' machinery (schema/guard/audit sidecar) is sound but UNREACHED — the
 * 4B never selects `order.amend.add_item` / `update_qty` / `remove_item`
 * over their sibling cart-building kinds (`order.item.add` / `update` /
 * `remove`), even for maximally-explicit phrasing ("o pedido que eu já fiz,
 * o pedido 910226"). Descriptions + schema shape alone don't steer this
 * model — exactly BKL-154's prescribed territory: "Fix = planner-side
 * disambiguation... plus a candidate resolver check."
 *
 * This module is that candidate-resolver check. It runs at the resolver
 * seam (`ibatexas-resolver.ts`'s `resolve()`, post-planner/pre-adjudication
 * — the same architectural role as `ops-resolver.ts`'s own resolver-level
 * corrections, e.g. its "FIX 2" refundable-status re-check on resume): when
 * the model proposes a cart-op kind AND the utterance deterministically
 * references an ALREADY-PLACED order AND the authenticated customer has at
 * least one order that kind's amend action can actually apply to, re-route
 * the proposal to its granular amend sibling. The customer PLANNER_PERSONA
 * is NOT touched — this is a runtime correction, not a prompt change.
 *
 * Adversarial bar (BKL-154's own text): ordinary cart-building ("quero uma
 * coca") MUST stay friction-free. The marker set below is therefore narrow
 * and requires an EXPLICIT existing-order anchor — never a bare "pedido"
 * substring test ("quero fazer um pedido de coca", placing a NEW order,
 * contains the word "pedido" but matches none of these).
 */

import { canPerformAction, type CustomerAction, type OrderFulfillmentStatus } from "@ibatexas/types";
import { createOrderQueryService } from "@ibatexas/domain";

export type Ctx = Record<string, unknown>;

/** The 3 cart-op kinds this correction watches, each mapped to its granular
 *  amend-kind sibling (FE-T09/D-a — the amend inversion). */
export const CART_TO_AMEND_KIND: Readonly<Record<string, string>> = {
  "order.item.add": "order.amend.add_item",
  "order.item.update": "order.amend.update_qty",
  "order.item.remove": "order.amend.remove_item",
};

/** Which `canPerformAction` check governs each cart-op kind's amend sibling
 *  (order-action-validator.ts — the single source of truth for "amendable",
 *  already used by amendOrder()'s own PONR gating). update/remove share one
 *  check (`checkRemoveOrUpdateQty`), matching the validator's own dispatch. */
const AMEND_ACTION_FOR_KIND: Readonly<Record<string, CustomerAction>> = {
  "order.item.add": "amend_add_item",
  "order.item.update": "amend_update_qty",
  "order.item.remove": "amend_remove_item",
};

/**
 * BKL-154 deterministic markers — pt-BR phrasing that references an
 * ALREADY-PLACED order, never the in-progress cart:
 *   - `meu pedido` — possessive singular; the customer names an existing
 *     order as theirs, not "an order" in the abstract.
 *   - `pedido que (eu )?(já )?fiz` — explicit past-tense reference ("the
 *     order I('ve) made"); covers all 4 combinations (eu/já both optional).
 *   - `pedido \d+` — an explicit numbered reference ("o pedido 910226").
 *   - `no pedido` — "in/on the order"; narrower phrasings that also say
 *     "meu"/"que já fiz"/a number already match the markers above, so this
 *     one catches the bare "adiciona X no pedido" shape Drive F's utterance
 *     combined with "que eu já fiz".
 * Deliberately NOT a bare `/pedido/` substring test: "quero fazer um
 * pedido de coca" (placing a brand-new order) contains the word "pedido"
 * but anchors to none of these four phrasings.
 */
const EXISTING_ORDER_MARKERS: readonly RegExp[] = [
  /\bmeu pedido\b/,
  /\bpedido que (eu )?(j[áa] )?fiz\b/,
  /\bpedido \d+\b/,
  /\bno pedido\b/,
];

/** Pure — no IO/clock/RNG. Case-insensitive; matches on the raw utterance
 *  text (`cognition.perception.text` at the resolver seam). */
export function referencesExistingOrder(text: string): boolean {
  const t = text.toLowerCase();
  return EXISTING_ORDER_MARKERS.some((m) => m.test(t));
}

/** First non-empty trimmed string among the candidates — mirrors
 *  resolve-and-assemble.ts's `firstString` (kept local: this module must
 *  not depend on that one's other, unrelated helpers). */
function firstNonEmptyString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Does this customer have at least one placed order the given amend action
 * could apply to RIGHT NOW (fulfillment status only — PONR timing is left
 * to the kernel guard chain the re-routed kind already reaches; even a
 * PONR-expired order should still re-route, so the customer gets an honest
 * PONR refusal on the correct target rather than a silent phantom-cart
 * mutation)? Fail-CLOSED on a read error — a DB blip must never force a
 * re-route the customer didn't ask for.
 */
async function hasAmendableOrder(customerId: string, action: CustomerAction): Promise<boolean> {
  try {
    const { orders } = await createOrderQueryService().listByCustomer(customerId, { limit: 20 });
    return (orders as ReadonlyArray<{ fulfillmentStatus: string }>).some(
      (o) =>
        canPerformAction(action, {
          fulfillmentStatus: o.fulfillmentStatus as OrderFulfillmentStatus,
        }).allowed,
    );
  } catch {
    return false;
  }
}

/** The re-routed result — a NEW kind + a minimal, remapped payload. */
export interface AmendPreferenceCorrection {
  readonly kind: string;
  readonly payload: Ctx;
}

/**
 * The correction: given a planner-proposed cart-op kind + payload + the raw
 * utterance, decide whether to re-route to the granular amend sibling.
 * Returns the corrected `{kind, payload}` or `undefined` when no correction
 * applies (the overwhelmingly common case — ordinary cart-building, or a
 * kind this correction doesn't watch, passes through untouched).
 *
 * Payload remap: cart-op kinds and the granular amend kinds both expect a
 * loose NL `item` reference (no authored extraction schema governs
 * `order.item.*` yet — FE-T10+ is blocked; the granular kinds' authored
 * schemas are `{item, quantity?}` / `{item}`). Cart-scoped fields
 * (`cartId`/`itemId`/`variantId`) are DROPPED, never carried over — they
 * reference the ACTIVE SESSION CART, not the placed order being amended;
 * `resolve-and-assemble.ts`'s existing hydration re-derives the real
 * target (variantId via `resolveProductForItem`, or a live order-line
 * itemId via `resolveOrderLineItem`) fresh from the NL `item` string.
 */
export async function correctAmendPreference(
  kind: string,
  payload: Ctx,
  utteranceText: string | undefined,
  customerId: string,
): Promise<AmendPreferenceCorrection | undefined> {
  const amendKind = CART_TO_AMEND_KIND[kind];
  if (amendKind === undefined) return undefined;
  if (utteranceText === undefined || !referencesExistingOrder(utteranceText)) return undefined;

  const action = AMEND_ACTION_FOR_KIND[kind]!;
  if (!(await hasAmendableOrder(customerId, action))) return undefined;

  const item = firstNonEmptyString(
    payload.item,
    payload.product,
    payload.productName,
    payload.name,
    payload.query,
  );
  const rerouted: Ctx = {};
  if (item !== undefined) rerouted.item = item;
  if (payload.quantity !== undefined) rerouted.quantity = payload.quantity;

  return { kind: amendKind, payload: rerouted };
}
