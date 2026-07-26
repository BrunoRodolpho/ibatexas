// THE PREVIOUS ORDER — LE2-021's grounding read.
//
// One owner-scoped projection of "the last thing this customer ordered", shared
// by the two places that must not disagree about it:
//
//   1. `resolve-and-assemble.ts` stamps it onto `OrderState.ctx` for the
//      `order.reorder.request` anchor, where `confirmReorderLast` reads it to
//      AUTHOR the confirm sentence the customer approves.
//   2. `register-workflow-scoped-tools.ts` reads it to fill the `order.reorder`
//      activity's `orderId`, because that identifier has no admissible source
//      anywhere upstream (see below).
//
// One module rather than two call sites of Prisma, because "which order" and
// "what the customer was told they were repeating" have to be the same answer or
// the confirmation is a lie. The window in which they could differ is one
// conversational turn wide and requires the customer to complete an entire
// checkout between reading the confirm and replying "sim" — it is stated here
// rather than papered over, and it is bounded by the fact that neither the
// confirm nor the completion template ever re-states items from a second read.
//
// ── WHY THE ORDER ID IS NOT A WORKFLOW PARAM ─────────────────────────────────
//
// `WorkflowParamSource` has exactly two members and neither can carry it. A
// `claim` param would need a registry claim type whose validated value exposes
// an order id, and none does (`ORDER_HISTORY`'s `valueBinding` is a
// pre-composed summary STRING). A `slot` param is model-EXTRACTED, and a model
// reporting an identifier is indistinguishable from a model inventing one —
// precisely the confabulation that two-member union exists to make
// unrepresentable. So it is resolved HERE, from the database, scoped to the
// authenticated customer, and it never crosses the parse seam in either
// direction.
//
// ── AND WHY THIS IS NOT AN OWNERSHIP GATE ────────────────────────────────────
//
// `order.reorder.request` is deliberately NOT in `OWNERSHIP_GATED_ORDER_KINDS`.
// That guard exists to catch an id the CUSTOMER named that belongs to someone
// else; this kind never carries a customer-named id at all, so the guard could
// not fire on any input — it would be a gate that passes because it is
// unreachable, which is the vacuity the pack's own ownership canary exists to
// prevent. The real second check is downstream and independent: `reorder`'s
// `withOrderOwnership` wrapper re-verifies the order against `ctx.customerId`
// before any business logic runs.

import { createOrderQueryService } from "@ibatexas/domain";
import type { OrderEventItem } from "@ibatexas/types";
import { logger } from "../lib/logger.js";

/** One line of a previous order, as the confirm sentence names it. */
export interface PreviousOrderLine {
  /**
   * The product name AS SOLD — the projection's own denormalized copy, never a
   * name re-fetched at read time. A reorder confirm that quoted a since-renamed
   * product would be describing something the customer never bought.
   */
  readonly title: string;
  readonly quantity: number;
}

/** The customer's most recent order, projected down to what the confirm needs. */
export interface PreviousOrder {
  /** The Medusa order id — the reorder activity's target. */
  readonly orderId: string;
  /** The display number a customer recognises. */
  readonly displayId: number;
  /** Integer centavos (Hard Rule #2). */
  readonly totalInCentavos: number;
  readonly items: readonly PreviousOrderLine[];
  /**
   * LE2-023 — the projection's own `payment_status`, VERBATIM, or `null`.
   *
   * COPIED, NOT INTERPRETED. Whether cancelling this order returns money is
   * `gatePaidCancel`'s judgement over its own
   * `CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES`, and this module deliberately does
   * not hold an opinion: a second transcription of that set here would be a
   * second source of truth for whether a customer is owed a refund, and the
   * swap-for-coupon confirm SAYS SO OUT LOUD to the customer. The set is
   * exported from `@ibatexas/pack-orders` and read once, downstream.
   */
  readonly paymentStatus: string | null;
  /**
   * LE2-023 — the projection's own `fulfillment_status`, VERBATIM.
   *
   * Same discipline, more force: the point of no return is `canCancelOrder`'s
   * judgement over `CUSTOMER_POST_PONR_FULFILLMENT`, and a workflow that decided
   * PONR for itself could offer to cancel an order the kernel is about to refuse
   * — the exact exchange feasibility pre-checks exist to delete.
   */
  readonly fulfillmentStatus: string;
}

