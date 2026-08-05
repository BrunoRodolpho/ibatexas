// F-48 — the cart tools' staff-reaching escalation path.
//
// ── What was broken ────────────────────────────────────────────────────────
//
// Three cart-tool sites published `order.escalation_needed` while telling the
// customer "Um atendente foi notificado." That subject had ZERO subscribers —
// a dead event that evaporated, exactly the class BKL-181 recorded when it
// removed the payment-lifecycle publisher ("it had NO subscriber — a dead
// event that evaporated") but left these three producers behind. The customer
// was told a human had been notified; no human ever was.
//
// ── The fix ────────────────────────────────────────────────────────────────
//
// Publish on `support.handoff_requested` — the repo-RATIFIED staff spine
// (`apps/api/src/subscribers/handoff-subscriber.ts`), which records the
// escalation (pausing the bot + enqueuing the session for staff takeover in the
// Escalações panel) AND fires the staff WhatsApp ping. This is BKL-103's exact
// recipe, reused: that ticket made the paid-cancel "a human will handle it"
// promise TRUE the same way (`apps/api/src/routes/order-actions.ts`).
//
// ── The SYNTHETIC sessionId, and why the prefix matters ────────────────────
//
// These tools escalate about an ORDER, not a conversation, so the escalation is
// keyed by the order — the `dispute:{id}` / `order-cancel:{id}` precedent. The
// handoff-subscriber dedups on `handoff:{sessionId}` with a SEVEN-DAY TTL
// (`NATS_DEDUP_TTL`, subscribers/dedup.ts), so the key is also the flood
// control: a customer retrying an amend six times yields exactly ONE staff
// record + ONE WhatsApp ping. Volume is therefore bounded by DISTINCT ORDERS,
// never by attempts.
//
// The cancel prefix is deliberately NOT `order-cancel:` — that exact string is
// BKL-103's key on the HTTP paid-cancel plane, where the escalation carries a
// park token an OWNER approves. Sharing it would let a cheap notification-only
// PONR escalation land FIRST and claim the dedup key, making the subscriber
// return early on the later paid-cancel event — so `appendPendingIntent` would
// never run and the Approve button would silently never appear. Distinct
// prefixes keep the two families from cannibalising each other's staff record.
//
// ── Why the reason text is a system-authored constant ──────────────────────
//
// `reason` is interpolated VERBATIM into the staff WhatsApp alert, between two
// system-authored lines and directly above the OWNER-approval / deep-link
// lines. pack-whatsapp's `sanitizeHandoffReason` REWRITE guard strips newlines
// and markdown from customer-proposed reasons — but it fires at the KERNEL seam
// on the `whatsapp.handoff.request` kind ONLY. These publishes do not pass
// through the kernel, so NOTHING would sanitize a string sourced from here.
// Every reason below is therefore a fixed system constant; the only
// interpolated value is the order reference (a Medusa display number, or an
// order id that has already passed the caller's ownership check). Item titles
// are deliberately excluded: on the HTTP batch-amend plane `itemTitle` comes
// straight from the request body, which would be a customer-controlled string
// on a staff-bound message. Staff open the order to see the item.
//
// No customer identifier rides the event either — the BKL-103 PII discipline
// (the escalation row references the order, never the person).

import { publishNatsEvent } from "@ibatexas/nats-client";
import type { OrderFulfillmentStatus } from "@ibatexas/types";

/**
 * The escalation situations these tools can raise. One entry per site that
 * tells the customer an attendant was notified AND can actually reach staff.
 *
 * `amend_denied_needs_staff` covers BOTH escalating arms of the shared
 * `checkRemoveOrUpdateQty` validator (order-action-validator.ts): the
 * 'preparing'-state denial (:77) and the PONR-expired denial (:79). It is keyed
 * on the validator's own `escalate` flag rather than on a per-arm situation,
 * which is what makes it cover both: whichever arm produced the denial, the
 * publish fires. A per-arm split was considered and rejected — :79 cannot be
 * reached by any current caller (all three pass only `fulfillmentStatus`, and
 * `withinPonr` returns true without PONR context), so a dedicated :79 branch
 * would be unreachable code guarded by an untestable claim. Keying on
 * `escalate` also means a future caller that DOES supply PONR context is wired
 * the day it starts denying, with no further change here.
 */
export type OrderEscalationSituation =
  | "amend_remove_past_ponr"
  | "amend_qty_past_ponr"
  | "amend_denied_needs_staff"
  | "cancel_past_ponr";

