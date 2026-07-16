// payment-refund-issue.schema.test.ts — the FE-T10 money-tier extraction
// schema: passes the authoring-contract lint, exposes ONLY
// {orderReference, amount, reason} (never paymentId / the balance snapshot /
// any forbidden identifier), and builds the expected wire payload shape.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import { PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA } from "../payment-refund-issue.schema.js";

describe("PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("exposes ONLY orderReference/amount/reason — never orderId or paymentId", () => {
    const names = extractionFieldNames(PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["amount", "orderReference", "reason"]);
    expect(names.has("orderId")).toBe(false);
    expect(names.has("paymentId")).toBe(false);
    expect(names.has("refundAmountCentavos")).toBe(false);
  });

  it("declares amount + reason OPTIONAL (a bare 'reembolsa o pedido X' is a full-balance refund) and orderReference REQUIRED", () => {
    const byName = new Map(
      PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA.fields.map((f) => [f.name, f]),
    );
    expect(byName.get("orderReference")?.required).toBe(true);
    expect(byName.get("amount")?.required).toBe(false);
    expect(byName.get("reason")?.required).toBe(false);
  });

  it("amount is a NUMBER field (reais, not centavos) — the BKL-094 unit-semantics decision", () => {
    const amountField = PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA.fields.find(
      (f) => f.name === "amount",
    );
    expect(amountField?.jsonSchema.type).toBe("number");
  });

  it("every field is State/Directive class — never Identity", () => {
    for (const field of PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA.fields) {
      expect(field.trustClass).not.toBe("identity");
    }
  });

  it("builds a wire payload schema: closed, orderReference required, amount/reason optional", () => {
    const wire = toPayloadJsonSchema(PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA);
    expect(wire).toEqual({
      type: "object",
      properties: {
        orderReference: { type: "string", description: expect.any(String) },
        amount: { type: "number", description: expect.any(String) },
        reason: { type: "string", description: expect.any(String) },
      },
      required: ["orderReference"],
      additionalProperties: false,
    });
  });

  it("the worked example matches the schema's fields and carries no forbidden name", () => {
    const { payload } = PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA.example;
    expect(payload).toEqual({
      orderReference: "12345",
      amount: 20,
      reason: "o cliente desistiu",
    });
    expect(Object.keys(payload)).not.toContain("orderId");
    expect(Object.keys(payload)).not.toContain("paymentId");
  });
});
