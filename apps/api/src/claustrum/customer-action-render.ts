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
// SCOPE (deliberately narrow): only the AMEND kinds render here — every other
// customer verb returns `undefined`, so the responder falls through to its
// existing grounded model path BYTE-IDENTICALLY (item.add/checkout/cancel/… are
// untouched by this change). The statement is built ONLY from the executed
// envelope kind (+ quantity where the payload carries it) — never a fabricated
// item name or order number (the amend payloads carry variantId/itemId, not
// human labels), so the line is grounded and honest, never confident-wrong.
//
// `executedOpsActions` is plane-neutral (it reads the @claustrum dispatch-result
// shape: `executed` / `rewritten_and_executed` / `executed_plan`), so it is
// reused here to extract the committed envelope(s) from the customer `acted`.

import { executedOpsActions } from "../ops/ops-action-render.js";

const AMEND_ADD = "order.amend.add_item";
const AMEND_UPDATE = "order.amend.update_qty";
const AMEND_REMOVE = "order.amend.remove_item";

const AMEND_KINDS: ReadonlySet<string> = new Set([
  AMEND_ADD,
  AMEND_UPDATE,
  AMEND_REMOVE,
]);

/** A positive integer quantity from the executed payload, else undefined. */
function quantityOf(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const q = (payload as { quantity?: unknown }).quantity;
  return typeof q === "number" && Number.isInteger(q) && q > 0 ? q : undefined;
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
  const amends = executedOpsActions(acted).filter((a) => AMEND_KINDS.has(a.kind));
  if (amends.length === 0) return undefined;
  return amends.map((a) => renderAmend(a.kind, a.payload)).join("\n\n");
}
