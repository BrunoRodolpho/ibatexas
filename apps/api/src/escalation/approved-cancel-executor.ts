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
// to rescue.
//
// So the reversal is settled HERE FIRST, and — critically — settled THROUGH THE
// AUDITED KERNEL on the APPROVER's authority (`settleApprovedInnerRefund`, see
// ./approved-inner-refund.ts): the inner refund envelope is adjudicated against the
// COMPOSED router with the AUT-017 marker + a matching confirmation receipt, so it
// reaches EXECUTE via the escalate band's OWN marker branch
// (`refund_escalation_approved`). Every centavo keeps its own kernel decision and
// audit row. It is NOT a raw `writeAdjudicatedRefund` bypass — that would move real
// money with no adjudication at all.
//
// Only after the refund is settled is `executeOrderCancel` invoked: by then the
// payment is terminal (`refunded`), its `paidActive.status === PAID` test is false,
// and the BKL-130 inner-refund block is skipped entirely. That is the ordering
// `executeOrderCancel`'s own comment already documents as correct ("EXECUTE ⇒ the
// paid payment is now REFUNDED (terminal) … never attempts the illegal
// paid→canceled transition").
//
// NO GUARD IS WEAKENED and no shared money path is edited. The >=R$1.000 refund
// AUTHORITY requirement is SATISFIED by a real OWNER approval that the kernel
// adjudicated and audited — not side-stepped.
//
// WRITE-PATH CHOICE (divergent write paths, stated deliberately): the executor
// targets `executeOrderCancel` (the projection command-service path), NOT the
// Medusa-tooled `cancelOrder`. Only `executeOrderCancel` carries the
// P2-LOGIC-CANCELPAY payment-terminality guard and withholds the `order.canceled`
// emit until the payment is provably terminal — the two properties an approved paid
// cancel depends on. `cancelOrder` is not an acceptable substitute here.
//
// Every dep is injected so this is unit/e2e-drivable without the composition root.

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
   * Settle the implied refund THROUGH THE AUDITED KERNEL on the approver's
   * authority (production: `settleApprovedInnerRefund`). MUST throw when the refund
   * does not reach a marker-basis EXECUTE — the caller then never cancels the order
   * (no-half-apply: no reversed money ⇒ no cancel).
   */
  readonly settleInnerRefund: (args: {
    readonly orderId: string;
    readonly paymentId: string;
    readonly amountInCentavos: number;
    readonly currentRefundedCentavos: number;
    /** The CANCEL's proposer — the pack overlay's self-approve comparand. */
    readonly proposerId: string;
    readonly approver: { readonly id: string; readonly role: string };
    readonly reason: string;
  }) => Promise<{ readonly settled: boolean }>;
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
): (
  payload: unknown,
  approverStaffId: string,
  approverRole?: string,
) => Promise<void> {
  return async (payload, approverStaffId, approverRole) => {
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
      // The approver ROLE is threaded from the resolve surface. It is REQUIRED
      // rather than defaulted: the inner refund's overlay hard-gates on "OWNER",
      // and silently substituting one would be inventing authority. (The resumed
      // cancel's own EXECUTE already proved an OWNER marker, and the resolve route
      // is `requireOwnerRole`-gated — this stays explicit anyway.)
      if (approverRole === undefined || approverRole === "") {
        throw new Error(
          "escalation approval: order.cancel executor received no approver role — refusing to settle the implied refund",
        );
      }
      await deps.settleInnerRefund({
        orderId,
        paymentId: payment.id,
        amountInCentavos: payment.amountInCentavos,
        currentRefundedCentavos: payment.refundedAmountCentavos ?? 0,
        // The CANCEL's proposer (the stamped customer) rides the refund payload so
        // the pack overlay's `approverId !== payload.actorId` is a REAL inequality.
        proposerId: customerId,
        approver: { id: approverStaffId, role: approverRole },
        reason,
      });
    }

    await deps.runCancel({ orderId, customerId, reason, order });
  };
}
