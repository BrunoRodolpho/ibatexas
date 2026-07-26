// BKL-215 — the CUSTOMER-plane deterministic mutation-success render (the
// customer analog of ops-action-render.ts's renderOpsActionAnswer / BKL-149).
//
// WHY: on a COMMITTED customer EXECUTE the responder has no deterministic action
// render (only the ops plane wired one), so it free-proses the "what I did" line
// from the model. On the amend kinds the weak 4B live-composed a FALSE FAILURE —
// "Seu pedido foi processado, mas houve um erro ao adicionar o item" — on a turn
// whose order.amend.add_item + medusa.admin.order.edit.create BOTH executed
// (audit-confirmed). A customer told their order failed on a real success is the
// inverse of the false-success class the SUCCESS_CLAIM_CLASSES guard polices.
//
// SCOPE (deliberately narrow): only the AMEND kinds, reservation.modify
// (BKL-231) and order.checkout.create (BKL-230) render here — every other
// customer verb returns `undefined`, so the responder falls through to its
// existing grounded model path BYTE-IDENTICALLY (item.add/reservation.cancel/…
// are untouched by this change; reservation.cancel keeps its model-prose success
// draft). The statement is built ONLY from the executed envelope kind (+ quantity
// / party-size where the payload carries it, + the dispatch RESULT for checkout)
// — never a fabricated item name, order number, or time (amend payloads carry
// variantId/itemId, reservation.modify a time SLOT id, not human labels), so the
// line is grounded and honest, never confident-wrong.
//
// `executedOpsActions` is plane-neutral (it reads the @claustrum dispatch-result
// shape: `executed` / `rewritten_and_executed` / `executed_plan`), so it is
// reused here to extract the committed envelope(s) from the customer `acted`.
// It already carries each execution's `result` — the tool executor's OWN return
// value, verbatim — which is what makes the BKL-230 outcome grounding below
// possible without widening this module's `(acted)` signature.

import { executedOpsActions } from "../ops/ops-action-render.js";

const AMEND_ADD = "order.amend.add_item";
const AMEND_UPDATE = "order.amend.update_qty";
const AMEND_REMOVE = "order.amend.remove_item";

// BKL-231 — reservation.modify is the reservation sibling of the amend kinds:
// on its confirm-resume EXECUTE the responder had no deterministic action render
// (reservation.CANCEL rides its model-prose success draft, which passes the
// reservation-canceled SUCCESS_CLAIM_CLASS; but reservation.MODIFY's resume left
// no draft, so rule-3b (claims-render-precedence) had nothing to keep and the
// degenerate render surfaced — the customer's party-size change APPLIED in the DB
// but they saw no confirmation). Rendering it here gives rule-3b a draft to hold.
const RESERVATION_MODIFY = "reservation.modify";

// BKL-230 — order.checkout.create had no deterministic render at all: the cash
// success line was MODEL prose that survived rule-3b by luck, and a PIX turn
// (whose resume leaves no draft) degraded to UNKNOWN.
//
// Checkout is also the first kind here to render from the dispatch RESULT rather
// than the payload alone, because its EXECUTE can COMMIT at the kernel and still
// FAIL in the tool: `createCheckout` has several `success:false` early returns
// (payment-init failure, missing PIX name/email) that RETURN rather than throw,
// and @claustrum's dispatcher decides `executed` vs `failed` purely on whether
// `tool.execute` THREW (execution/dispatch.js — it never inspects the returned
// value), so those land here as `executed` carrying a `success:false` result. A
// deterministic success line on one of those is precisely the FALSE-CLAIM class
// this module exists to kill. Checkout therefore renders ONLY when the tool's own
// return PROVES success, and only for the two payment methods whose outcome is
// knowable at this seam:
//   - `pix`  → the QR exists but the ORDER IS NOT CONFIRMED YET (payment pending),
//              so the copy promises confirmation in the FUTURE and NEVER voices
//              `result.orderId` — on this branch that field is a Stripe `pi_…`
//              PaymentIntent id, not a customer-facing order number.
//   - `cash` → the cart completed, so the order exists; its `result.orderId` is
//              the formatted IBX-#### display id, voiced only when it actually
//              matches that shape (it falls back to a raw Medusa `order_…` id
//              when the projection carries no display_id — never leak that).
// `card` (a client-secret handoff, nothing placed yet) and every `success:false`
// return fall through to `undefined`, preserving today's behaviour exactly: the
// model draft voices those, as it does now.
const CHECKOUT_CREATE = "order.checkout.create";

