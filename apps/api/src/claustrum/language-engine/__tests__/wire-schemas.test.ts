// wire-schemas.test.ts — the per-capability extraction schema -> wire
// registry. FE-T09 (D-a) adds the three granular post-checkout amend kinds
// alongside FE-T05's order.status.transition; FE-T10 adds the money-tier
// slice (payment.refund.issue).

import { describe, expect, it } from "vitest";
import { EXTRACTION_SCHEMAS_BY_CAPABILITY } from "../wire-schemas.js";

describe("EXTRACTION_SCHEMAS_BY_CAPABILITY", () => {
  it("registers order.status.transition (FE-T05), the three granular amend kinds (FE-T09), and payment.refund.issue (FE-T10)", () => {
    expect([...EXTRACTION_SCHEMAS_BY_CAPABILITY.keys()].sort()).toEqual(
      [
        "order.amend.add_item",
        "order.amend.remove_item",
        "order.amend.update_qty",
        "order.status.transition",
        "payment.refund.issue",
      ].sort(),
    );
  });

  it("does NOT register the grouped order.amend.request — it keeps the generic {type:'object'} shape, byte-identical", () => {
    expect(EXTRACTION_SCHEMAS_BY_CAPABILITY.has("order.amend.request")).toBe(false);
  });

  it("each granular amend schema's wire payload is a closed object (additionalProperties: false)", () => {
    for (const kind of [
      "order.amend.add_item",
      "order.amend.update_qty",
      "order.amend.remove_item",
    ]) {
      const wire = EXTRACTION_SCHEMAS_BY_CAPABILITY.get(kind);
      expect(wire).toBeDefined();
      expect((wire as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      expect(wire).not.toHaveProperty("properties.orderId");
      expect(wire).not.toHaveProperty("properties.variantId");
      expect(wire).not.toHaveProperty("properties.itemId");
      expect(wire).not.toHaveProperty("properties.allergens");
    }
  });
});
