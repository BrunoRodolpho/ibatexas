// order-note-review.schema.test.ts — FE-T14: the pack-orders free-text
// family extraction schemas pass the authoring-contract lint and expose
// ONLY the model-extractable fields — never orderId/productId/isInternal.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import {
  ORDER_NOTE_ADD_EXTRACTION_SCHEMA,
  ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA,
} from "../order-note-review.schema.js";

describe("ORDER_NOTE_ADD_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(ORDER_NOTE_ADD_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {body}, required — no orderId or isInternal", () => {
    const names = extractionFieldNames(ORDER_NOTE_ADD_EXTRACTION_SCHEMA);
    expect([...names]).toEqual(["body"]);
    expect(names.has("orderId")).toBe(false);
    expect(names.has("isInternal")).toBe(false);
  });

  it("builds a closed wire payload schema", () => {
    const wire = toPayloadJsonSchema(ORDER_NOTE_ADD_EXTRACTION_SCHEMA);
    expect(wire).toEqual({
      type: "object",
      properties: {
        body: { type: "string", description: expect.any(String) },
      },
      required: ["body"],
      additionalProperties: false,
    });
  });

  it("the worked example preserves the note text verbatim", () => {
    expect(ORDER_NOTE_ADD_EXTRACTION_SCHEMA.example.payload).toEqual({
      body: "sem cebola, por favor",
    });
  });
});

describe("ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {rating, comment} — no orderId or productId", () => {
    const names = extractionFieldNames(ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["comment", "rating"]);
    expect(names.has("orderId")).toBe(false);
    expect(names.has("productId")).toBe(false);
  });

  it("declares rating required and comment optional", () => {
    const byName = new Map(ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA.fields.map((f) => [f.name, f]));
    expect(byName.get("rating")?.required).toBe(true);
    expect(byName.get("comment")?.required).toBe(false);
    expect(byName.get("rating")?.jsonSchema.type).toBe("number");
  });

  it("builds a closed wire payload schema", () => {
    const wire = toPayloadJsonSchema(ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA);
    expect(wire).toEqual({
      type: "object",
      properties: {
        rating: { type: "number", description: expect.any(String) },
        comment: { type: "string", description: expect.any(String) },
      },
      required: ["rating"],
      additionalProperties: false,
    });
  });
});