const RENDERED_KINDS: ReadonlySet<string> = new Set([
  AMEND_ADD,
  AMEND_UPDATE,
  AMEND_REMOVE,
  RESERVATION_MODIFY,
  CHECKOUT_CREATE,
]);

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

/** A positive integer quantity from the executed payload, else undefined. */
function quantityOf(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const q = (payload as { quantity?: unknown }).quantity;
  return typeof q === "number" && Number.isInteger(q) && q > 0 ? q : undefined;
}

/** A positive integer party size from the executed reservation.modify payload. */
function newPartySizeOf(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const n = (payload as { newPartySize?: unknown }).newPartySize;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Deterministic pt-BR success line for a committed reservation.modify, grounded
 *  in the executed payload. Party-size is the one human-readable field the payload
 *  carries directly (BKL-227); a time change stamps only `newTimeSlotId` (an opaque
 *  id, not a human time — BKL-229 is the time-recovery follow-up), so a non-party
 *  modify renders a grounded generic line rather than fabricating a time. */
function renderReservationModify(payload: unknown): string {
  const partySize = newPartySizeOf(payload);
  return partySize !== undefined
    ? `Pronto! Sua reserva foi alterada para ${partySize} ${partySize === 1 ? "pessoa" : "pessoas"}.`
    : "Pronto! Sua reserva foi atualizada.";
}

/** The customer-facing display order number (`formatOrderId`, @ibatexas/types),
 *  or undefined for anything else — notably a raw Medusa `order_…` id (the cash
 *  fallback when the projection carries no display_id) and a Stripe `pi_…`
 *  PaymentIntent id. Only this shape is ever voiced. */
const DISPLAY_ORDER_ID = /^IBX-\d{4,}$/;

function displayOrderIdOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const id = result.orderId;
  return typeof id === "string" && DISPLAY_ORDER_ID.test(id) ? id : undefined;
}

/** The executor's own `paymentMethod`, else undefined. Read from the RESULT, never
 *  the payload: the payload carries what the model/resolver PROPOSED, the result
 *  what the tool actually did. */
function paymentMethodOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const m = result.paymentMethod;
  return typeof m === "string" ? m : undefined;
}

/**
 * BKL-230 — the checkout success line, grounded in the tool's OWN outcome.
 * `undefined` unless the executor explicitly returned `success === true`: a
 * kernel EXECUTE is NOT evidence the checkout succeeded (see the CHECKOUT_CREATE
 * note above), and an absent / non-boolean / false `success` must never be read
 * as one. `card` and unknown methods also return `undefined` — nothing is placed
 * on a client-secret handoff, so there is no success to state.
 */
function renderCheckoutCreate(result: unknown): string | undefined {
  if (!isRecord(result) || result.success !== true) return undefined;
  const method = paymentMethodOf(result);
  if (method === "pix") {
    // The QR is generated; the ORDER IS NOT CONFIRMED YET. The future-tense
    // clause is the honest part — and it is why this line can never read as a
    // settled payment. No id is voiced (it is a `pi_…`, not an order number).
    return "Seu código PIX foi gerado! O pedido será confirmado assim que o pagamento for aprovado.";
  }
  if (method === "cash") {
    // The cart completed ⇒ the order exists. Says nothing about the payment
    // (cash is still pending) and nothing about WHERE it is paid (a cash order
    // may be pickup or delivery — the result does not distinguish them).
    const displayId = displayOrderIdOf(result);
    return displayId !== undefined
      ? `Pronto! Seu pedido ${displayId} foi confirmado.`
      : "Pronto! Seu pedido foi confirmado.";
  }
  return undefined;
}

