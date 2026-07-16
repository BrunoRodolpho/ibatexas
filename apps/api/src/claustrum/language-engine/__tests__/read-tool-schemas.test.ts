// read-tool-schemas.test.ts — FE-T13: per-read-tool schema authoring-contract
// coverage. Complements the registry-wide read-tool-schema-lint-gate.test.ts
// (soundness across the whole registry) and read-tool-extraction-prompt-
// golden.test.ts (the composed wire byte-identity pin) with per-schema field
// assertions — mirrors order-amend-granular.schema.test.ts's pattern.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import {
  READ_TOOL_AUTHORED_SCHEMAS,
  READ_TOOL_SCHEMAS_BY_NAME,
  GET_CART_READ_SCHEMA,
  GET_ORDER_HISTORY_READ_SCHEMA,
  CHECK_ORDER_STATUS_READ_SCHEMA,
  GET_RECOMMENDATIONS_READ_SCHEMA,
  GET_ALSO_ADDED_READ_SCHEMA,
  GET_ORDERED_TOGETHER_READ_SCHEMA,
  GET_PAYMENT_STATUS_READ_SCHEMA,
  GET_PAYMENT_HISTORY_READ_SCHEMA,
  CHECK_AVAILABILITY_READ_SCHEMA,
  GET_MY_RESERVATIONS_READ_SCHEMA,
  GET_MY_PROFILE_READ_SCHEMA,
  GET_MY_PREFERENCES_READ_SCHEMA,
} from "../read-tool-schemas.js";

describe("every authored read-tool schema — table-driven basic invariants", () => {
  it.each(READ_TOOL_AUTHORED_SCHEMAS.map((s) => [s.capability, s] as const))(
    "%s: passes the lint gate, is registered under its own name, and never exposes an identifier",
    (name, schema) => {
      expect(() => assertSoundExtractionSchema(schema)).not.toThrow();
      expect(READ_TOOL_SCHEMAS_BY_NAME.has(name)).toBe(true);
      const identifierNames = ["orderId", "paymentId", "customerId", "cartId", "reservationId", "sessionId"];
      for (const field of schema.fields) {
        expect(identifierNames).not.toContain(field.name);
        expect(field.trustClass).not.toBe("identity");
      }
      // Every worked example's utterance is non-empty pt-BR text and its
      // payload is a subset of the schema's own declared field names — an
      // author typo (a field in `example.payload` not in `fields`) would
      // otherwise silently document a payload the schema can't produce.
      expect(schema.example.utterance.length).toBeGreaterThan(0);
      const declaredNames = new Set(schema.fields.map((f) => f.name));
      for (const key of Object.keys(schema.example.payload)) {
        expect(declaredNames.has(key), `${name}: example.payload key "${key}" is not a declared field`).toBe(true);
      }
    },
  );

  it("the 8 zero-field reads produce a closed empty wire schema ({} properties, additionalProperties:false)", () => {
    const zeroField = [
      GET_CART_READ_SCHEMA,
      GET_ORDER_HISTORY_READ_SCHEMA,
      CHECK_ORDER_STATUS_READ_SCHEMA,
      GET_PAYMENT_STATUS_READ_SCHEMA,
      GET_PAYMENT_HISTORY_READ_SCHEMA,
      GET_MY_PROFILE_READ_SCHEMA,
      GET_MY_PREFERENCES_READ_SCHEMA,
    ];
    for (const schema of zeroField) {
      expect(schema.fields).toEqual([]);
      expect(toPayloadJsonSchema(schema)).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
    }
  });
});

describe("CHECK_ORDER_STATUS_READ_SCHEMA / GET_PAYMENT_STATUS_READ_SCHEMA — orderId forbidden by construction", () => {
  it("neither schema has ANY field — orderId is resolver-only (claustrum-bootstrap.ts's resolveOrderId auto-resolve)", () => {
    expect(extractionFieldNames(CHECK_ORDER_STATUS_READ_SCHEMA).size).toBe(0);
    expect(extractionFieldNames(GET_PAYMENT_STATUS_READ_SCHEMA).size).toBe(0);
  });
});

describe("GET_RECOMMENDATIONS_READ_SCHEMA", () => {
  it("exposes ONLY an optional {context} enum", () => {
    const names = extractionFieldNames(GET_RECOMMENDATIONS_READ_SCHEMA);
    expect([...names]).toEqual(["context"]);
    const wire = toPayloadJsonSchema(GET_RECOMMENDATIONS_READ_SCHEMA);
    expect(wire.required).toBeUndefined();
    expect(
      (wire.properties as { context: { enum: string[] } }).context.enum,
    ).toEqual(["homepage", "cart", "product_page"]);
  });
});

describe("GET_ALSO_ADDED_READ_SCHEMA / GET_ORDERED_TOGETHER_READ_SCHEMA", () => {
  it("both expose ONLY a required {productId} lookup key — never an owner-scoped identifier", () => {
    for (const schema of [GET_ALSO_ADDED_READ_SCHEMA, GET_ORDERED_TOGETHER_READ_SCHEMA]) {
      const names = extractionFieldNames(schema);
      expect([...names]).toEqual(["productId"]);
      const wire = toPayloadJsonSchema(schema);
      expect(wire.required).toEqual(["productId"]);
      expect(schema.fields[0]!.trustClass).toBe("state");
    }
  });
});

describe("CHECK_AVAILABILITY_READ_SCHEMA", () => {
  it("exposes {date, partySize} required + {preferredTime} optional — the SAME fields CheckAvailabilityInputSchema accepts", () => {
    const names = extractionFieldNames(CHECK_AVAILABILITY_READ_SCHEMA);
    expect([...names].sort()).toEqual(["date", "partySize", "preferredTime"]);
    const wire = toPayloadJsonSchema(CHECK_AVAILABILITY_READ_SCHEMA);
    expect(wire.required).toEqual(["date", "partySize"]);
    const props = wire.properties as { date: { type: string }; partySize: { type: string } };
    expect(props.date.type).toBe("string");
    expect(props.partySize.type).toBe("number");
  });
});

describe("GET_MY_RESERVATIONS_READ_SCHEMA", () => {
  it("exposes ONLY an optional {status} enum — never customerId (owner resolved server-side)", () => {
    const names = extractionFieldNames(GET_MY_RESERVATIONS_READ_SCHEMA);
    expect([...names]).toEqual(["status"]);
    expect(names.has("customerId")).toBe(false);
    const wire = toPayloadJsonSchema(GET_MY_RESERVATIONS_READ_SCHEMA);
    expect(wire.required).toBeUndefined();
    expect(
      (wire.properties as { status: { enum: string[] } }).status.enum,
    ).toEqual(["pending", "confirmed", "seated", "completed", "cancelled", "no_show"]);
  });
});
