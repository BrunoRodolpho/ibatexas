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
  sanitizeReadToolInput,
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

  it("the 5 zero-field reads produce a closed empty wire schema ({} properties, additionalProperties:false)", () => {
    const zeroField = [
      GET_CART_READ_SCHEMA,
      GET_ORDER_HISTORY_READ_SCHEMA,
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

describe("CHECK_ORDER_STATUS_READ_SCHEMA / GET_PAYMENT_STATUS_READ_SCHEMA — orderId forbidden, orderReference is the one optional field", () => {
  it("neither schema declares orderId — it is resolver-only (claustrum-bootstrap.ts's resolveCustomerOrderReference)", () => {
    expect(extractionFieldNames(CHECK_ORDER_STATUS_READ_SCHEMA).has("orderId")).toBe(false);
    expect(extractionFieldNames(GET_PAYMENT_STATUS_READ_SCHEMA).has("orderId")).toBe(false);
  });

  it("both expose ONLY an optional {orderReference} display-number NL reference, Directive class", () => {
    for (const schema of [CHECK_ORDER_STATUS_READ_SCHEMA, GET_PAYMENT_STATUS_READ_SCHEMA]) {
      const names = extractionFieldNames(schema);
      expect([...names]).toEqual(["orderReference"]);
      expect(schema.fields[0]!.trustClass).toBe("directive");
      const wire = toPayloadJsonSchema(schema);
      expect(wire.required).toBeUndefined();
      expect((wire.properties as { orderReference: { type: string } }).orderReference.type).toBe("string");
    }
  });
});

describe("GET_RECOMMENDATIONS_READ_SCHEMA", () => {
  it("exposes ONLY the optional {context, dietaryTag} enums (BKL-137)", () => {
    const names = extractionFieldNames(GET_RECOMMENDATIONS_READ_SCHEMA);
    expect([...names]).toEqual(["context", "dietaryTag"]);
    const wire = toPayloadJsonSchema(GET_RECOMMENDATIONS_READ_SCHEMA);
    expect(wire.required).toBeUndefined();
    expect(
      (wire.properties as { context: { enum: string[] } }).context.enum,
    ).toEqual(["homepage", "cart", "product_page"]);
    // BKL-137 — the CLOSED owner-attested dietary-tag vocabulary (Directive class:
    // customer-authored intent; the executor drops out-of-vocabulary values).
    expect(
      (wire.properties as { dietaryTag: { enum: string[] } }).dietaryTag.enum,
    ).toEqual(["vegetariano", "vegano", "sem_gluten", "sem_lactose"]);
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

// FE-T13 (team-lead P5 ruling) — sanitizeReadToolInput is the fail-safe
// dispatch-boundary validation this ruling required: nothing upstream
// validates a read tool's call.input against its advertised inputSchema, so
// this is the ONLY enforcement point. Never throws; strips rather than fails.
describe("sanitizeReadToolInput", () => {
  it("drops a field NOT declared on the tool's schema (a forged/unexpected key)", () => {
    expect(sanitizeReadToolInput("check_availability", { date: "2026-07-18", partySize: 4, customerId: "victim" })).toEqual({
      date: "2026-07-18",
      partySize: 4,
    });
  });

  it("drops a declared field whose runtime type doesn't match (never coerces, never forwards)", () => {
    expect(sanitizeReadToolInput("check_availability", { date: "2026-07-18", partySize: "4" })).toEqual({
      date: "2026-07-18",
    });
  });

  it("drops a declared enum field whose value is outside the enum", () => {
    expect(sanitizeReadToolInput("get_recommendations", { context: "checkout" })).toEqual({});
    expect(sanitizeReadToolInput("get_recommendations", { context: "cart" })).toEqual({ context: "cart" });
  });

  it("a tool with NO authored schema is untouched (today's behavior, unaffected)", () => {
    expect(sanitizeReadToolInput("ops_snapshot", { anything: "goes", here: 1 })).toEqual({
      anything: "goes",
      here: 1,
    });
  });

  it("non-object / null input for an authored-schema tool sanitizes to {} rather than throwing", () => {
    expect(sanitizeReadToolInput("get_cart", null)).toEqual({});
    expect(sanitizeReadToolInput("get_cart", "not an object")).toEqual({});
    expect(sanitizeReadToolInput("get_cart", undefined)).toEqual({});
  });

  it("a zero-field tool always sanitizes to {} regardless of what the model sent", () => {
    expect(sanitizeReadToolInput("get_cart", { cartId: "victim-cart", extra: true })).toEqual({});
  });

  it("a required field that's present and well-typed passes through", () => {
    expect(sanitizeReadToolInput("get_also_added", { productId: "prod_123" })).toEqual({ productId: "prod_123" });
  });

  it("a required field that's malformed is dropped (not coerced) — the downstream handler's own zod schema then reports the real missing-field error", () => {
    expect(sanitizeReadToolInput("get_also_added", { productId: 123 })).toEqual({});
  });
});
