// wire-schemas.test.ts — the per-capability extraction schema -> wire
// registry. FE-T09 (D-a) adds the three granular post-checkout amend kinds
// alongside FE-T05's order.status.transition; FE-T10 adds the money-tier
// slice (payment.refund.issue); FE-T11 adds the customer-plane money-tier
// slice (payment.pix.regenerate); FE-T14 adds the pack-orders cart/item
// family (order.cart.ensure/item.add/item.update/item.remove/coupon.apply)
// plus the note/review, reservation, and customer/whatsapp families.

import { describe, expect, it } from "vitest";
import {
  EXTRACTION_SCHEMAS_BY_CAPABILITY,
  ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY,
} from "../wire-schemas.js";

describe("EXTRACTION_SCHEMAS_BY_CAPABILITY", () => {
  it("registers order.status.transition (FE-T05), the three granular amend kinds (FE-T09), payment.refund.issue (FE-T10), payment.pix.regenerate (FE-T11), and the FE-T14 convenience mutating verb families", () => {
    expect([...EXTRACTION_SCHEMAS_BY_CAPABILITY.keys()].sort()).toEqual(
      [
        "order.amend.add_item",
        "order.amend.remove_item",
        "order.amend.update_qty",
        "order.status.transition",
        "payment.refund.issue",
        "payment.pix.regenerate",
        "order.cart.ensure",
        "order.item.add",
        "order.item.update",
        "order.item.remove",
        "order.coupon.apply",
        "order.note.add",
        "order.review.submit",
        "reservation.create",
        "reservation.modify",
        "reservation.cancel",
        "reservation.waitlist.join",
        "customer.preferences.update",
        "customer.pix.details.save",
        "whatsapp.handoff.request",
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

// FE-T11 (review) — the plan-time filter's allowlist source of truth
// (ibatexas-planner.ts's stripUnauthoredPayloadFields reads this map).
describe("ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY", () => {
  it("is schema-field-names UNION declared legacyPayloadChannels — payment.pix.regenerate stays fully closed (no channel declared)", () => {
    expect(ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY.get("payment.pix.regenerate")).toEqual(
      new Set(),
    );
  });

  it("order.status.transition allows newStatus (schema field) UNION orderId (declared legacy channel, BKL-089)", () => {
    expect(ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY.get("order.status.transition")).toEqual(
      new Set(["newStatus", "orderId"]),
    );
  });

  it("payment.refund.issue allows orderReference/amount/reason (schema fields) UNION orderId/refundAmountCentavos/value/valor (declared legacy channels, BKL-094)", () => {
    expect(ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY.get("payment.refund.issue")).toEqual(
      new Set(["orderReference", "amount", "reason", "orderId", "refundAmountCentavos", "value", "valor"]),
    );
  });

  it("the granular amend kinds declare no legacy channel — allowed set is exactly their schema fields", () => {
    expect(ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY.get("order.amend.add_item")).toEqual(
      new Set(["item", "quantity"]),
    );
  });

  it("has no entry for an unauthored capability (the planner filter treats absence as pass-through)", () => {
    expect(ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY.has("order.checkout.create")).toBe(false);
  });
});
