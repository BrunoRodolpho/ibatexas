// extraction-schema.test.ts — the extraction-schema authoring-contract
// lint (FE-1.1): an authored schema must never expose an Identity-class or
// forbidden (identifier/PII/safety-critical) field to the model.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
  UnsoundExtractionSchemaError,
  type CapabilityExtractionSchema,
} from "../extraction-schema.js";
import {
  ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA,
  ORDER_STATUS_TRANSITION_STATUSES,
} from "../order-status-transition.schema.js";

describe("ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() =>
      assertSoundExtractionSchema(ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA),
    ).not.toThrow();
  });

  it("exposes ONLY newStatus — no orderId, no identity field", () => {
    const names = extractionFieldNames(ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA);
    expect([...names]).toEqual(["newStatus"]);
    expect(names.has("orderId")).toBe(false);
  });

  it("builds a wire payload schema with the real 6-status enum, required, closed", () => {
    const wire = toPayloadJsonSchema(ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA);
    expect(wire).toEqual({
      type: "object",
      properties: {
        newStatus: {
          type: "string",
          enum: [...ORDER_STATUS_TRANSITION_STATUSES],
          description: expect.any(String),
        },
      },
      required: ["newStatus"],
      additionalProperties: false,
    });
  });

  it("the worked example matches the ticket's target utterance and yields {newStatus} only", () => {
    expect(ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA.example.payload).toEqual({
      newStatus: "ready",
    });
    expect(
      Object.keys(ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA.example.payload),
    ).not.toContain("orderId");
  });

  // FE-T11 (review) — BKL-089's order-reference-resolution path
  it("declares a legacyPayloadChannel for orderId (BKL-089), disjoint from its own fields, with a non-empty reason", () => {
    const channels = ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA.legacyPayloadChannels ?? [];
    expect(channels).toHaveLength(1);
    expect(channels[0]!.field).toBe("orderId");
    expect(channels[0]!.reason.trim().length).toBeGreaterThan(0);
    expect(extractionFieldNames(ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA).has("orderId")).toBe(
      false,
    );
  });
});

describe("assertSoundExtractionSchema — the lint fires on a bad schema", () => {
  it("throws when a field is declared Identity class", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "order.status.transition",
      fields: [
        {
          name: "targetOrder",
          trustClass: "identity",
          jsonSchema: { type: "string", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(
      UnsoundExtractionSchemaError,
    );
  });

  it("throws when a forbidden identifier/PII field name is exposed, regardless of declared trustClass", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "order.status.transition",
      fields: [
        {
          name: "orderId",
          // Even mislabeled as "state", the NAME itself is forbidden.
          trustClass: "state",
          jsonSchema: { type: "string", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(
      UnsoundExtractionSchemaError,
    );
  });

  it("toPayloadJsonSchema refuses to build a wire schema for an unsound schema", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "allergens",
          trustClass: "directive",
          jsonSchema: { type: "string", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => toPayloadJsonSchema(bad)).toThrow(UnsoundExtractionSchemaError);
  });

  it("a sound schema (State/Directive only, no forbidden names) passes", () => {
    const good: CapabilityExtractionSchema = {
      capability: "menu.special.set",
      fields: [
        {
          name: "promoPriceCentavos",
          trustClass: "directive",
          jsonSchema: { type: "number", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: { promoPriceCentavos: 4500 } },
    };
    expect(() => assertSoundExtractionSchema(good)).not.toThrow();
  });

  // FE-T11 (review) — legacyPayloadChannels lint: the mechanism must never
  // become a forbidden-field backdoor (see extraction-schema.ts's doc).
  it("throws when a legacyPayloadChannel's field COLLIDES with an authored extraction field of the same name", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "order.status.transition",
      fields: [
        {
          name: "newStatus",
          trustClass: "directive",
          jsonSchema: { type: "string", description: "x" },
          required: true,
        },
      ],
      example: { utterance: "x", payload: { newStatus: "ready" } },
      legacyPayloadChannels: [{ field: "newStatus", reason: "not a real reason to test" }],
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(UnsoundExtractionSchemaError);
  });

  it("throws when a legacyPayloadChannel declares an empty reason", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "order.status.transition",
      fields: [],
      example: { utterance: "x", payload: {} },
      legacyPayloadChannels: [{ field: "orderId", reason: "   " }],
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(UnsoundExtractionSchemaError);
  });

  it("a legacyPayloadChannel that is disjoint from schema.fields and carries a non-empty reason passes (the exact shape order.status.transition/payment.refund.issue declare)", () => {
    const good: CapabilityExtractionSchema = {
      capability: "order.status.transition",
      fields: [
        {
          name: "newStatus",
          trustClass: "directive",
          jsonSchema: { type: "string", description: "x" },
          required: true,
        },
      ],
      example: { utterance: "x", payload: { newStatus: "ready" } },
      legacyPayloadChannels: [
        { field: "orderId", reason: "BKL-089 authoritative direct lookup" },
      ],
    };
    expect(() => assertSoundExtractionSchema(good)).not.toThrow();
  });
});
