// BKL-130 — paid-order cancel must REFUND (adjudicated) BEFORE the cancel
// transition, so a CANCELED order never retains a LIVE paid payment.
//
// Live-reproduced on BOTH card and cash: the old executor transitioned the
// order to CANCELED first, then attempted paid→canceled on the payment (illegal
// → 409), leaving a canceled order + live paid payment. The fix builds and
// ADJUDICATES a refund envelope through the kernel first (money bands live: a
// ≥R$1000 refund ESCALATEs → no refund settle, no cancel, state whole), then —
// only on EXECUTE — cancels. Refund settlement is ledger-only (issueRefund…),
// identical for card and cash (no Stripe egress in this path). These unit tests
// drive the exported executor with stub services.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-load mocks (executeOrderCancel takes services as ARGS; these only
//    let ../routes/order-actions.js import without DB/network side effects) ────
vi.mock("@ibatexas/tools", () => ({
  medusaAdjudicated: vi.fn(async () => ({})),
  getRedisClient: vi.fn(),
  rk: (k: string) => k,
  withLock: vi.fn(),
  amendOrder: vi.fn(),
  changeDeliveryAddress: vi.fn(),
  switchOrderType: vi.fn(),
  medusaAdmin: vi.fn(),
}));
vi.mock("@ibatexas/nats-client", () => ({ publishNatsEvent: vi.fn(async () => {}) }));
vi.mock("@ibatexas/audit-sink", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getAuditSink: () => ({ emit: vi.fn(async () => {}) }),
}));
vi.mock("@ibatexas/domain", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  prisma: { orderNote: { create: vi.fn(), findMany: vi.fn(async () => []) }, payment: { update: vi.fn() } },
}));

const { executeOrderCancel, PaidCancelRefundNotSettledError } = await import(
  "../routes/order-actions.js"
);

// ── Stub-service builders ────────────────────────────────────────────────────
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;

const EXECUTE = { decision: { kind: "EXECUTE", basis: [] }, result: { version: 3 } };

function orderCmd() {
  return {
    transitionStatusFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 2, newStatus: "canceled" },
    })),
  } as never;
}

/** paymentCmd whose findActiveByOrderId yields `active1` (pre-step) then
 *  `active2` (post-refund re-read). issueRefund returns `refundDecision`. */
function paymentCmd(opts: {
  active1: { id: string; status: string; version: number } | null;
  active2?: { id: string; status: string; version: number } | null;
  refundDecisionKind?: string;
}) {
  const findActive = vi
    .fn()
    .mockResolvedValueOnce(opts.active1)
    .mockResolvedValue(opts.active2 ?? null);
  return {
    svc: {
      findActiveByOrderId: findActive,
      issueRefundFromEnvelope: vi.fn(async () => ({
        decision: { kind: opts.refundDecisionKind ?? "EXECUTE", basis: [] },
        result: { newStatus: "refunded" },
      })),
      transitionStatusFromEnvelope: vi.fn(async () => EXECUTE),
    } as never,
    findActive,
    get issueRefund() { return (this.svc as never as { issueRefundFromEnvelope: ReturnType<typeof vi.fn> }).issueRefundFromEnvelope; },
    get payTransition() { return (this.svc as never as { transitionStatusFromEnvelope: ReturnType<typeof vi.fn> }).transitionStatusFromEnvelope; },
  };
}

function paymentQuery(amountInCentavos: number) {
  return {
    getById: vi.fn(async (id: string) => ({
      id,
      amountInCentavos,
      refundedAmountCentavos: 0,
      version: 1,
      status: "paid",
    })),
  } as never;
}

const ORDER = { fulfillmentStatus: "confirmed", displayId: 42 };

beforeEach(() => vi.clearAllMocks());

