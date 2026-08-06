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
  FiscalStatus,
  FISCAL_STATUS_LABELS_PT,
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

/**
 * `false` once `T` has widened to `string`, `true` while the literal survives.
 * Names no pt-BR text, so it detects WIDENING without pinning any copy.
 */
type IsLiteral<T extends string> = string extends T ? false : true;

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

  // F-70 — the registers must keep LITERAL value types.
  //
  // These maps are declared `as const satisfies Record<Status, string>`. The
  // `satisfies` carries the exhaustiveness the old `: Record<Status, string>`
  // annotation gave; the `as const` is what keeps each value's LITERAL type.
  // That is not cosmetic: `packages/ui`'s admin filter chips derive their label
  // from these maps and type each chip as the exact (id, label) pair, which is
  // the only thing making a hand-written or MIS-PAIRED chip a compile error.
  //
  // Re-annotating these maps `: Record<Status, string>` would widen every value
  // back to `string` — and the UI would still COMPILE, silently losing that
  // guard. Nothing else would fail. Hence this pin, at the source of the
  // constraint. It is a TYPE assertion: `tsc --noEmit` (this package's `lint`,
  // whose tsconfig includes `src`, and therefore this file) is what enforces it
  // — vitest transpiles without typechecking, so the runtime `expect` below is
  // a companion, not the guard.
  // COPY-AGNOSTIC BY CONSTRUCTION, deliberately. `IsLiteral` names no pt-BR
  // string, so re-wording any label leaves this pin untouched — only WIDENING
  // trips it. The property under test is "the literal type survived", not "the
  // value is currently 'Pendente'"; pinning the latter would red CI on a
  // legitimate copy edit, which is a landmine rather than a guard.
  it("F-70: every register keeps LITERAL value types (widening is the only failure)", () => {
    const orderStaff: IsLiteral<
      (typeof ORDER_STATUS_LABELS_PT)[OrderFulfillmentStatus]
    > = true;
    const paymentStaff: IsLiteral<
      (typeof PAYMENT_STATUS_LABELS_PT)[PaymentStatus]
    > = true;
    const reservationStaff: IsLiteral<
      (typeof RESERVATION_STATUS_LABELS_PT)[ReservationStatus]
    > = true;
    const fiscalStaff: IsLiteral<
      (typeof FISCAL_STATUS_LABELS_PT)[FiscalStatus]
    > = true;
    const orderCustomer: IsLiteral<
      (typeof ORDER_STATUS_LABELS_PT_CUSTOMER)[OrderFulfillmentStatus]
    > = true;
    const paymentCustomer: IsLiteral<
      (typeof PAYMENT_STATUS_LABELS_PT_CUSTOMER)[PaymentStatus]
    > = true;
    const reservationCustomer: IsLiteral<
      (typeof RESERVATION_STATUS_LABELS_PT_CUSTOMER)[ReservationStatus]
    > = true;

    expect([
      orderStaff,
      paymentStaff,
      reservationStaff,
      fiscalStaff,
      orderCustomer,
      paymentCustomer,
      reservationCustomer,
    ]).toEqual([true, true, true, true, true, true, true]);
  });
});
