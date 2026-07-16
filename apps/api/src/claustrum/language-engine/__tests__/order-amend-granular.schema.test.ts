// order-amend-granular.schema.test.ts — FE-T09 (D-a, the amend inversion):
// the three granular post-checkout amend extraction schemas pass the
// authoring-contract lint and expose ONLY the model-extractable fields —
// never orderId/variantId/itemId/allergens.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import {
  ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA,
  ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA,
  ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA,
} from "../order-amend-granular.schema.js";

describe("ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("exposes ONLY {item, quantity} — no orderId, variantId, or allergens", () => {
    const names = extractionFieldNames(ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["item", "quantity"]);
    expect(names.has("orderId")).toBe(false);
    expect(names.has("variantId")).toBe(false);
    expect(names.has("allergens")).toBe(false);
  });

  it("builds a closed wire payload schema — item required, quantity optional", () => {
    const wire = toPayloadJsonSchema(ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA);
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

  it("the worked example matches the ticket's target utterance and never leaks allergens", () => {
    expect(ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA.example.payload).toEqual({
      item: "coca",
      quantity: 1,
    });
    expect(
      Object.keys(ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA.example.payload),
    ).not.toContain("allergens");
  });
});

describe("ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("exposes ONLY {item, quantity}, both required — no orderId, no itemId", () => {
    const names = extractionFieldNames(ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["item", "quantity"]);
    expect(names.has("itemId")).toBe(false);
    expect(names.has("orderId")).toBe(false);
    const wire = toPayloadJsonSchema(ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA);
    expect(wire.required).toEqual(["item", "quantity"]);
  });
});

describe("ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("exposes ONLY {item} — no quantity field, no orderId, no itemId", () => {
    const names = extractionFieldNames(ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA);
    expect([...names]).toEqual(["item"]);
    expect(names.has("itemId")).toBe(false);
    expect(names.has("orderId")).toBe(false);
  });
});