/**
 * pt-BR labels for the fulfillment states a denied amend can be in. Closed
 * table over the seven-status universe — the value is a system enum read from
 * the order projection, never customer text, so it is safe on a staff-bound
 * string.
 */
const FULFILLMENT_LABEL_PT_BR: Record<OrderFulfillmentStatus, string> = {
  pending: "aguardando confirmação",
  confirmed: "confirmado",
  preparing: "em preparo",
  ready: "pronto",
  in_delivery: "em entrega",
  delivered: "entregue",
  canceled: "cancelado",
};

/**
 * System-authored pt-BR reason per situation. NEVER interpolate customer- or
 * LLM-derived text into these — see the header note on sanitization.
 */
const SITUATION_REASON_PT_BR: Record<OrderEscalationSituation, string> = {
  amend_remove_past_ponr: "Remoção de item solicitada após o prazo de alteração",
  amend_qty_past_ponr: "Alteração de quantidade solicitada após o prazo de alteração",
  amend_denied_needs_staff: "Alteração de pedido recusada — cliente precisa de atendimento",
  cancel_past_ponr: "Cancelamento solicitado após o prazo de cancelamento",
};

/**
 * The dedup FAMILY each situation belongs to (the `sessionId` prefix). Both
 * amend situations share one family on purpose: staff engaged on an order's
 * amend problem should not be paged again for the same order. `cancel_past_ponr`
 * stays out of BKL-103's `order-cancel:` family — see the header.
 */
const SITUATION_SESSION_PREFIX: Record<OrderEscalationSituation, string> = {
  amend_remove_past_ponr: "order-amend",
  amend_qty_past_ponr: "order-amend",
  // Deliberately the SAME family as the two PONR sites. This is the volume
  // control the governor's ruling turns on: an order amended three times while
  // preparing claims one dedup key and therefore pages staff ONCE, and an order
  // that hits a state denial AND later a PONR denial still pages once.
  amend_denied_needs_staff: "order-amend",
  cancel_past_ponr: "order-cancel-ponr",
};

/**
 * The synthetic, order-keyed session id this escalation is filed under. Exported
 * because it IS the dedup contract: the handoff-subscriber's `handoff:{sessionId}`
 * claim and the Escalações row are both keyed by this exact string.
 */
export function orderEscalationSessionId(
  situation: OrderEscalationSituation,
  orderId: string,
): string {
  return `${SITUATION_SESSION_PREFIX[situation]}:${orderId}`;
}

/**
 * The staff-facing reason line. `displayId` is Medusa's human order number and
 * is preferred when present; otherwise the internal order id is the handle
 * staff can look the order up by.
 */
export function orderEscalationReason(
  situation: OrderEscalationSituation,
  orderId: string,
  displayId?: number,
  fulfillmentStatus?: OrderFulfillmentStatus,
): string {
  const ref =
    typeof displayId === "number" && Number.isFinite(displayId) && displayId > 0
      ? `#${displayId}`
      : orderId;
  // The state is what tells staff WHY the change was refused, and it is the
  // only thing distinguishing the two validator arms on the wire. Looked up
  // through the closed table so an unknown string can never reach the message.
  const label =
    fulfillmentStatus === undefined
      ? undefined
      : FULFILLMENT_LABEL_PT_BR[fulfillmentStatus];
  const suffix = label === undefined ? "" : ` (${label})`;
  return `${SITUATION_REASON_PT_BR[situation]} — pedido ${ref}${suffix}`;
}

/**
 * Put an order escalation on the staff surface.
 *
 * Fire-and-forget by design — matching BKL-103's rationale: the customer's
 * reply must never fail on a NATS hiccup, and the kernel audit row is the
 * fallback truth. A publish failure logs loudly rather than rejecting, so a
 * caller's `void` can never become an unhandled rejection.
 */
export function publishOrderEscalation(args: {
  readonly situation: OrderEscalationSituation;
  readonly orderId: string;
  readonly displayId?: number;
  readonly fulfillmentStatus?: OrderFulfillmentStatus;
}): void {
  const { situation, orderId, displayId, fulfillmentStatus } = args;
  void (async () => {
    try {
      await publishNatsEvent("support.handoff_requested", {
        sessionId: orderEscalationSessionId(situation, orderId),
        reason: orderEscalationReason(situation, orderId, displayId, fulfillmentStatus),
      });
    } catch (err) {
      console.error(
        `[order-escalation] support.handoff_requested publish FAILED for ${situation} on ${orderId} — the escalation is audit-row-only until the customer retries:`,
        (err as Error).message,
      );
    }
  })();
}
