// GM — §K guard-mirror invariant tests for the EXISTING `SUCCESS_CLAIM_CLASSES`
// seed guard (`ibatexas-responder.ts:220-238`). These tests pin the guard's shape
// to the Claim Registry v0.1 §6 Cluster F + §K rules so that a silent drift in the
// runtime guard (a 12th class, a softened `fulfillment-claimed`, or a refund-confirm
// leaking into `payment-settled`) fails CI rather than ships a confabulator.
//
// Canon (compilation authority: SDD §A precedence; feature canon: claim-registry
// v0.1 §6 Cluster F + §K):
//  - The guard governs exactly 11 success classes (10 Cluster-F rows; the registry's
//    `PURCHASE_COMPLETED` folds the guard's `order-placed` + `purchase-completed`).
//  - `fulfillment-claimed.justifiedBy` is the EMPTY array by design — no action ever
//    earns a delivery/pickup claim; permanently unearnable; never droppable.
//  - `payment-settled.justifiedBy` EXCLUDES `payment.refund.confirm` (opposite money
//    direction) and INCLUDES the inbound-settlement confirm
//    (`payment.cash.confirm`; `payment.charge.confirm` was retired in BKL-176).
//    The refund confirm backs `refund-done` only.
//
// NON-VACUITY: each of the three invariants below was verified RED under a mutation
// of the source array (push a 12th class; set `fulfillment-claimed.justifiedBy` to a
// non-empty array; add `payment.refund.confirm` to `payment-settled`), then the
// source was restored. See `sdd_selfcheck` in `.orch/GM.impl.json`.

import { describe, expect, it } from "vitest";
import { SUCCESS_CLAIM_CLASSES, type SuccessClaimClass } from "../ibatexas-responder.js";

/** Resolve a single class by id; fail loudly if the guard no longer declares it. */
function classById(id: string): SuccessClaimClass {
  const found = SUCCESS_CLAIM_CLASSES.find((c) => c.id === id);
  expect(found, `guard must declare a "${id}" class`).toBeDefined();
  return found as SuccessClaimClass;
}

describe("SUCCESS_CLAIM_CLASSES guard mirror (registry v0.1 §6 Cluster F + §K)", () => {
  it("declares exactly 11 success classes — derived by enumeration, not a blind literal", () => {
    // Enumerate from the array itself; assert the ENUMERATED value against the canon.
    const enumeratedCount = SUCCESS_CLAIM_CLASSES.length;
    // ids are unique (the count is a count of distinct guard classes, not duplicates).
    const distinctIds = new Set(SUCCESS_CLAIM_CLASSES.map((c) => c.id));
    expect(distinctIds.size, "every guard class id must be distinct").toBe(enumeratedCount);

    // §K: the guard mirror must equal the code's 11 classes. If the enumeration ever
    // yields a number other than 11 this asserts the enumerated reality (the test is
    // a faithful mirror), surfacing the drift instead of force-passing against 11.
    expect(enumeratedCount, "guard must govern the 11 §K success classes").toBe(11);
  });

  it("fulfillment-claimed.justifiedBy deep-equals [] — permanently unearnable (the strongest anti-confabulation guard)", () => {
    const fulfillment = classById("fulfillment-claimed");
    // Deep-equality to the empty array: no executed envelope kind may ever justify a
    // delivery/pickup claim. Dropping this (any non-empty array) makes "a caminho" /
    // "saiu pra entrega" earnable — exactly the failure §K forbids.
    expect(fulfillment.justifiedBy).toEqual([]);
  });

  it("payment-settled excludes payment.refund.confirm and includes the inbound-settlement confirms", () => {
    const paymentSettled = classById("payment-settled");
    // Refund is the OPPOSITE money direction — it must NOT justify "pagamento aprovado".
    expect(paymentSettled.justifiedBy).not.toContain("payment.refund.confirm");
    // The class IS earned by an inbound cash settlement (BKL-176 retired the
    // payment.charge.confirm justifier; payment.cash.confirm remains).
    expect(paymentSettled.justifiedBy).not.toContain("payment.charge.confirm");
    expect(paymentSettled.justifiedBy).toContain("payment.cash.confirm");

    // Sanity: the refund confirm maps to `refund-done`, not to `payment-settled`.
    const refundDone = classById("refund-done");
    expect(refundDone.justifiedBy).toContain("payment.refund.confirm");
    expect(refundDone.justifiedBy).toContain("payment.refund.issue");
  });
});