/**
 * Narrow the projection's `itemsJson` (a Prisma `Json?` column holding
 * `OrderEventItem[]`) down to titled, positively-quantified lines.
 *
 * Structural, not trusting: the column is `Json`, so its runtime shape is a
 * hint rather than a guarantee — a row written by an older projection version,
 * or by hand, can be anything. A line missing a title or a usable quantity is
 * DROPPED rather than defaulted, because the only consumer is a sentence the
 * customer is asked to approve, and "1x undefined" is worse than a shorter
 * list. Dropping every line leaves an empty array, which `confirmReorderLast`
 * treats as no-history and refuses honestly.
 */
function readOrderLines(itemsJson: unknown): readonly PreviousOrderLine[] {
  if (!Array.isArray(itemsJson)) return [];
  const items = itemsJson as unknown as readonly Partial<OrderEventItem>[];
  const lines: PreviousOrderLine[] = [];
  for (const item of items) {
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    const quantity = typeof item?.quantity === "number" ? item.quantity : 0;
    if (title === "" || !Number.isFinite(quantity) || quantity <= 0) continue;
    lines.push({ title, quantity: Math.trunc(quantity) });
  }
  return lines;
}

/**
 * The customer's most recent order, or `null` when they have none, when the
 * newest one carries no readable lines, or when the read fails.
 *
 * FAIL-SAFE in one direction only. Every `null` path lands on the same
 * behaviour — `confirmReorderLast` REFUSEs with the honest no-history sentence
 * — so a transient database error degrades to "I could not find a previous
 * order", never to a confirmation over a basket nobody read. There is no path
 * here that returns a partially-populated order: a caller either has an id, a
 * total and at least one line, or it has nothing.
 *
 * OWNER-SCOPED by construction: `listByCustomer` filters on `customerId` in the
 * query, ordered `medusaCreatedAt desc`, so "the last order" can only ever mean
 * the last order belonging to the authenticated customer.
 */
export async function loadPreviousOrder(customerId: string): Promise<PreviousOrder | null> {
  if (customerId === "") return null;
  try {
    const { orders } = await createOrderQueryService().listByCustomer(customerId, {
      limit: 1,
    });
    const order = orders[0];
    if (order === undefined) return null;
    const items = readOrderLines(order.itemsJson);
    if (items.length === 0) return null;
    return {
      orderId: order.id,
      displayId: order.displayId,
      totalInCentavos: order.totalInCentavos,
      items,
      // Read STRUCTURALLY, exactly like `itemsJson` above: these are projection
      // columns, so a row written by an older projector can carry a shape the
      // type does not promise. An unreadable payment status reads as `null`
      // (⇒ "not settled" ⇒ no refund is promised) and an unreadable fulfillment
      // status reads as the empty string, which no PONR set contains. Both
      // unreadable cases therefore land on the SAFE side of the sentence they
      // ground: nothing is promised about money that could not be read.
      paymentStatus:
        typeof order.paymentStatus === "string" ? order.paymentStatus : null,
      fulfillmentStatus:
        typeof order.fulfillmentStatus === "string" ? order.fulfillmentStatus : "",
    };
  } catch (error) {
    logger.warn(
      {
        component: "previous-order",
        event: "previous_order.read_failed",
        error: error instanceof Error ? error.message : String(error),
      },
      "previous-order: could not read the customer's last order — the reorder confirm will refuse honestly",
    );
    return null;
  }
}
