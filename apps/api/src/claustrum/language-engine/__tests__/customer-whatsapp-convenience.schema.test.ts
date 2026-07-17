// customer-whatsapp-convenience.schema.test.ts — FE-T14: the pack-customer-
// onboarding + pack-whatsapp extraction schemas pass the authoring-contract
// lint and expose ONLY the model-extractable fields — never
// allergenExclusions/email/cpf/sessionId.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import {
  CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA,
  CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA,
  WHATSAPP_HANDOFF_REQUEST_EXTRACTION_SCHEMA,
} from "../customer-whatsapp-convenience.schema.js";

describe("CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("exposes ONLY {dietary_restrictions, favorite_categories} (the live-calibration wire rename), both optional — NEVER allergenExclusions", () => {
    const names = extractionFieldNames(CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["dietary_restrictions", "favorite_categories"]);
    expect(names.has("allergenExclusions")).toBe(false);
    expect(names.has("allergens")).toBe(false);
  });

  it("both fields are array-typed, optional, and explicitly opt into freeform (open-vocabulary, not enum-constrained)", () => {
    const wire = toPayloadJsonSchema(CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA);
    expect(wire).toEqual({
      type: "object",
      properties: {
        dietary_restrictions: {
          type: "array",
          items: { type: "string", freeform: true },
          description: expect.any(String),
        },
        favorite_categories: {
          type: "array",
          items: { type: "string", freeform: true },
          description: expect.any(String),
        },
      },
      additionalProperties: false,
    });
  });
});

describe("CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("exposes ZERO fields — name/email/cpf are all PII, never model-fillable", () => {
    expect(extractionFieldNames(CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA).size).toBe(0);
  });

  it("builds a closed, empty wire payload schema", () => {
    expect(toPayloadJsonSchema(CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA)).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});

describe("WHATSAPP_HANDOFF_REQUEST_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(WHATSAPP_HANDOFF_REQUEST_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("exposes ONLY {reason}, optional — no sessionId", () => {
    const names = extractionFieldNames(WHATSAPP_HANDOFF_REQUEST_EXTRACTION_SCHEMA);
    expect([...names]).toEqual(["reason"]);
    expect(names.has("sessionId")).toBe(false);
  });
});
