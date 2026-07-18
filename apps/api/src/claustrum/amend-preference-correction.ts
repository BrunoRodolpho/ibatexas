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
 *
 * Review fix (post-#268, MAJOR-1 — both-states ambiguity): a bare
 * preposition+"pedido" marker (`no pedido` / `do pedido` / `ao pedido`) is
 * genuinely ambiguous for a MID-CART customer — "põe mais uma coca no pedido"
 * colloquially means their IN-PROGRESS cart, not a placed order. The 3
 * EXPLICIT markers (`meu pedido` / `pedido que já fiz` / `pedido \d+`)
 * unambiguously name an already-placed order and always re-route regardless of
 * cart state; when ONLY an ambiguous bare marker fired, a non-empty active cart
 * wins (favor the cart — see `hasNonEmptyActiveCart`, resolve-and-
 * assemble.ts) and the correction is a no-op.
 *
 * BKL-154 (marker extension): the ticket's anchor class is
 * "no meu pedido / do pedido / pedido que já fiz". `do pedido` ("tira uma coca
 * DO pedido" — remove FROM the order) and `ao pedido` ("adiciona uma coca AO
 * pedido" — add TO the order) join the ambiguous set alongside `no pedido`:
 * they anchor an amend of an existing order but a mid-cart customer could mean
 * their in-progress cart, so they get the SAME cart-favoring tie-break. They
 * stay narrow — "quero fazer um pedido de coca" (a NEW order) is "pedido de",
 * not "do/ao/no pedido", so it still matches none of these.
 */

import { canPerformAction, type CustomerAction, type OrderFulfillmentStatus } from "@ibatexas/types";
import { createOrderQueryService } from "@ibatexas/domain";
import { hasNonEmptyActiveCart } from "./resolve-and-assemble.js";
import { logger } from "../lib/logger.js";

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

/** A single marker's name + pattern, so a caller can tell WHICH phrasing
 *  fired (needed for the both-states cart-vs-order disambiguation below,
 *  and for the audit log's `matchedMarkers` field). */
interface ExistingOrderMarker {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * BKL-154 deterministic markers — pt-BR phrasing that references an
 * ALREADY-PLACED order, never the in-progress cart:
 *   - `meuPedido` — possessive singular; the customer names an existing
 *     order as theirs, not "an order" in the abstract.
 *   - `pedidoQueFiz` — explicit past-tense reference ("the order I('ve)
 *     made"); covers all 4 combinations (eu/já both optional).
 *   - `pedidoNumero` — an explicit numbered reference ("o pedido 910226").
 *   - `noPedido` / `doPedido` / `aoPedido` — "in/from/to the order"; the bare
 *     preposition+"pedido" shapes ("adiciona X no pedido", "tira X do pedido",
 *     "adiciona X ao pedido"). Narrower phrasings that also say
 *     "meu"/"que já fiz"/a number already match the markers above. UNLIKE the
 *     first three, these three are NOT unambiguous on their own (a mid-cart
 *     customer could mean their in-progress cart) — see `EXPLICIT_MARKER_NAMES`.
 * Deliberately NOT a bare `/pedido/` substring test: "quero fazer um
 * pedido de coca" (placing a brand-new order) contains the word "pedido"
 * but anchors to none of these phrasings ("pedido de", not "no/do/ao pedido").
 */
const EXISTING_ORDER_MARKERS: readonly ExistingOrderMarker[] = [
  { name: "meuPedido", pattern: /\bmeu pedido\b/ },
  { name: "pedidoQueFiz", pattern: /\bpedido que (eu )?(j[áa] )?fiz\b/ },
  { name: "pedidoNumero", pattern: /\bpedido \d+\b/ },
  { name: "noPedido", pattern: /\bno pedido\b/ },
  // BKL-154 — the "do pedido" / "ao pedido" anchors (ambiguous, cart-favoring).
  { name: "doPedido", pattern: /\bdo pedido\b/ },
  { name: "aoPedido", pattern: /\bao pedido\b/ },
];

/** Markers that unambiguously name an ALREADY-PLACED order regardless of
 *  cart state — possessive, past-tense, or numbered. The bare
 *  preposition+"pedido" markers (`noPedido` / `doPedido` / `aoPedido`) are
 *  deliberately excluded (MAJOR-1): they are the ones a mid-cart customer
 *  plausibly uses to mean their in-progress cart, so they take the
 *  cart-favoring tie-break instead of always re-routing. */
const EXPLICIT_MARKER_NAMES: ReadonlySet<string> = new Set([
  "meuPedido",
  "pedidoQueFiz",
  "pedidoNumero",
]);

/** Pure — no IO/clock/RNG. Case-insensitive. Returns every marker NAME that
 *  fired (order-independent; a caller checks membership, not position). */
export function matchedExistingOrderMarkers(text: string): readonly string[] {
  const t = text.toLowerCase();
  return EXISTING_ORDER_MARKERS.filter((m) => m.pattern.test(t)).map((m) => m.name);
}

/** Pure — no IO/clock/RNG. `true` iff at least one existing-order marker
 *  fired (case-insensitive). Matches on the raw utterance text
 *  (`cognition.perception.text` at the resolver seam). */
export function referencesExistingOrder(text: string): boolean {
  return matchedExistingOrderMarkers(text).length > 0;
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
 * applies (the overwhelmingly common case — ordinary cart-building, a kind
 * this correction doesn't watch, or the both-states cart-vs-order tie
 * favoring the cart — passes through untouched).
 *
 * `sessionId` powers the MAJOR-1 both-states check (`hasNonEmptyActiveCart`,
 * the SAME BKL-028 active-cart key `resolveAndAssemble`'s own cart loader
 * uses) — `undefined` is treated as "no cart" (fail-closed to the SAFER
 * side for the cart-vs-order tie, i.e. still eligible to re-route on a
 * bare `no pedido`, matching HTTP callers that never carry a conductor
 * session at all).
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
 *
 * MAJOR-2 (audit honesty) — a rewrite is silent to the kernel BY DESIGN
 * (the rebuilt envelope is indistinguishable from a genuine model
 * proposal, so the guard chain adjudicates it exactly like one), so this
 * is the ONLY seam that ever observes the substitution. Every actual
 * correction is logged (`component: "resolver", event:
 * "amend_preference_correction"`) — never on a pass-through, so the log
 * volume tracks real corrections one-to-one.
 */
export async function correctAmendPreference(
  kind: string,
  payload: Ctx,
  utteranceText: string | undefined,
  customerId: string,
  sessionId?: string,
): Promise<AmendPreferenceCorrection | undefined> {
  const amendKind = CART_TO_AMEND_KIND[kind];
  if (amendKind === undefined) return undefined;
  if (utteranceText === undefined) return undefined;

  const matched = matchedExistingOrderMarkers(utteranceText);
  if (matched.length === 0) return undefined;

  // MAJOR-1 — the both-states tie: ONLY the ambiguous bare "no pedido"
  // fired (no explicit possessive/past-tense/numbered marker), AND the
  // customer has items sitting in their active cart right now. Favor the
  // cart — a mid-cart "põe mais uma coca no pedido" almost certainly means
  // the cart, not a placed order.
  const hasExplicitMarker = matched.some((m) => EXPLICIT_MARKER_NAMES.has(m));
  if (!hasExplicitMarker && (await hasNonEmptyActiveCart(sessionId))) return undefined;

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

  logger.info(
    {
      component: "resolver",
      event: "amend_preference_correction",
      fromKind: kind,
      toKind: amendKind,
      matchedMarkers: matched,
      customerId,
    },
    "amend-preference correction re-routed a cart-op proposal to its granular amend sibling (BKL-154)",
  );

  return { kind: amendKind, payload: rerouted };
}
