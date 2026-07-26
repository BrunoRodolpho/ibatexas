// approved-cancel-executor — BKL-103. The POST-EXECUTE side effect for an
// OWNER-approved, escalated `order.cancel`.
//
// It runs ONLY after the audited kernel returned EXECUTE for the RESUMED
// `order.cancel` AND `executeReachedViaEscalationMarker` (escalation-approval.ts)
// confirmed that EXECUTE carried `paid_cancel_escalation_approved` — i.e. the
// verdict came from `gatePaidCancel`'s OWNER-approval marker branch and not from
// some other band that carries no owner/self-approve assertion.
//
// NO `order.cancel` RE-MINT. It calls the SHARED side-effect body
// (`executeOrderCancel`) directly, exactly as the HTTP route's `executor`
// callback does. Minting a second `order.cancel` envelope here would re-enter
// adjudication for a kind the resume already decided and emit a SECOND EXECUTE
// row for one customer action — the same-kind re-mint defect class.
//
// WHY THE REFUND IS SETTLED FIRST (the load-bearing ordering). `executeOrderCancel`
// is shared verbatim with the ordinary customer cancel, and for a STILL-PAID order
// its BKL-130 block ADJUDICATES a fresh system-actor `payment.refund.issue` — whose
// own >=R$1.000 escalate band would ESCALATE, making it throw
// `PaidCancelRefundNotSettledError`. An approved big-ticket cancel would therefore
// fail at the very last step, every time, for precisely the amounts BKL-103 exists
// to rescue. So the money reversal happens HERE as a POST-DECISION write
// (`executeRefund` → `writeAdjudicatedRefund` — the same seam the approved REFUND
// executor uses), authored by the APPROVER, and only then is `executeOrderCancel`
// invoked: by then the payment is terminal (`refunded`), its
// `paidActive.status === PAID` test is false, and the inner-refund block is skipped
// entirely. That is the ordering `executeOrderCancel`'s own BKL-130 comment already
// documents as correct ("EXECUTE ⇒ the paid payment is now REFUNDED (terminal) …
// never attempts the illegal paid→canceled transition").
//
// NO GUARD IS WEAKENED and no shared money path is edited. The >=R$1.000 refund
// AUTHORITY requirement is satisfied by the OWNER approval the kernel just audited,
// whose basis records the refund-equivalent amount, the approver, and the approver
// role. What is skipped is a SECOND adjudication of an amount an owner already
// approved — not a gate.
//
// Every dep is injected so this is unit/e2e-drivable without the composition root.

import type { PaymentRefundIssuePayload } from "@ibatexas/pack-payments";

/** The minimal order projection `executeOrderCancel` needs from a fresh read. */
export interface ApprovedCancelOrder {
  readonly fulfillmentStatus: string;
  readonly displayId: number;
}

/** The live active-payment row shape the refund-first branch tests. */
export interface ApprovedCancelActivePayment {
  readonly id: string;
  readonly status: string;
}

export interface ApprovedCancelExecutorDeps {
  /**
   * Fresh, OWNER-SCOPED order read. Scoped to the parked proposer (see
   * `readProposerId` below) so an order reassigned since parking yields null and
   * nothing is cancelled.
   */
  readonly getOrder: (
    orderId: string,
    customerId: string,
  ) => Promise<ApprovedCancelOrder | null>;
  /** The order's active (non-terminal) payment, or null. */
  readonly findActivePayment: (
    orderId: string,
  ) => Promise<ApprovedCancelActivePayment | null>;
  /** Full payment read — supplies the refundable balance. */
  readonly getPayment: (paymentId: string) => Promise<{
    readonly id: string;
    readonly amountInCentavos: number;
    readonly refundedAmountCentavos?: number | null;
  } | null>;
  /** TRUE iff the status means money is still captured (⇒ refund before cancel). */
  readonly isPaidStatus: (status: string) => boolean;
  /**
   * The POST-DECISION refund trio (`writeAdjudicatedRefund` + publish
   * `payment.status_changed` + the refund event log) — NOT a re-adjudication.
   */
  readonly settleApprovedRefund: (
    payload: PaymentRefundIssuePayload,
    approverStaffId: string,
  ) => Promise<unknown>;
  /** The SHARED cancel side-effect body (`routes/order-actions.ts`). */
  readonly runCancel: (args: {
    readonly orderId: string;
    readonly customerId: string;
    readonly reason: string;
    readonly order: ApprovedCancelOrder;
  }) => Promise<unknown>;
}

/** Fallback cancel reason when the parked payload carried none (pt-BR, rule #4). */
export const APPROVED_CANCEL_DEFAULT_REASON =
  "Cancelamento aprovado pelo proprietário";

/**
 * Build the `order.cancel` entry for `createEscalationApprovalEngine`'s
 * `executors` map. Throws on any gap — the engine turns a throw into
 * `execute_failed` (an HONEST failure), never a fabricated success.
 */
export function createApprovedOrderCancelExecutor(
  deps: ApprovedCancelExecutorDeps,
): (payload: unknown, approverStaffId: string) => Promise<void> {
  return async (payload, approverStaffId) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const orderId = typeof p.orderId === "string" ? p.orderId : "";
    // The BKL-113 proposer stamp doubles as the authenticated customer scope (see
    // `escalationResumeSeedState`). Refuse rather than cancel an order we cannot
    // scope to its owner.
    const customerId = typeof p.actorId === "string" ? p.actorId : "";
    if (orderId === "" || customerId === "") {
      throw new Error(
        "escalation approval: order.cancel payload is missing orderId/actorId — refusing to cancel",
      );
    }
    const order = await deps.getOrder(orderId, customerId);
    if (order === null) {
      throw new Error(
        `escalation approval: order ${orderId} not found for its parked owner — refusing to cancel`,
      );
    }
    const reason =
      typeof p.reason === "string" && p.reason !== ""
        ? p.reason
        : APPROVED_CANCEL_DEFAULT_REASON;

    const active = await deps.findActivePayment(orderId);
    if (active !== null && deps.isPaidStatus(active.status)) {
      const payment = await deps.getPayment(active.id);
      if (payment === null) {
        throw new Error(
          `escalation approval: active payment ${active.id} vanished — refusing to cancel`,
        );
      }
      const currentRefunded = payment.refundedAmountCentavos ?? 0;
      const refundable = payment.amountInCentavos - currentRefunded;
      await deps.settleApprovedRefund(
        {
          paymentId: payment.id,
          refundAmountCentavos: refundable,
          refundableBalanceCentavos: refundable,
          amountInCentavos: payment.amountInCentavos,
          currentRefundedCentavos: currentRefunded,
          actor: "admin",
          reason,
        } as PaymentRefundIssuePayload,
        approverStaffId,
      );
    }

    await deps.runCancel({ orderId, customerId, reason, order });
  };
}