describe("BKL-130 — executeOrderCancel refund-before-cancel", () => {
  it("ARM 1 (card paid <R$1000): adjudicated refund SETTLES, then order cancels; the paid→canceled attempt is never made", async () => {
    const oc = orderCmd();
    const pc = paymentCmd({ active1: { id: "pay_1", status: "paid", version: 1 }, active2: null });
    const res = await executeOrderCancel({
      orderId: "ord_1", customerId: "c1", reason: "cancel", order: ORDER,
      orderCmdSvc: oc, paymentCmdSvc: pc.svc, paymentQuerySvc: paymentQuery(5000), log,
    });
    expect(res.success).toBe(true);
    // Refund adjudicated, then the order transition — refund BEFORE cancel.
    expect(pc.issueRefund).toHaveBeenCalledOnce();
    expect((oc as never as { transitionStatusFromEnvelope: ReturnType<typeof vi.fn> }).transitionStatusFromEnvelope).toHaveBeenCalledOnce();
    const refundOrder = pc.issueRefund.mock.invocationCallOrder[0]!;
    const cancelOrder = (oc as never as { transitionStatusFromEnvelope: ReturnType<typeof vi.fn> }).transitionStatusFromEnvelope.mock.invocationCallOrder[0]!;
    expect(refundOrder).toBeLessThan(cancelOrder);
    // ARM 5 pin — the illegal paid→canceled PAYMENT transition is never attempted.
    expect(pc.payTransition).not.toHaveBeenCalled();
  });

  it("ARM 2 (CASH paid <R$1000): same adjudicated refund RECORD path (no provider/Stripe call), then cancel", async () => {
    const oc = orderCmd();
    const pc = paymentCmd({ active1: { id: "pay_cash", status: "paid", version: 1 }, active2: null });
    const res = await executeOrderCancel({
      orderId: "ord_cash", customerId: "c1", reason: "cancel", order: ORDER,
      orderCmdSvc: oc, paymentCmdSvc: pc.svc, paymentQuerySvc: paymentQuery(4000), log,
    });
    expect(res.success).toBe(true);
    // Settlement is the ledger refund (issueRefundFromEnvelope), method-agnostic —
    // no payment-cancel attempt (which is what 409'd for cash before).
    expect(pc.issueRefund).toHaveBeenCalledOnce();
    expect(pc.payTransition).not.toHaveBeenCalled();
  });

  it("ARM 3 (unpaid): unchanged — no refund, a single payment cancel then order cancel", async () => {
    const oc = orderCmd();
    const pc = paymentCmd({
      active1: { id: "pay_pending", status: "pending", version: 1 },
      active2: { id: "pay_pending", status: "pending", version: 1 },
    });
    // The post-cancel re-read shows the pending payment settled to terminal.
    pc.findActive.mockResolvedValueOnce({ id: "pay_pending", status: "pending", version: 1 })
      .mockResolvedValueOnce({ id: "pay_pending", status: "pending", version: 1 })
      .mockResolvedValue(null);
    const res = await executeOrderCancel({
      orderId: "ord_unpaid", customerId: "c1", reason: "cancel", order: ORDER,
      orderCmdSvc: oc, paymentCmdSvc: pc.svc, paymentQuerySvc: paymentQuery(0), log,
    });
    expect(res.success).toBe(true);
    expect(pc.issueRefund).not.toHaveBeenCalled();     // no refund on an unpaid order
    expect(pc.payTransition).toHaveBeenCalledOnce();    // the single pending→canceled
  });

  it("ARM 4a (card paid ≥R$1000): kernel ESCALATEs the refund → order is NOT canceled, state whole", async () => {
    const oc = orderCmd();
    const pc = paymentCmd({ active1: { id: "pay_big", status: "paid", version: 1 }, refundDecisionKind: "ESCALATE" });
    await expect(
      executeOrderCancel({
        orderId: "ord_big", customerId: "c1", reason: "cancel", order: ORDER,
        orderCmdSvc: oc, paymentCmdSvc: pc.svc, paymentQuerySvc: paymentQuery(150000), log,
      }),
    ).rejects.toBeInstanceOf(PaidCancelRefundNotSettledError);
    // State whole: refund adjudicated but NOT settled → order transition never ran.
    expect(pc.issueRefund).toHaveBeenCalledOnce();
    expect((oc as never as { transitionStatusFromEnvelope: ReturnType<typeof vi.fn> }).transitionStatusFromEnvelope).not.toHaveBeenCalled();
    expect(pc.payTransition).not.toHaveBeenCalled();
  });

  it("ARM 4b (CASH paid ≥R$1000): a big-ticket cash cancel escalates too — no cancel, state whole", async () => {
    const oc = orderCmd();
    const pc = paymentCmd({ active1: { id: "pay_big_cash", status: "paid", version: 1 }, refundDecisionKind: "ESCALATE" });
    await expect(
      executeOrderCancel({
        orderId: "ord_big_cash", customerId: "c1", reason: "cancel", order: ORDER,
        orderCmdSvc: oc, paymentCmdSvc: pc.svc, paymentQuerySvc: paymentQuery(200000), log,
      }),
    ).rejects.toBeInstanceOf(PaidCancelRefundNotSettledError);
    expect((oc as never as { transitionStatusFromEnvelope: ReturnType<typeof vi.fn> }).transitionStatusFromEnvelope).not.toHaveBeenCalled();
  });
});
