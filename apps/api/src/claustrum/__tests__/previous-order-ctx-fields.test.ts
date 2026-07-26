// LE2-023 — the two DERIVED previous-order ctx fields.
//
// These two booleans are the grounding for a customer-facing sentence that says
// "cancelling this returns your money" and for the pre-check that decides whether
// to offer a saga that CANCELS A REAL ORDER. Both must agree with the guards that
// will adjudicate that cancel a moment later, which is why the derivation reads
// pack-orders' OWN exported sets rather than a copy.
//
// The tests below are therefore written AGAINST THE PACK'S SETS, not against
// hardcoded status strings: a test that spelled "preparing" itself would pass
// even after the pack stopped treating it as past the point of no return, which
// is precisely the drift the shared-set design exists to prevent.

import { describe, expect, it } from "vitest";
import {
  CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES,
  CUSTOMER_POST_PONR_FULFILLMENT,
} from "@ibatexas/pack-orders";
import { previousOrderCtxFields } from "../resolve-and-assemble.js";
import type { PreviousOrder } from "../previous-order.js";

function order(overrides: Partial<PreviousOrder> = {}): PreviousOrder {
  return {
    orderId: "order_abc",
    displayId: 1042,
    totalInCentavos: 12_500,
    items: [{ title: "Costela bovina defumada", quantity: 2 }],
    paymentStatus: "pending",
    fulfillmentStatus: "confirmed",
    ...overrides,
  };
}

describe("previousOrderCtxFields — cancelability agrees with the pack's PONR set", () => {
  it("EVERY status the pack calls past-PONR is NOT cancelable", () => {
    // Driven off the pack's set, so adding a status there without changing
    // anything here keeps this honest rather than silently stale.
    for (const status of CUSTOMER_POST_PONR_FULFILLMENT) {
      const ctx = previousOrderCtxFields(order({ fulfillmentStatus: status }));
      expect(ctx.previousOrderIsCancelable, status).toBe(false);
    }
    // Vacuity control: an empty set would satisfy the loop above.
    expect(CUSTOMER_POST_PONR_FULFILLMENT.size).toBeGreaterThan(0);
  });

  it("a status the pack does NOT call past-PONR is cancelable — the directional control", () => {
    // Without this, the assertion above would pass for a derivation that always
    // returned false, and the workflow would simply never be offered.
    expect(CUSTOMER_POST_PONR_FULFILLMENT.has("confirmed")).toBe(false);
    expect(previousOrderCtxFields(order()).previousOrderIsCancelable).toBe(true);
  });

  it("an UNREADABLE status is NOT cancelable — the workflow is not offered", () => {
    // Deliberately STRICTER than `canCancelOrder`, which is lenient when the
    // host projected no status (it must not refuse a legitimate direct cancel
    // over a missing field). The asymmetry is correct in both directions: a
    // guard must not refuse over an absence, and a workflow must not OFFER to
    // cancel something it could not read.
    expect(
      previousOrderCtxFields(order({ fulfillmentStatus: "" })).previousOrderIsCancelable,
    ).toBe(false);
  });
});

describe("previousOrderCtxFields — the refund consequence agrees with the pack's money set", () => {
  it("EVERY status the pack calls refund-implying is settled", () => {
    for (const status of CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES) {
      const ctx = previousOrderCtxFields(order({ paymentStatus: status }));
      expect(ctx.previousOrderPaymentIsSettled, status).toBe(true);
    }
    expect(CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES.size).toBeGreaterThan(0);
  });

  it("an unpaid order is NOT settled, so no refund is ever promised", () => {
    // The directional control, and the one that protects the customer-facing
    // sentence: promising money back on an order that never took any is the
    // false-success class pointed at the wallet.
    expect(CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES.has("awaiting_payment")).toBe(false);
    expect(
      previousOrderCtxFields(order({ paymentStatus: "awaiting_payment" }))
        .previousOrderPaymentIsSettled,
    ).toBe(false);
  });

  it("an ABSENT payment status is NOT settled", () => {
    expect(
      previousOrderCtxFields(order({ paymentStatus: null })).previousOrderPaymentIsSettled,
    ).toBe(false);
  });
});

describe("previousOrderCtxFields — no order, no fields", () => {
  it("stamps NOTHING for a customer with no readable previous order", () => {
    // Absence stays absence: every fact over these fields then reads ABSENT, the
    // pre-check refuses, and nothing destructive is offered.
    expect(previousOrderCtxFields(null)).toEqual({});
  });
});
