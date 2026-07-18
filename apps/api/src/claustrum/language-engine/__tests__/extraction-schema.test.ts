// extraction-schema.test.ts — the extraction-schema authoring-contract
// lint (FE-1.1): an authored schema must never expose an Identity-class or
// forbidden (identifier/PII/safety-critical) field to the model.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
  forbiddenPiiAliasStem,
  normalizeExtractionFieldName,
  PII_ALIAS_STEMS,
  NEVER_EXEMPTABLE_FIELD_NAMES,
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

describe("ExtractionFieldJsonSchema — FE-T14 array-type extension", () => {
  it("a sound schema with an array field (enum-constrained items) passes and builds the expected wire shape", () => {
    const good: CapabilityExtractionSchema = {
      capability: "customer.preferences.update",
      fields: [
        {
          name: "dietaryFlags",
          trustClass: "directive",
          jsonSchema: {
            type: "array",
            items: { type: "string", enum: ["vegetarian", "vegan", "gluten_free"] },
            description: "x",
          },
          required: false,
        },
      ],
      example: { utterance: "x", payload: { dietaryFlags: ["vegetarian"] } },
    };
    expect(() => assertSoundExtractionSchema(good)).not.toThrow();
    expect(toPayloadJsonSchema(good)).toEqual({
      type: "object",
      properties: {
        dietaryFlags: {
          type: "array",
          items: { type: "string", enum: ["vegetarian", "vegan", "gluten_free"] },
          description: "x",
        },
      },
      additionalProperties: false,
    });
  });

  it("a forbidden field name declared as an array still fails the gate (name check is type-agnostic)", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "allergens",
          trustClass: "directive",
          jsonSchema: { type: "array", items: { type: "string" }, description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(UnsoundExtractionSchemaError);
  });
});

describe("array-field lint rule — closed enum OR explicit freeform opt-in, never neither (FE-T14 rulings)", () => {
  it("RED: an array field with no items.enum and no items.freeform fails the gate", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "someList",
          trustClass: "directive",
          jsonSchema: { type: "array", items: { type: "string" }, description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(UnsoundExtractionSchemaError);
    expect(() => assertSoundExtractionSchema(bad)).toThrow(/items\.enum.*items\.freeform|freeform.*enum/);
  });

  it("GREEN: an array field with items.freeform: true (and no enum) passes", () => {
    const good: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "someList",
          trustClass: "directive",
          jsonSchema: {
            type: "array",
            items: { type: "string", freeform: true },
            description: "x",
          },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(good)).not.toThrow();
  });

  it("GREEN: an array field with items.enum (and no freeform marker) passes", () => {
    const good: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "someList",
          trustClass: "directive",
          jsonSchema: {
            type: "array",
            items: { type: "string", enum: ["a", "b"] },
            description: "x",
          },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(good)).not.toThrow();
  });

  it("a non-array field is never subject to this rule, even with no enum", () => {
    const good: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "note",
          trustClass: "directive",
          jsonSchema: { type: "string", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(good)).not.toThrow();
  });
});

describe("permittedIdentifiers — the narrow, explicit escape hatch from FORBIDDEN_EXTRACTION_FIELD_NAMES (FE-T14)", () => {
  it("RED: a forbidden field name still fails the gate when permittedIdentifiers is absent", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "productId",
          trustClass: "state",
          jsonSchema: { type: "string", description: "x" },
          required: true,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(UnsoundExtractionSchemaError);
  });

  it("RED: a forbidden field name still fails the gate when permittedIdentifiers names a DIFFERENT field", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "productId",
          trustClass: "state",
          jsonSchema: { type: "string", description: "x" },
          required: true,
        },
      ],
      example: { utterance: "x", payload: {} },
      permittedIdentifiers: ["someOtherField"],
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(UnsoundExtractionSchemaError);
  });

  it("GREEN: a forbidden field name explicitly named in permittedIdentifiers passes", () => {
    const good: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "productId",
          trustClass: "state",
          jsonSchema: { type: "string", description: "x" },
          required: true,
        },
      ],
      example: { utterance: "x", payload: { productId: "prod_123" } },
      permittedIdentifiers: ["productId"],
    };
    expect(() => assertSoundExtractionSchema(good)).not.toThrow();
    expect(toPayloadJsonSchema(good)).toEqual({
      type: "object",
      properties: { productId: { type: "string", description: "x" } },
      required: ["productId"],
      additionalProperties: false,
    });
  });

  it("permittedIdentifiers does NOT exempt a field from the Identity-class trustClass check", () => {
    const bad: CapabilityExtractionSchema = {
      capability: "x",
      fields: [
        {
          name: "productId",
          trustClass: "identity",
          jsonSchema: { type: "string", description: "x" },
          required: true,
        },
      ],
      example: { utterance: "x", payload: {} },
      permittedIdentifiers: ["productId"],
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(UnsoundExtractionSchemaError);
  });

  it("a genuinely safety-critical/PII name (allergens) is STILL forbidden even if permittedIdentifiers names it — this is a STRUCTURAL guarantee, not merely a review-time convention: permittedIdentifiers is only ever consulted for EXEMPTABLE_IDENTIFIER_NAMES, and NEVER_EXEMPTABLE_FIELD_NAMES is checked first, unconditionally", () => {
    const stillBad: CapabilityExtractionSchema = {
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
      permittedIdentifiers: ["allergens"],
    };
    expect(() => assertSoundExtractionSchema(stillBad)).toThrow(UnsoundExtractionSchemaError);
  });

  it.each(["cpf", "email", "phone", "cardPan", "isInternal"])(
    "%s is likewise never exemptable via permittedIdentifiers",
    (name) => {
      const stillBad: CapabilityExtractionSchema = {
        capability: "x",
        fields: [
          {
            name,
            trustClass: "directive",
            jsonSchema: { type: "string", description: "x" },
            required: false,
          },
        ],
        example: { utterance: "x", payload: {} },
        permittedIdentifiers: [name],
      };
      expect(() => assertSoundExtractionSchema(stillBad)).toThrow(UnsoundExtractionSchemaError);
    },
  );
});

