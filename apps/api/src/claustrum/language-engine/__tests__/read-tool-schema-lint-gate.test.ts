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
import { IBATEXAS_COMPOSED_CAPABILITY_PLANNERS } from "@ibatexas/packs-composed";
import {
  assertSoundExtractionSchema,
  UnsoundExtractionSchemaError,
  type CapabilityExtractionSchema,
} from "../extraction-schema.js";
import {
  READ_TOOL_AUTHORED_SCHEMAS,
  READ_TOOL_SCHEMAS_BY_NAME,
} from "../read-tool-schemas.js";
import { ROSTER_DRIFT_CONTEXTS } from "../../../tools/register-ibatexas-tool-packs.js";

// ── The roll call that CLOSES the FE-T13 triangle ────────────────────────
//
// Before this: every FE-T13 gate — this file's own coverage assertion, the
// per-schema table in read-tool-schemas.test.ts, and the composed-prompt
// golden — was quantified over `READ_TOOL_AUTHORED_SCHEMAS`, so NO test in
// the repo could observe an advertised chat-plane read tool with no authored
// schema: a 13th read simply never entered any gate's universe. The old
// assertion here read `READ_TOOL_AUTHORED_SCHEMAS.length === 12` — a COUNT
// over the registry checking itself, which can never NAME what went missing
// (the F-14 ruling) and is true by construction against a registry that is
// the very thing under test.
//
// The stakes are the three FE-T13 protections, all keyed on
// `READ_TOOL_SCHEMAS_BY_NAME`: `sanitizeReadToolInput` no-ops on an unknown
// tool (read-tool-schemas.ts — the model's raw input is forwarded verbatim to
// the executor), `buildToolSurface` falls back to the untyped
// `additionalProperties:true` blob (ibatexas-planner.ts), and the read-loop
// calibration log omits the call entirely (ibatexas-planner.ts). This is NOT
// an IDOR: every read executor derives its owner from `state`, never from
// `input`. It is the loss of the input-shape bound FE-T13 exists to impose.
//
// `readToolRosterDrift` (register-ibatexas-tool-packs.ts) already reconciles
// executors ↔ advertisements; nothing reconciled either against SCHEMAS.

/**
 * HAND-WRITTEN, not derived — the 12 chat-plane read tools, by NAME. A
 * derived list would be defeated by the same mechanism it is meant to catch
 * (F-14: a derived control cannot name a row that vanished from its own
 * source). Adding or removing a chat-plane read MUST edit this literal.
 */
const CHAT_PLANE_READ_ROLL_CALL: readonly string[] = [
  "get_cart",
  "get_order_history",
  "check_order_status",
  "get_recommendations",
  "get_also_added",
  "get_ordered_together",
  "get_payment_status",
  "get_payment_history",
  "check_availability",
  "get_my_reservations",
  "get_my_profile",
  "get_my_preferences",
];

/**
 * The chat-plane probes: `deriveIbatexasPlannerContext` pins `staffId:null` on
 * this plane, so the staff probe (which surfaces `ops_snapshot` and the
 * sales-analytics read — deliberately unauthored, per read-tool-schemas.ts's
 * scope note) is excluded by that property rather than by name.
 */
const CHAT_PLANE_PROBES = ROSTER_DRIFT_CONTEXTS.filter(
  (c) => (c.state as { ctx: { staffId: string | null } }).ctx.staffId === null,
);

/**
 * The advertised chat-plane read roster, derived from the SAME composed pack
 * planners boot composes — and DELIBERATELY never from
 * `READ_TOOL_AUTHORED_SCHEMAS`. This is the independent leg the triangle was
 * missing.
 */
const ADVERTISED_CHAT_PLANE_READS: readonly string[] = [
  ...new Set(
    IBATEXAS_COMPOSED_CAPABILITY_PLANNERS.flatMap((p) =>
      CHAT_PLANE_PROBES.flatMap((probe) => [
        ...p.plan(probe.state, probe.context).visibleReadTools,
      ]),
    ),
  ),
];

describe("read-tool schema-lint CI gate — every READ_TOOL_AUTHORED_SCHEMAS entry is sound", () => {
  it("the hand-written roll call and the planner-advertised chat-plane roster name EXACTLY the same 12 reads (both directions)", () => {
    // The derivation must be non-vacuous, and the staffId filter must actually
    // discriminate — an empty or unfiltered probe set would make the equality
    // below assert against the wrong universe.
    expect(CHAT_PLANE_PROBES.length).toBeGreaterThan(0);
    expect(CHAT_PLANE_PROBES.length).toBeLessThan(ROSTER_DRIFT_CONTEXTS.length);
    // Set equality by NAME, both ways at once: an advertised read missing from
    // the roll call, or a roll-call entry no planner advertises, names itself
    // in the diff.
    expect([...ADVERTISED_CHAT_PLANE_READS].sort()).toEqual([...CHAT_PLANE_READ_ROLL_CALL].sort());
  });

  it("every rolled-call chat-plane read has an AUTHORED schema — the edge that closes the triangle", () => {
    // Quantified over the HAND-WRITTEN roll call, never over the registry:
    // this is the assertion a 13th advertised read with no schema fails.
    for (const name of CHAT_PLANE_READ_ROLL_CALL) {
      expect(
        READ_TOOL_SCHEMAS_BY_NAME.has(name),
        `chat-plane read "${name}" has NO authored extraction schema — sanitizeReadToolInput would no-op on it, ` +
          `it would be advertised with additionalProperties:true, and it would drop out of the read-loop calibration log`,
      ).toBe(true);
    }
    // And no schema authored for a name nothing advertises (dead weight / a
    // rename that silently detached from the roster).
    expect(READ_TOOL_AUTHORED_SCHEMAS.map((s) => s.capability).sort()).toEqual(
      [...CHAT_PLANE_READ_ROLL_CALL].sort(),
    );
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
