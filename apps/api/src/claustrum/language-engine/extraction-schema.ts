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
  /**
   * Required when `type === "array"`; the array's element schema. MUST
   * declare EITHER `enum` (a closed, bounded value set) OR `freeform: true`
   * — an author who omits both gets a lint failure
   * (`assertSoundExtractionSchema`), never a silently-unbounded array. This
   * is a deliberate-opt-in, not a default: an array field with no enum and
   * no `freeform` marker is far more likely an author who forgot to close
   * the set than one who genuinely wants open text (CRITICAL DESIGN RULE
   * from the FE-T14 rulings — "no unbounded junk arrays by default").
   * `freeform: true` fields still carry a real bound in practice — the
   * field's own `description` documents WHAT kind of free text is expected
   * (see e.g. customer-whatsapp-convenience.schema.ts's `dietaryFlags`/
   * `favoriteCategories` — genuinely open-vocabulary preference words, not
   * a fixed enum, but never truly unconstrained junk either).
   */
  readonly items?: {
    readonly type: "string" | "number" | "boolean";
    readonly enum?: readonly string[];
    readonly freeform?: true;
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
  /**
   * FE-T14 — a narrow, explicit, per-schema escape hatch from
   * `FORBIDDEN_EXTRACTION_FIELD_NAMES`, for a field name that is forbidden
   * by DEFAULT (an owner-scoped identifier / PII in the common case) but is
   * a PUBLIC, non-owner-scoped lookup key for THIS specific capability — the
   * same distinction `field-trust.ts`'s State class already draws for
   * `get_also_added`/`get_ordered_together`'s `productId` (a catalog
   * reference the model relays from an earlier read, never an
   * authorization-gating identifier). An author MUST name here, verbatim,
   * every forbidden field name their schema declares — silently exempting
   * everything would defeat the list's purpose; this is a per-field,
   * per-capability, auditable opt-in, never a blanket bypass. Absent
   * (`undefined`) is the overwhelmingly common, correct value — only
   * read-tool-schemas.ts's two catalog-adjacency reads use this today.
   */
  readonly permittedIdentifiers?: readonly string[];
}

/**
 * Identity-class names — resolver-only, model-forbidden. Unlike the
 * safety-critical/PII set below, a name in THIS set MAY be exempted for a
 * specific schema via `CapabilityExtractionSchema.permittedIdentifiers` —
 * some identifiers are owner-scoped for one capability and a public,
 * non-owner-scoped lookup key for another (see `productId`'s two roles:
 * order.review.submit's own reviewed-product reference vs.
 * read-tool-schemas.ts's catalog-adjacency reads).
 */
export const EXEMPTABLE_IDENTIFIER_NAMES: ReadonlySet<string> = new Set([
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
  // FE-T14 — order.review.submit's resolver-filled reviewed-product
  // reference (OrderReviewSubmitPayload.productId). See order-note-
  // review.schema.ts's header: FE-D28 (carved) resolves it from the
  // order's own line items via an NL `item` reference, mirroring the
  // granular amend kinds' itemId pattern. Forbidden by DEFAULT — but see
  // `CapabilityExtractionSchema.permittedIdentifiers` for the narrow,
  // explicit exception read-tool-schemas.ts's `get_also_added`/
  // `get_ordered_together` use (a PUBLIC catalog lookup key, not an
  // owner-scoped identifier — a structurally different role than
  // order.review.submit's own productId).
  "productId",
]);

/**
 * Safety-critical / PII names — never model-synthesized, NEVER exemptable
 * by `permittedIdentifiers` regardless of what an author lists there (see
 * the lint check below: this set is checked SEPARATELY and unconditionally
 * — the exemption mechanism only ever consults `EXEMPTABLE_IDENTIFIER_
 * NAMES`). CLAUDE.md Hard Rule #1 ("Allergens: always explicit array —
 * never infer") and the governance user stories (10-13) admit no
 * capability-specific exception, unlike an Identity-class field's role,
 * which genuinely can differ by capability.
 */
export const NEVER_EXEMPTABLE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "allergens",
  "cpf",
  "email",
  "phone",
  "cardPan",
  "isInternal",
]);

/**
 * Names that must NEVER appear as a field on an authored extraction schema —
 * the union of `EXEMPTABLE_IDENTIFIER_NAMES` and `NEVER_EXEMPTABLE_FIELD_
 * NAMES`. Extend one of those two sets as later slices add capabilities,
 * never this one directly — `assertSoundExtractionSchema` fails closed on
 * any name in this set regardless of the `trustClass` the author declared,
 * honoring `permittedIdentifiers` ONLY for the identity-class half.
 */
export const FORBIDDEN_EXTRACTION_FIELD_NAMES: ReadonlySet<string> = new Set([
  ...EXEMPTABLE_IDENTIFIER_NAMES,
  ...NEVER_EXEMPTABLE_FIELD_NAMES,
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
    if (NEVER_EXEMPTABLE_FIELD_NAMES.has(field.name)) {
      // Checked FIRST, unconditionally — permittedIdentifiers is never even
      // consulted for this set (CLAUDE.md Hard Rule #1 and the PII fields
      // admit no capability-specific exception).
      throw new UnsoundExtractionSchemaError(
        `extraction schema for "${schema.capability}" exposes forbidden ` +
          `field "${field.name}" (safety-critical / PII) to the model — ` +
          `this name is NEVER exemptable, regardless of permittedIdentifiers.`,
      );
    }
    if (
      EXEMPTABLE_IDENTIFIER_NAMES.has(field.name) &&
      !schema.permittedIdentifiers?.includes(field.name)
    ) {
      throw new UnsoundExtractionSchemaError(
        `extraction schema for "${schema.capability}" exposes forbidden ` +
          `field "${field.name}" (identifier) to the model — see ` +
          `FORBIDDEN_EXTRACTION_FIELD_NAMES. If this field is genuinely a ` +
          `public, non-owner-scoped lookup key for THIS capability ` +
          `specifically, name it in this schema's permittedIdentifiers ` +
          `with a comment explaining why.`,
      );
    }
    // FE-T14 rulings — an array field must be a CLOSED set (`items.enum`) or
    // an explicit, deliberate opt-in to open text (`items.freeform: true`).
    // Neither present is treated as an authoring oversight, not a valid
    // "unbounded by default" shape — fails closed the same way an
    // Identity-class or forbidden-name field does.
    if (
      field.jsonSchema.type === "array" &&
      field.jsonSchema.items?.enum === undefined &&
      field.jsonSchema.items?.freeform !== true
    ) {
      throw new UnsoundExtractionSchemaError(
        `extraction schema for "${schema.capability}" declares array field ` +
          `"${field.name}" with neither items.enum (a closed set) nor ` +
          `items.freeform: true (an explicit open-text opt-in) — an array ` +
          `field must declare one or the other, never neither.`,
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
