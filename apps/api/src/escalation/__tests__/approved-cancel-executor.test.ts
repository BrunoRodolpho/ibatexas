// approved-cancel-executor — BKL-103. Unit proof of the FAIL-CLOSED branches and
// the load-bearing REFUND-BEFORE-CANCEL ordering.
//
// The e2e (`__tests__/chat-cancel-escalate-approve.e2e.test.ts`) proves the happy
// loop through a real turn. These arms cover what an e2e cannot cheaply reach: the
// gaps where a parked cancel must NOT execute, and the unpaid path. Every arm
// asserts a REFUSAL to act — an executor throw is what the engine converts into
// `execute_failed` (an HONEST failure), never a fabricated success.

import { describe, expect, it, vi } from "vitest";
import {
  createApprovedOrderCancelExecutor,
  APPROVED_CANCEL_DEFAULT_REASON,
  type ApprovedCancelExecutorDeps,
} from "../approved-cancel-executor.js";

const ORDER_ID = "order_1";
const CUSTOMER = "cust_1";
const APPROVER = "owner_approver";
const PAYMENT_ID = "pay_1";

const STAMPED_PAYLOAD = {
  orderId: ORDER_ID,
  reason: "mudei de ideia",
  actorId: CUSTOMER,
};

function makeDeps(overrides: Partial<ApprovedCancelExecutorDeps> = {}) {
  const settleInnerRefund = vi.fn<ApprovedCancelExecutorDeps["settleInnerRefund"]>(
    async () => ({ settled: true }),
  );
  const runCancel = vi.fn<ApprovedCancelExecutorDeps["runCancel"]>(
    async () => undefined,
  );
  const deps: ApprovedCancelExecutorDeps = {
    getOrder: async (orderId, customerId) =>
      orderId === ORDER_ID && customerId === CUSTOMER
        ? { fulfillmentStatus: "confirmed", displayId: 4242 }
        : null,
    findActivePayment: async () => ({ id: PAYMENT_ID, status: "paid" }),
    getPayment: async (id) =>
      id === PAYMENT_ID
        ? { id: PAYMENT_ID, amountInCentavos: 150_000, refundedAmountCentavos: 0 }
        : null,
    isPaidStatus: (status) => status === "paid",
    settleInnerRefund,
    runCancel,
    ...overrides,
  };
  return { deps, settleInnerRefund, runCancel };
}

