// schema-lint-gate.test.ts — the FE-T10 SCHEMA-LINT CI GATE.
//
// Upgrades the per-schema authoring-contract lint (`assertSoundExtractionSchema`,
// pinned per-schema by extraction-schema.test.ts / order-status-transition /
// payment-refund-issue's own suites) from an import-time-only assertion into
// an explicit, CI-visible GATE: this test WALKS every entry in the real
// `AUTHORED_SCHEMAS` registry (wire-schemas.ts) — the exact source
// `EXTRACTION_SCHEMAS_BY_CAPABILITY` builds the wire from — and rejects any
// exposing a forbidden field class (identifier / PII / allergen), so a
// FUTURE rollout ticket (T11-14) that authors a new schema and registers it
// here is checked automatically, without editing this gate. Rides `turbo
// test` like every other vitest suite — no separate CI wiring needed, exactly
// like the claimdefs `generated-drift.test.ts` freshness-gate idiom.
//
// Proven BOTH directions (red/green): the registry's real schemas pass
// (green); a deliberately non-compliant SYNTHETIC schema — constructed the
// same way, never mutating the real registry — fails (red), so the walk
// itself is proven non-vacuous.

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  UnsoundExtractionSchemaError,
  type CapabilityExtractionSchema,
} from "../extraction-schema.js";
import { AUTHORED_SCHEMAS } from "../wire-schemas.js";

describe("schema-lint CI gate — every AUTHORED_SCHEMAS entry is sound", () => {
  it("the registry is non-empty (a vacuous walk would prove nothing)", () => {
    expect(AUTHORED_SCHEMAS.length).toBeGreaterThan(0);
  });

  it("GREEN: every registered capability's extraction schema passes assertSoundExtractionSchema", () => {
    for (const schema of AUTHORED_SCHEMAS) {
      expect(
        () => assertSoundExtractionSchema(schema),
        `capability "${schema.capability}" must pass the schema-lint gate`,
      ).not.toThrow();
    }
  });

  it("GREEN: no registered schema exposes a forbidden field name", () => {
    const capabilitiesWithForbiddenFields = AUTHORED_SCHEMAS.filter((schema) =>
      schema.fields.some((f) => f.trustClass === "identity"),
    ).map((s) => s.capability);
    expect(capabilitiesWithForbiddenFields).toEqual([]);
  });

  // FE-T11 (review) — legacyPayloadChannels lint: every registered channel
  // (today: payment.refund.issue / order.status.transition's orderId) must
  // be disjoint from its own schema's fields and carry a non-empty reason —
  // walked generically so a FUTURE capability that declares a channel is
  // automatically covered.
  it("GREEN: every registered legacyPayloadChannel is disjoint from its schema's own fields and has a non-empty reason", () => {
    for (const schema of AUTHORED_SCHEMAS) {
      const fieldNames = new Set(schema.fields.map((f) => f.name));
      for (const channel of schema.legacyPayloadChannels ?? []) {
        expect(
          fieldNames.has(channel.field),
          `capability "${schema.capability}"'s legacyPayloadChannel "${channel.field}" must not collide with its own extraction field`,
        ).toBe(false);
        expect(
          channel.reason.trim().length,
          `capability "${schema.capability}"'s legacyPayloadChannel "${channel.field}" must have a non-empty reason`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("RED: a legacyPayloadChannel colliding with the schema's own field fails the gate", () => {
    const nonCompliant: CapabilityExtractionSchema = {
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
      legacyPayloadChannels: [{ field: "newStatus", reason: "bogus" }],
    };
    expect(() => assertSoundExtractionSchema(nonCompliant)).toThrow(
      UnsoundExtractionSchemaError,
    );
  });

  it("RED: a legacyPayloadChannel with an empty/whitespace-only reason fails the gate", () => {
    const nonCompliant: CapabilityExtractionSchema = {
      capability: "payment.refund.issue",
      fields: [],
      example: { utterance: "x", payload: {} },
      legacyPayloadChannels: [{ field: "orderId", reason: "" }],
    };
    expect(() => assertSoundExtractionSchema(nonCompliant)).toThrow(
      UnsoundExtractionSchemaError,
    );
  });

  it("RED: a deliberately non-compliant schema (exposes a forbidden identifier) fails the gate", () => {
    const nonCompliant: CapabilityExtractionSchema = {
      capability: "payment.refund.issue",
      fields: [
        ...AUTHORED_SCHEMAS[0]!.fields,
        {
          name: "paymentId",
          trustClass: "state",
          jsonSchema: { type: "string", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(nonCompliant)).toThrow(
      UnsoundExtractionSchemaError,
    );
  });

  it("RED: a deliberately non-compliant schema (exposes a PII field) fails the gate", () => {
    const nonCompliant: CapabilityExtractionSchema = {
      capability: "customer.contact.update",
      fields: [
        {
          name: "email",
          trustClass: "directive",
          jsonSchema: { type: "string", description: "x" },
          required: false,
        },
      ],
      example: { utterance: "x", payload: {} },
    };
    expect(() => assertSoundExtractionSchema(nonCompliant)).toThrow(
      UnsoundExtractionSchemaError,
    );
  });

  it("RED: a deliberately non-compliant schema (exposes an allergen field) fails the gate", () => {
    const nonCompliant: CapabilityExtractionSchema = {
      capability: "order.item.add",
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
    expect(() => assertSoundExtractionSchema(nonCompliant)).toThrow(
      UnsoundExtractionSchemaError,
    );
  });

  it("RED: a schema declaring a field trustClass:identity fails the gate regardless of name", () => {
    const nonCompliant: CapabilityExtractionSchema = {
      capability: "order.status.transition",
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
    expect(() => assertSoundExtractionSchema(nonCompliant)).toThrow(
      UnsoundExtractionSchemaError,
    );
  });

  it("proves the walk is non-vacuous: sweeping the RED fixtures through the SAME walk-all loop the GREEN test uses trips it", () => {
    const badRegistry: readonly CapabilityExtractionSchema[] = [
      ...AUTHORED_SCHEMAS,
      {
        capability: "order.note.add",
        fields: [
          {
            name: "cpf",
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
    expect(failing.map((s) => s.capability)).toContain("order.note.add");
  });
});
