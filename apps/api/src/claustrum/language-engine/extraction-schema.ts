// extraction-schema.ts — the extraction-schema authoring contract (FE-1.1).
//
// A per-capability extraction schema is distinct from the capability's wire
// contract (its full payload type): it lists ONLY the fields the model can
// genuinely produce from a single utterance (State / Directive class) and
// FORBIDS Identity-class and safety-critical fields outright — they are
// never shown to the model, never requested of it, and (per the lint-shaped
// assertion below) structurally cannot appear in an authored schema.
//
// This is the net-new artifact FE-1.1 introduces; FE-T05 (this tracer)
// authors the FIRST instance (order.status.transition) and the contract every
// later capability's schema reuses (T11-14 rollout).

import type { FieldTrustClass } from "./field-trust.js";

/**
 * A minimal JSON-Schema fragment for one field's wire shape (draft-07-ish).
 *
 * FE-T14 adds `"array"` (with a required `items` sub-schema) — the first
 * rollout slice whose model-facing fields are genuinely list-shaped
 * (`dietaryFlags`/`favoriteCategories`, `specialRequests`). Deliberately
 * narrow: `items` is itself string/number/boolean-only (no nested arrays,
 * no object items) — every real array field this rollout needs is a flat
 * list of scalars (usually an enum-constrained string), and the kernel-level
 * wire types this schema class targets (`CustomerPreferencesUpdatePayload`,
 * `ReservationCreatePayload`/`ReservationModifyPayload`) never carry a
 * richer shape than `ReadonlyArray<string>` either — see the FE-T14 field
 * schemas for the grounding. Additive: every existing string/number/boolean
 * field and `assertSoundExtractionSchema`'s logic are untouched.
 */
export interface ExtractionFieldJsonSchema {
  readonly type: "string" | "number" | "boolean" | "array";
  readonly enum?: readonly string[];
  readonly description: string;
  /** Required when `type === "array"`; the array's element schema. */
  readonly items?: {
    readonly type: "string" | "number" | "boolean";
    readonly enum?: readonly string[];
  };
}

/** One field an extraction schema declares. */
export interface ExtractionFieldSpec {
  readonly name: string;
  readonly trustClass: FieldTrustClass;
  readonly jsonSchema: ExtractionFieldJsonSchema;
  readonly required: boolean;
}

/** A concrete worked example pairing an utterance with its expected payload. */
export interface ExtractionSchemaExample {
  readonly utterance: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * A capability's extraction schema: ONLY the fields the model can produce
 * from a single utterance. Never lists an Identity-class field — those are
 * always resolver-filled (FE-0.3) — and never a safety-critical field
 * (allergens, PII) per the governance user stories (spec §"Safety at the
 * boundary").
 */
export interface CapabilityExtractionSchema {
  readonly capability: string;
  readonly fields: readonly ExtractionFieldSpec[];
  readonly example: ExtractionSchemaExample;
}

/**
 * Names that must NEVER appear as a field on an authored extraction schema —
 * resolved identifiers (Identity class: resolver-only, model-forbidden) and
 * safety-critical / PII content the governance user stories (10-13) forbid
 * the model from filling. Extend this list as later slices add capabilities;
 * `assertSoundExtractionSchema` fails closed on any name in this set
 * regardless of the `trustClass` the author declared.
 */
export const FORBIDDEN_EXTRACTION_FIELD_NAMES: ReadonlySet<string> = new Set([
  // Identity — resolver-only.
  "orderId",
  "customerId",
  "cartId",
  "paymentId",
  "variantId",
  // FE-T09 — the granular amend kinds' resolver-filled order-line reference
  // (OrderAmendUpdateQtyPayload/OrderAmendRemoveItemPayload). Same Identity
  // class as variantId/orderId — resolved from the model's NL `item`
  // reference, never authored onto an extraction schema.
  "itemId",
  "reservationId",
  "sessionId",
  "actorId",
  "tenantId",
  "nonce",
  // Safety-critical / PII — never model-synthesized.
  "allergens",
  "cpf",
  "email",
  "phone",
  "cardPan",
  "isInternal",
]);

export class UnsoundExtractionSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsoundExtractionSchemaError";
  }
}

/**
 * The lint-shaped authoring-contract assertion: throws when a schema exposes
 * an identifier / PII / safety-critical field, or declares a field
 * `trustClass: "identity"` (Identity fields are resolver-only by definition
 * — they must never be authored onto an extraction schema at all). Every
 * authored `CapabilityExtractionSchema` MUST pass this before it is wired
 * onto the wire (see `order-status-transition.schema.ts` for the pattern);
 * a unit test pins this for each authored schema.
 */
export function assertSoundExtractionSchema(
  schema: CapabilityExtractionSchema,
): void {
  for (const field of schema.fields) {
    if (field.trustClass === "identity") {
      throw new UnsoundExtractionSchemaError(
        `extraction schema for "${schema.capability}" declares field ` +
          `"${field.name}" as Identity class — Identity fields are ` +
          `resolver-only and must never be authored onto a model-facing ` +
          `extraction schema (FE-0.3).`,
      );
    }
    if (FORBIDDEN_EXTRACTION_FIELD_NAMES.has(field.name)) {
      throw new UnsoundExtractionSchemaError(
        `extraction schema for "${schema.capability}" exposes forbidden ` +
          `field "${field.name}" (identifier / PII / safety-critical) to ` +
          `the model — see FORBIDDEN_EXTRACTION_FIELD_NAMES.`,
      );
    }
  }
}

/**
 * Build the wire JSON-Schema object for a capability's `payload` — the shape
 * embedded into the `express_intent` tool's `payload` sub-schema when this
 * capability is in the turn's allowed-intent set (see
 * `ibatexas-planner.ts`'s `buildToolSurface`). Asserts soundness first
 * (fail-closed: a schema that would leak an identifier never reaches the
 * wire).
 */
export function toPayloadJsonSchema(
  schema: CapabilityExtractionSchema,
): Record<string, unknown> {
  assertSoundExtractionSchema(schema);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of schema.fields) {
    properties[field.name] = { ...field.jsonSchema };
    if (field.required) required.push(field.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** The set of field names an extraction schema declares (for splitting a
 *  resolved payload back into its model-owned vs. resolver-owned parts). */
export function extractionFieldNames(
  schema: CapabilityExtractionSchema,
): ReadonlySet<string> {
  return new Set(schema.fields.map((f) => f.name));
}