// FE-D21 — the aliasing-heuristic arm: NEVER_EXEMPTABLE_FIELD_NAMES is an
// exact-name set, so an aliased spelling of the same PII/safety concept
// (emailAddress vs email) must also be rejected. See extraction-schema.ts's
// PII_ALIAS_STEMS doc for the scope/derivation rationale.
describe("FE-D21 aliasing hardening — a NEVER_EXEMPTABLE concept is caught under aliased spellings", () => {
  const oneField = (name: string): CapabilityExtractionSchema => ({
    capability: "x",
    fields: [
      {
        name,
        trustClass: "directive",
        jsonSchema: { type: "string", description: "x" },
        required: false,
      },
    ],
    example: { utterance: "x", payload: {} },
  });

  // RED fixtures: the variant forms the old exact-match let through.
  it.each([
    "emailAddress",
    "customerEmail",
    "cpfNumber",
    "customerCpf",
    "cpf_digits",
    "phoneNumber",
    "customerPhone",
    "allergenInfo",
    "allergensList",
    "cardPanLast4",
    "card_pan",
    "internalOnly",
    "isInternalNote",
  ])("RED: aliased field name %s fails the gate", (name) => {
    expect(() => assertSoundExtractionSchema(oneField(name))).toThrow(
      UnsoundExtractionSchemaError,
    );
    expect(() => assertSoundExtractionSchema(oneField(name))).toThrow(/FE-D21/);
  });

  // GREEN: every field name any real authored/read-tool schema declares today
  // stays sound — the heuristic adds zero false positives.
  it.each([
    "newStatus",
    "orderReference",
    "timeSlotId",
    "newTimeSlotId",
    "partySize",
    "newPartySize",
    "quantity",
    "amount",
    "reason",
    "comment",
    "rating",
    "delivery_type",
    "payment_method",
    "dietary_restrictions",
    "favorite_categories",
    "preferredTime",
    "productId", // an exempted identifier, unaffected by the PII heuristic
  ])("GREEN: real field name %s is not flagged as a PII alias", (name) => {
    expect(forbiddenPiiAliasStem(name)).toBeUndefined();
  });

  it("forbiddenPiiAliasStem returns the specific stem it matched", () => {
    expect(forbiddenPiiAliasStem("emailAddress")).toBe("email");
    expect(forbiddenPiiAliasStem("customerCpf")).toBe("cpf");
    expect(forbiddenPiiAliasStem("cpf_digits")).toBe("cpf");
    expect(forbiddenPiiAliasStem("allergenInfo")).toBe("allergen");
    expect(forbiddenPiiAliasStem("cardPanLast4")).toBe("cardpan");
    expect(forbiddenPiiAliasStem("newStatus")).toBeUndefined();
  });

  it("normalizeExtractionFieldName lowercases and strips non-alphanumerics", () => {
    expect(normalizeExtractionFieldName("cpf_digits")).toBe("cpfdigits");
    expect(normalizeExtractionFieldName("card-Pan")).toBe("cardpan");
    expect(normalizeExtractionFieldName("CustomerEmail")).toBe("customeremail");
  });

  it("the allowlist escape suppresses a coincidental collision (mechanism proven via an injected allowlist)", () => {
    // The real PII_ALIAS_ALLOWLIST is empty; prove the escape path works by
    // injecting one, without adding a live (dead) allowlist entry.
    const injected = new Set([normalizeExtractionFieldName("emailAddress")]);
    expect(forbiddenPiiAliasStem("emailAddress", injected)).toBeUndefined();
    // …and only for the allowlisted token — a different alias still trips.
    expect(forbiddenPiiAliasStem("customerCpf", injected)).toBe("cpf");
  });

  it("COVERAGE: every NEVER_EXEMPTABLE name is itself caught by a PII_ALIAS_STEMS stem (stems stay in sync with the set)", () => {
    for (const name of NEVER_EXEMPTABLE_FIELD_NAMES) {
      const normalized = normalizeExtractionFieldName(name);
      const covered = PII_ALIAS_STEMS.some((stem) => normalized.includes(stem));
      expect(covered, `NEVER_EXEMPTABLE name "${name}" must be covered by a PII_ALIAS_STEMS stem`).toBe(
        true,
      );
    }
  });

  it("the alias heuristic does NOT weaken the exact NEVER_EXEMPTABLE guarantee: an exact PII name still throws even if allowlisted", () => {
    // `email` is an exact NEVER_EXEMPTABLE name — the unconditional exact
    // check upstream fires first, so no allowlist/heuristic path can admit it.
    const bad: CapabilityExtractionSchema = {
      ...oneField("email"),
      permittedIdentifiers: ["email"],
    };
    expect(() => assertSoundExtractionSchema(bad)).toThrow(UnsoundExtractionSchemaError);
  });
});
