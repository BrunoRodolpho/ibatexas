// BKL-016 — the TEETH for the two-register single-source of pt-BR status labels.
//
// Divergence-by-drift is the defect this closes. These pins make it structurally
// impossible: for every status enum family, BOTH voices (STAFF Title-Case + CUSTOMER
// sentence-voice) must cover the IDENTICAL, COMPLETE enum key-set — so a future edit
// that adds a status to one voice but not the other fails CI. The admin-extension
// maps must stay DISJOINT from the core enum values — so an extra key can never
// silently shadow a core status through the admin spread.

import { describe, expect, it } from "vitest";
import {
  ADMIN_ORDER_STATUS_EXTRA,
  ADMIN_PAYMENT_STATUS_EXTRA,
  OrderFulfillmentStatus,
  ORDER_STATUS_LABELS_PT,
  ORDER_STATUS_LABELS_PT_CUSTOMER,
  PaymentStatus,
  PAYMENT_STATUS_LABELS_PT,
  PAYMENT_STATUS_LABELS_PT_CUSTOMER,
  ReservationStatus,
  RESERVATION_STATUS_LABELS_PT,
  RESERVATION_STATUS_LABELS_PT_CUSTOMER,
} from "../index.js";

const sortedKeys = (m: Record<string, string>): string[] => Object.keys(m).sort();
const allNonEmpty = (m: Record<string, string>): boolean =>
  Object.values(m).every((v) => typeof v === "string" && v.trim() !== "");

const orderValues = Object.values(OrderFulfillmentStatus).sort();
const paymentValues = Object.values(PaymentStatus).sort();
const reservationValues = Object.values(ReservationStatus).sort();

describe("BKL-016 status-labels — two-register single-source exhaustiveness", () => {
  describe.each([
    ["order", orderValues, ORDER_STATUS_LABELS_PT, ORDER_STATUS_LABELS_PT_CUSTOMER],
    ["payment", paymentValues, PAYMENT_STATUS_LABELS_PT, PAYMENT_STATUS_LABELS_PT_CUSTOMER],
    [
      "reservation",
      reservationValues,
      RESERVATION_STATUS_LABELS_PT,
      RESERVATION_STATUS_LABELS_PT_CUSTOMER,
    ],
  ] as ReadonlyArray<[string, string[], Record<string, string>, Record<string, string>]>)(
    "%s family",
    (_name, values, staff, customer) => {
      it("STAFF register covers EXACTLY the complete enum key-set (non-empty)", () => {
        expect(sortedKeys(staff)).toEqual([...values]);
        expect(allNonEmpty(staff)).toBe(true);
      });

      it("CUSTOMER register covers EXACTLY the complete enum key-set (non-empty)", () => {
        expect(sortedKeys(customer)).toEqual([...values]);
        expect(allNonEmpty(customer)).toBe(true);
      });

      it("STAFF and CUSTOMER cover the IDENTICAL key-set (no divergence-by-drift)", () => {
        expect(sortedKeys(staff)).toEqual(sortedKeys(customer));
      });
    },
  );

  it("ADMIN order-extension keys are DISJOINT from the core order enum values", () => {
    for (const key of Object.keys(ADMIN_ORDER_STATUS_EXTRA)) {
      expect(orderValues).not.toContain(key);
    }
    expect(allNonEmpty(ADMIN_ORDER_STATUS_EXTRA)).toBe(true);
  });

  it("ADMIN payment-extension keys are DISJOINT from the core payment enum values", () => {
    for (const key of Object.keys(ADMIN_PAYMENT_STATUS_EXTRA)) {
      expect(paymentValues).not.toContain(key);
    }
    expect(allNonEmpty(ADMIN_PAYMENT_STATUS_EXTRA)).toBe(true);
  });
});
