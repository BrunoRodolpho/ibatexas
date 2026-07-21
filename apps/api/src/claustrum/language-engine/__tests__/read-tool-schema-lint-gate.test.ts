// read-tool-schema-lint-gate.test.ts — the FE-T13 read-tool SCHEMA-LINT CI
// GATE. The read-tool sibling of schema-lint-gate.test.ts (FE-T10, walking
// wire-schemas.ts's `AUTHORED_SCHEMAS`) — same mechanism, same
// `assertSoundExtractionSchema`, different registry
// (`READ_TOOL_AUTHORED_SCHEMAS`, read-tool-schemas.ts): this test WALKS
// every entry and rejects any exposing a forbidden field class (identifier /
// PII / allergen), so a FUTURE read-tool schema addition is checked
// automatically, without editing this gate.
//
// Proven BOTH directions (red/green): the registry's real schemas pass
// (green); a deliberately non-compliant SYNTHETIC schema — constructed the
// same way, never mutating the real registry — fails (red).

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  UnsoundExtractionSchemaError,
  type CapabilityExtractionSchema,
} from "../extraction-schema.js";
import { READ_TOOL_AUTHORED_SCHEMAS } from "../read-tool-schemas.js";

describe("read-tool schema-lint CI gate — every READ_TOOL_AUTHORED_SCHEMAS entry is sound", () => {
  it("the registry covers the full 12-tool chat-plane read roster (a vacuous walk would prove nothing)", () => {
    expect(READ_TOOL_AUTHORED_SCHEMAS.length).toBe(12);
    expect(new Set(READ_TOOL_AUTHORED_SCHEMAS.map((s) => s.capability)).size).toBe(12);
  });

  it("GREEN: every registered read tool's extraction schema passes assertSoundExtractionSchema", () => {
    for (const schema of READ_TOOL_AUTHORED_SCHEMAS) {
      expect(
        () => assertSoundExtractionSchema(schema),
        `read tool "${schema.capability}" must pass the schema-lint gate`,
      ).not.toThrow();
    }
  });

  it("GREEN: no registered read-tool schema declares a trustClass:identity field", () => {
    const withForbiddenTrust = READ_TOOL_AUTHORED_SCHEMAS.filter((schema) =>
      schema.fields.some((f) => f.trustClass === "identity"),
    ).map((s) => s.capability);
    expect(withForbiddenTrust).toEqual([]);
  });

  it("GREEN: no registered read-tool schema exposes a name in FORBIDDEN_EXTRACTION_FIELD_NAMES (orderId/paymentId/customerId/...)", () => {
    const forbiddenNames = ["orderId", "paymentId", "customerId", "cartId", "reservationId"];
    for (const schema of READ_TOOL_AUTHORED_SCHEMAS) {
      const fieldNames = schema.fields.map((f) => f.name);
      for (const forbidden of forbiddenNames) {
        expect(
          fieldNames,
          `read tool "${schema.capability}" must never expose "${forbidden}"`,
        ).not.toContain(forbidden);
      }
    }
  });

  it("RED: a deliberately non-compliant read schema (exposes a forbidden identifier) fails the gate", () => {
    const nonCompliant: CapabilityExtractionSchema = {
      capability: "check_order_status",
      fields: [
        {
          name: "orderId",
          trustClass: "state",
          jsonSchema: { type: "string", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(nonCompliant)).toThrow(UnsoundExtractionSchemaError);
  });

  it("RED: a deliberately non-compliant read schema (exposes a PII field) fails the gate", () => {
    const nonCompliant: CapabilityExtractionSchema = {
      capability: "get_my_profile",
      fields: [
        {
          name: "cpf",
          trustClass: "directive",
          jsonSchema: { type: "string", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(nonCompliant)).toThrow(UnsoundExtractionSchemaError);
  });

  it("RED: a schema declaring a field trustClass:identity fails the gate regardless of name", () => {
    const nonCompliant: CapabilityExtractionSchema = {
      capability: "check_order_status",
      fields: [
        {
          name: "targetResource",
          trustClass: "identity",
          jsonSchema: { type: "string", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(nonCompliant)).toThrow(UnsoundExtractionSchemaError);
  });

  it("proves the walk is non-vacuous: sweeping a RED fixture through the SAME walk-all loop the GREEN test uses trips it", () => {
    const badRegistry: readonly CapabilityExtractionSchema[] = [
      ...READ_TOOL_AUTHORED_SCHEMAS,
      {
        capability: "get_my_preferences",
        fields: [
          {
            name: "email",
            trustClass: "directive",
            jsonSchema: { type: "string", description: "x" },
            required: false,
          },
        ],
        example: { utterance: "x", payload: {} },
      },
    ];
    const failing = badRegistry.filter((schema) => {
      try {
        assertSoundExtractionSchema(schema);
        return false;
      } catch (err) {
        return err instanceof UnsoundExtractionSchemaError;
      }
    });
    expect(failing.map((s) => s.capability)).toContain("get_my_preferences");
  });
});