/**
 * BKL-247 — did the executor EXPLICITLY report failure? Like `createCheckout`,
 * `amendOrder` (packages/tools/src/cart/amend-order.ts:261,:320,:361,:369,:389,
 * :439 — e.g. "Item … não encontrado no pedido.") and `modifyReservation`
 * (packages/tools/src/reservation/modify-reservation.ts:139 on a kernel REFUSE,
 * :168 in its catch-all — its body never throws) RETURN `success:false` rather
 * than throwing, and @claustrum's dispatcher decides `executed` vs `failed`
 * purely on whether `tool.execute` THREW, so those land here as `executed`
 * carrying a failed result. Pre-BKL-247 they rendered the full success line
 * ("Pronto! Removi o item do seu pedido." on an item that was never found) —
 * the same false-claim class BKL-230 killed for checkout.
 *
 * THE POLARITY IS DELIBERATELY THE INVERSE OF CHECKOUT'S, and both halves matter:
 *   - Checkout gates on `success === true` (render only on PROVEN success)
 *     because its render reads the RESULT (payment method, order id): with no
 *     result there is nothing to say, so demanding proof costs nothing.
 *   - Amend / reservation.modify gate on `success !== false` (render UNLESS
 *     failure was REPORTED) because their render is grounded in the PAYLOAD, and
 *     the committed BKL-215/BKL-231 fixtures pinned at the seam carry no `success`
 *     field at all (`{ ok: true }`, `{}`). Checkout's `=== true` polarity would
 *     silently stop rendering every one of them — a regression to the very
 *     false-FAILURE this module was built to kill.
 * That asymmetry is safe because `AmendOrderResult.success` and
 * `ModifyReservationOutput.success` are both REQUIRED booleans: every real
 * failure sets `success:false` explicitly, so `!== false` misses none, while
 * absent-`success` legacy shapes keep rendering exactly as they do today.
 */
function executorReportedFailure(result: unknown): boolean {
  return isRecord(result) && result.success === false;
}

/** Deterministic pt-BR success line for one committed mutation, grounded in the
 *  executed envelope kind (+ quantity / party-size, + the dispatch result for
 *  checkout), or `undefined` when the executed kind proved no success (checkout)
 *  or REPORTED failure (amend / reservation.modify — BKL-247). No item name /
 *  order number / time is invented. */
function renderAction(kind: string, payload: unknown, result: unknown): string | undefined {
  if (kind === CHECKOUT_CREATE) return renderCheckoutCreate(result);
  // BKL-247: a reported failure falls through to `undefined` — the same
  // fall-through the checkout branch uses, so the responder's grounded model
  // path voices the executor's own failure message, as it does today.
  if (executorReportedFailure(result)) return undefined;
  if (kind === RESERVATION_MODIFY) return renderReservationModify(payload);
  return renderAmend(kind, payload);
}

/** Deterministic pt-BR success line for one committed amend, grounded in the
 *  executed envelope kind (+ quantity). No item name / order number is invented. */
function renderAmend(kind: string, payload: unknown): string {
  if (kind === AMEND_ADD) {
    const q = quantityOf(payload);
    return q !== undefined && q > 1
      ? `Pronto! Adicionei ${q} unidades ao seu pedido.`
      : "Pronto! Adicionei o item ao seu pedido.";
  }
  if (kind === AMEND_UPDATE) {
    const q = quantityOf(payload);
    return q !== undefined
      ? `Pronto! Atualizei a quantidade para ${q} no seu pedido.`
      : "Pronto! Atualizei a quantidade no seu pedido.";
  }
  // AMEND_REMOVE
  return "Pronto! Removi o item do seu pedido.";
}

/**
 * Deterministic customer mutation-success reply, or `undefined` when NO rendered
 * kind committed this turn — or when the one that did PROVED no success (BKL-230
 * checkout) or REPORTED failure (BKL-247 amend / reservation.modify): a kernel
 * EXECUTE is never on its own evidence that the TOOL succeeded, on any kind here.
 * The responder then keeps its existing grounded model path for every
 * other kind; a deferred/failed dispatch is NOT a success. When ≥1 rendered kind
 * committed with a proven outcome the return is ALWAYS a string built from the
 * executed envelope(s) + result(s); the model authors none of it. Multiple actions
 * (a transactional plan) render in order, joined — an action that renders nothing
 * drops out rather than emptying the reply.
 */
export function renderCustomerActionAnswer(acted: unknown): string | undefined {
  const lines = executedOpsActions(acted)
    .filter((a) => RENDERED_KINDS.has(a.kind))
    .map((a) => renderAction(a.kind, a.payload, a.result))
    .filter((line): line is string => line !== undefined);
  return lines.length === 0 ? undefined : lines.join("\n\n");
}