describe("BKL-103 — createApprovedOrderCancelExecutor", () => {
  it("settles the approved refund BEFORE the cancel, authored by the APPROVER", async () => {
    const { deps, settleInnerRefund, runCancel } = makeDeps();
    const order: string[] = [];
    const exec = createApprovedOrderCancelExecutor({
      ...deps,
      settleInnerRefund: async (a) => {
        order.push("refund");
        return settleInnerRefund(a);
      },
      runCancel: async (args) => {
        order.push("cancel");
        await runCancel(args);
      },
    });

    await exec(STAMPED_PAYLOAD, APPROVER, "OWNER");

    // THE ORDERING IS THE POINT: settling first makes the payment terminal, so
    // `executeOrderCancel`'s BKL-130 inner refund (which would itself ESCALATE at
    // this amount and throw) is skipped.
    expect(order).toEqual(["refund", "cancel"]);
    expect(settleInnerRefund).toHaveBeenCalledTimes(1);
    expect(settleInnerRefund.mock.calls[0]![0]).toMatchObject({
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      // Balances come from the LIVE payment row, never the parked payload.
      amountInCentavos: 150_000,
      currentRefundedCentavos: 0,
      // The CANCEL's proposer rides through as the self-approve comparand.
      proposerId: CUSTOMER,
      approver: { id: APPROVER, role: "OWNER" },
    });
    expect(runCancel).toHaveBeenCalledTimes(1);
    expect(runCancel.mock.calls[0]![0]).toMatchObject({
      orderId: ORDER_ID,
      customerId: CUSTOMER,
      reason: "mudei de ideia",
    });
  });

  it("refunds only the REMAINING balance when the order was partially refunded", async () => {
    const { deps, settleInnerRefund } = makeDeps({
      getPayment: async () => ({
        id: PAYMENT_ID,
        amountInCentavos: 150_000,
        refundedAmountCentavos: 50_000,
      }),
    });
    await createApprovedOrderCancelExecutor(deps)(STAMPED_PAYLOAD, APPROVER, "OWNER");
    // The executor passes the LIVE balances through; the remaining-balance
    // arithmetic itself is settleApprovedInnerRefund's job (proven in its own suite).
    expect(settleInnerRefund.mock.calls[0]![0]).toMatchObject({
      amountInCentavos: 150_000,
      currentRefundedCentavos: 50_000,
    });
  });

  it("an UNPAID order skips the refund entirely and just cancels", async () => {
    const { deps, settleInnerRefund, runCancel } = makeDeps({
      findActivePayment: async () => null,
    });
    await createApprovedOrderCancelExecutor(deps)(STAMPED_PAYLOAD, APPROVER, "OWNER");
    expect(settleInnerRefund).not.toHaveBeenCalled();
    expect(runCancel).toHaveBeenCalledTimes(1);
  });

  it("an ALREADY-TERMINAL payment (refunded since parking) skips the refund", async () => {
    const { deps, settleInnerRefund, runCancel } = makeDeps({
      findActivePayment: async () => ({ id: PAYMENT_ID, status: "refunded" }),
    });
    await createApprovedOrderCancelExecutor(deps)(STAMPED_PAYLOAD, APPROVER, "OWNER");
    expect(settleInnerRefund).not.toHaveBeenCalled();
    expect(runCancel).toHaveBeenCalledTimes(1);
  });

  it("falls back to a pt-BR default reason when the parked payload carried none", async () => {
    const { deps, runCancel } = makeDeps();
    await createApprovedOrderCancelExecutor(deps)(
      { orderId: ORDER_ID, actorId: CUSTOMER },
      APPROVER,
      "OWNER",
    );
    expect(runCancel.mock.calls[0]![0]).toMatchObject({
      reason: APPROVED_CANCEL_DEFAULT_REASON,
    });
  });

  // ── FAIL-CLOSED arms: nothing may execute ────────────────────────────────────

  it("THROWS and cancels NOTHING when the proposer stamp (actorId) is missing", async () => {
    const { deps, settleInnerRefund, runCancel } = makeDeps();
    await expect(
      createApprovedOrderCancelExecutor(deps)({ orderId: ORDER_ID }, APPROVER, "OWNER"),
    ).rejects.toThrow(/missing orderId\/actorId/);
    expect(settleInnerRefund).not.toHaveBeenCalled();
    expect(runCancel).not.toHaveBeenCalled();
  });

  it("THROWS and cancels NOTHING when orderId is missing", async () => {
    const { deps, runCancel } = makeDeps();
    await expect(
      createApprovedOrderCancelExecutor(deps)({ actorId: CUSTOMER }, APPROVER, "OWNER"),
    ).rejects.toThrow(/missing orderId\/actorId/);
    expect(runCancel).not.toHaveBeenCalled();
  });

  it("THROWS when the order is not found for its PARKED OWNER (reassigned/vanished since parking)", async () => {
    // The read is owner-scoped, so an order that changed hands yields null — the
    // approval may not cancel someone else's order.
    const { deps, settleInnerRefund, runCancel } = makeDeps({
      getOrder: async () => null,
    });
    await expect(
      createApprovedOrderCancelExecutor(deps)(STAMPED_PAYLOAD, APPROVER, "OWNER"),
    ).rejects.toThrow(/not found for its parked owner/);
    expect(settleInnerRefund).not.toHaveBeenCalled();
    expect(runCancel).not.toHaveBeenCalled();
  });

  it("THROWS BEFORE any refund when the active payment row vanished mid-flight", async () => {
    const { deps, settleInnerRefund, runCancel } = makeDeps({
      getPayment: async () => null,
    });
    await expect(
      createApprovedOrderCancelExecutor(deps)(STAMPED_PAYLOAD, APPROVER, "OWNER"),
    ).rejects.toThrow(/vanished/);
    expect(settleInnerRefund).not.toHaveBeenCalled();
    expect(runCancel).not.toHaveBeenCalled();
  });

  it("a refund failure ABORTS the cancel — no order is cancelled without its money reversed", async () => {
    const { deps, runCancel } = makeDeps({
      settleInnerRefund: async () => {
        throw new Error("refund write failed");
      },
    });
    await expect(
      createApprovedOrderCancelExecutor(deps)(STAMPED_PAYLOAD, APPROVER, "OWNER"),
    ).rejects.toThrow(/refund write failed/);
    // No-half-apply: the order stays whole when the refund did not settle.
    expect(runCancel).not.toHaveBeenCalled();
  });
});
