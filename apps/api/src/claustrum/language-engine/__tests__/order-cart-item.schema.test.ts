// order-cart-item.schema.test.ts — FE-T14: the pack-orders cart/item family
// extraction schemas pass the authoring-contract lint and expose ONLY the
// model-extractable fields — never cartId/variantId/itemId/allergens.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import {
  ORDER_CART_ENSURE_EXTRACTION_SCHEMA,
  ORDER_ITEM_ADD_EXTRACTION_SCHEMA,
  ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA,
  ORDER_ITEM_REMOVE_EXTRACTION_SCHEMA,
  ORDER_COUPON_APPLY_EXTRACTION_SCHEMA,
} from "../order-cart-item.schema.js";

describe("ORDER_CART_ENSURE_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(ORDER_CART_ENSURE_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ZERO fields — cartId is 100% resolver-filled", () => {
    expect(extractionFieldNames(ORDER_CART_ENSURE_EXTRACTION_SCHEMA).size).toBe(0);
  });

  it("builds a closed, empty wire payload schema", () => {
    expect(toPayloadJsonSchema(ORDER_CART_ENSURE_EXTRACTION_SCHEMA)).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});

describe("ORDER_ITEM_ADD_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(ORDER_ITEM_ADD_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {item, quantity} — no cartId, variantId, or allergens", () => {
    const names = extractionFieldNames(ORDER_ITEM_ADD_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["item", "quantity"]);
    expect(names.has("cartId")).toBe(false);
    expect(names.has("variantId")).toBe(false);
    expect(names.has("allergens")).toBe(false);
  });

  it("builds a closed wire payload schema — item required, quantity optional", () => {
    const wire = toPayloadJsonSchema(ORDER_ITEM_ADD_EXTRACTION_SCHEMA);
    expect(wire).toEqual({
      type: "object",
      properties: {
        item: { type: "string", description: expect.any(String) },
        quantity: { type: "number", description: expect.any(String) },
      },
      required: ["item"],
      additionalProperties: false,
    });
  });
});

describe("ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {item, quantity}, BOTH required — no cartId or itemId", () => {
    const names = extractionFieldNames(ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["item", "quantity"]);
    expect(names.has("itemId")).toBe(false);
    expect(names.has("cartId")).toBe(false);
    const wire = toPayloadJsonSchema(ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA);
    expect(wire.required).toEqual(["item", "quantity"]);
  });
});

describe("ORDER_ITEM_REMOVE_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(ORDER_ITEM_REMOVE_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {item} — no quantity, cartId, or itemId", () => {
    const names = extractionFieldNames(ORDER_ITEM_REMOVE_EXTRACTION_SCHEMA);
    expect([...names]).toEqual(["item"]);
    expect(names.has("itemId")).toBe(false);
    expect(names.has("cartId")).toBe(false);
  });
});

describe("ORDER_COUPON_APPLY_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(ORDER_COUPON_APPLY_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {code}, required — no cartId", () => {
    const names = extractionFieldNames(ORDER_COUPON_APPLY_EXTRACTION_SCHEMA);
    expect([...names]).toEqual(["code"]);
    expect(names.has("cartId")).toBe(false);
    const wire = toPayloadJsonSchema(ORDER_COUPON_APPLY_EXTRACTION_SCHEMA);
    expect(wire.required).toEqual(["code"]);
  });

  it("the worked example matches the schema's fields", () => {
    expect(ORDER_COUPON_APPLY_EXTRACTION_SCHEMA.example.payload).toEqual({ code: "PROMO10" });
  });
});
