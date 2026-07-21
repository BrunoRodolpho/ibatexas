// order-cancel.schema.test.ts — FE-T12 (orders governance-tier rollout):
// the `order.cancel` extraction schema passes the authoring-contract lint
// and exposes ONLY the optional `reason` — never orderId.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import { ORDER_CANCEL_EXTRACTION_SCHEMA } from "../order-cancel.schema.js";

describe("ORDER_CANCEL_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(ORDER_CANCEL_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY reason — never orderId", () => {
    const names = extractionFieldNames(ORDER_CANCEL_EXTRACTION_SCHEMA);
    expect([...names]).toEqual(["reason"]);
    expect(names.has("orderId")).toBe(false);
  });

  it("declares reason OPTIONAL (a bare 'cancela meu pedido' still cancels, no reason given)", () => {
    const field = ORDER_CANCEL_EXTRACTION_SCHEMA.fields.find((f) => f.name === "reason");
    expect(field?.required).toBe(false);
    expect(field?.jsonSchema.type).toBe("string");
  });

  it("every field is State/Directive class — never Identity", () => {
    for (const field of ORDER_CANCEL_EXTRACTION_SCHEMA.fields) {
      expect(field.trustClass).not.toBe("identity");
    }
  });

  it("builds a closed wire payload schema — reason optional, no required array, no other properties", () => {
    const wire = toPayloadJsonSchema(ORDER_CANCEL_EXTRACTION_SCHEMA);
    expect(wire).toEqual({
      type: "object",
      properties: {
        reason: { type: "string", description: expect.any(String) },
      },
      additionalProperties: false,
    });
    expect(wire).not.toHaveProperty("required");
  });

  it("the worked example matches the schema's fields and carries no forbidden name", () => {
    const { payload } = ORDER_CANCEL_EXTRACTION_SCHEMA.example;
    expect(payload).toEqual({ reason: "mudei de ideia" });
    expect(Object.keys(payload)).not.toContain("orderId");
  });
});
