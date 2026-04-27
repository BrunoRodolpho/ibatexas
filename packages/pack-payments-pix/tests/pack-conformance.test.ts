/**
 * Pack v0 conformance — pins the Pack to the published `PackV0`
 * contract from `@adjudicate/core`. If `PackV0` evolves, this file is
 * the first thing that breaks; that's the point.
 *
 * The roadmap requires "type-level conformance test
 * (`expectType<PackV0>(paymentsPixPack)`)" for every Pack. We use the
 * runtime no-op `expectPackV0` helper as the proof, since the
 * compile-time check is what matters.
 */

import { describe, expect, it } from "vitest";
import {
  expectPackV0,
  isPackMetadata,
  type PackV0,
} from "@adjudicate/core";
import { pixPaymentsPack } from "../src/index.js";

describe("PackV0 conformance — @adjudicate/pack-payments-pix", () => {
  it("compile-time conforms to PackV0", () => {
    // Compile-time check: if the assignment fails, `tsc --noEmit`
    // fails and CI blocks the merge.
    const _check: PackV0 = pixPaymentsPack;
    void _check;
    expectPackV0(pixPaymentsPack);
    expect(true).toBe(true);
  });

  it("declares its identity in metadata", () => {
    expect(isPackMetadata(pixPaymentsPack.metadata)).toBe(true);
    expect(pixPaymentsPack.metadata.name).toBe(
      "@adjudicate/pack-payments-pix",
    );
    expect(pixPaymentsPack.metadata.version).toBe("0.1.0-experimental");
  });

  it("declares all three intent kinds", () => {
    expect([...pixPaymentsPack.metadata.intentKinds].sort()).toEqual(
      ["pix.charge.create", "pix.charge.confirm", "pix.charge.refund"].sort(),
    );
  });

  it("ships a fail-safe REFUSE-default policy", () => {
    expect(pixPaymentsPack.policyBundle.default).toBe("REFUSE");
  });

  it("classifies confirm/refund as MUTATING (no READ_ONLY shipped)", () => {
    expect(pixPaymentsPack.toolClassification.READ_ONLY.size).toBe(0);
    expect(pixPaymentsPack.toolClassification.MUTATING.has("pix_charge_create")).toBe(
      true,
    );
    expect(
      pixPaymentsPack.toolClassification.MUTATING.has("pix_charge_confirm"),
    ).toBe(true);
    expect(pixPaymentsPack.toolClassification.MUTATING.has("pix_charge_refund")).toBe(
      true,
    );
  });

  it("planner produces a Plan with no MUTATING tools leaking into visibleReadTools", () => {
    const plan = pixPaymentsPack.capabilityPlanner.plan(
      { charge: null },
      undefined,
    );
    expect(plan.visibleReadTools).toEqual([]);
    expect(plan.allowedIntents).toContain("pix.charge.create");
  });
});
