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
// SCOPE (deliberately narrow): only the AMEND kinds and reservation.modify
// (BKL-231) render here — every other customer verb returns `undefined`, so the
// responder falls through to its existing grounded model path BYTE-IDENTICALLY
// (item.add/checkout/reservation.cancel/… are untouched by this change;
// reservation.cancel keeps its model-prose success draft). The statement is built
// ONLY from the executed envelope kind (+ quantity / party-size where the payload
// carries it) — never a fabricated item name, order number, or time (amend
// payloads carry variantId/itemId, reservation.modify a time SLOT id, not human
// labels), so the line is grounded and honest, never confident-wrong.
//
// `executedOpsActions` is plane-neutral (it reads the @claustrum dispatch-result
// shape: `executed` / `rewritten_and_executed` / `executed_plan`), so it is
// reused here to extract the committed envelope(s) from the customer `acted`.

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

const RENDERED_KINDS: ReadonlySet<string> = new Set([
  AMEND_ADD,
  AMEND_UPDATE,
  AMEND_REMOVE,
  RESERVATION_MODIFY,
]);

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

/** Deterministic pt-BR success line for one committed mutation, grounded in the
 *  executed envelope kind (+ quantity / party-size). No item name / order number /
 *  time is invented. */
function renderAction(kind: string, payload: unknown): string {
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
 * Deterministic customer mutation-success reply, or `undefined` when NO amend
 * committed this turn (the responder then keeps its existing grounded model path
 * for every other kind — a deferred/failed dispatch is NOT a success). When ≥1
 * amend committed the return is ALWAYS a string built from the executed
 * envelope(s); the model authors none of it. Multiple amends (a transactional
 * plan) render in order, joined.
 */
export function renderCustomerActionAnswer(acted: unknown): string | undefined {
  const rendered = executedOpsActions(acted).filter((a) => RENDERED_KINDS.has(a.kind));
  if (rendered.length === 0) return undefined;
  return rendered.map((a) => renderAction(a.kind, a.payload)).join("\n\n");
}
