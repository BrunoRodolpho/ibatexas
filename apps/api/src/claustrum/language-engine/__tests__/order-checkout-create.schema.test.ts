// order-checkout-create.schema.test.ts — FE-T12 (orders governance-tier
// rollout): the `order.checkout.create` extraction schema passes the
// authoring-contract lint and exposes ONLY `payment_method` — never cartId
// or pixDetails/email/cpf.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import {
  ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA,
  ORDER_CHECKOUT_CREATE_PAYMENT_METHODS,
} from "../order-checkout-create.schema.js";

describe("ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("exposes ONLY payment_method (snake_case, team-lead ruling per live-calibration bias) — never cartId, pixDetails, email, or cpf", () => {
    const names = extractionFieldNames(ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA);
    expect([...names]).toEqual(["payment_method"]);
    expect(names.has("paymentMethod")).toBe(false);
    expect(names.has("cartId")).toBe(false);
    expect(names.has("pixDetails")).toBe(false);
    expect(names.has("email")).toBe(false);
    expect(names.has("cpf")).toBe(false);
  });

  it("declares payment_method OPTIONAL (team-lead review: a required closed enum invites fabrication on a method-absent utterance) with the closed pix/card/cash enum", () => {
    const field = ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA.fields.find(
      (f) => f.name === "payment_method",
    );
    expect(field?.required).toBe(false);
    expect(field?.jsonSchema.enum).toEqual(["pix", "card", "cash"]);
    expect(ORDER_CHECKOUT_CREATE_PAYMENT_METHODS).toEqual(["pix", "card", "cash"]);
  });

  it("every field is State/Directive class — never Identity", () => {
    for (const field of ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA.fields) {
      expect(field.trustClass).not.toBe("identity");
    }
  });

  it("builds a closed wire payload schema — payment_method optional (no required array), no other properties", () => {
    const wire = toPayloadJsonSchema(ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA);
    expect(wire).toEqual({
      type: "object",
      properties: {
        payment_method: {
          type: "string",
          enum: ["pix", "card", "cash"],
          description: expect.any(String),
        },
      },
      additionalProperties: false,
    });
    expect(wire).not.toHaveProperty("required");
  });

  it("the worked example matches the schema's fields and carries no forbidden name", () => {
    const { payload } = ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA.example;
    expect(payload).toEqual({ payment_method: "pix" });
    expect(Object.keys(payload)).not.toContain("cartId");
    expect(Object.keys(payload)).not.toContain("pixDetails");
  });
});
