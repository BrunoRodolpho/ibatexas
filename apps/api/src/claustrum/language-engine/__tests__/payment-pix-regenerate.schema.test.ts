// payment-pix-regenerate.schema.test.ts — the FE-T11 money-tier extraction
// schema: passes the authoring-contract lint, exposes ZERO model-fillable
// fields (deliberate — see the schema module's header), and builds a wire
// payload schema that structurally forces `payload: {}`.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import { PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA } from "../payment-pix-regenerate.schema.js";

describe("PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("declares ZERO model-fillable fields — orderId is the entire wire payload and is Identity-class/resolver-only", () => {
    const names = extractionFieldNames(PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA);
    expect([...names]).toEqual([]);
    expect(names.has("orderId")).toBe(false);
  });

  it("builds a wire payload schema that structurally forces payload:{} (closed, no properties)", () => {
    const wire = toPayloadJsonSchema(PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA);
    expect(wire).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("carries no 'required' key (vacuously true — there is nothing to require)", () => {
    const wire = toPayloadJsonSchema(PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA);
    expect(wire).not.toHaveProperty("required");
  });

  it("the worked example's payload is empty, matching the closed wire schema", () => {
    expect(PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA.example.payload).toEqual({});
  });
});
