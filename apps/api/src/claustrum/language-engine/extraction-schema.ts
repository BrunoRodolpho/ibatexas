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

/** A minimal JSON-Schema fragment for one field's wire shape (draft-07-ish). */
export interface ExtractionFieldJsonSchema {
  readonly type: "string" | "number" | "boolean";
  readonly enum?: readonly string[];
  readonly description: string;
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
 * FE-T11 (review) — a LEGITIMATE non-schema payload channel this
 * capability's RESOLVER accepts directly off the model's raw payload,
 * distinct from and OLDER than the authored extraction-schema mechanism.
 * Declared PER-CAPABILITY here (never a floating global map elsewhere in the
 * planner) so a reviewer sees the exception in the exact same file as the
 * schema it exempts, and so per-field TRUST stays plane-scoped (P2): the
 * identical field name `orderId` is a CUSTOMER-plane hazard (an explicit
 * reference flips `resolveOrderId`'s `autoResolved:false` and skips the
 * forced-confirm gate — the class `payment.pix.regenerate`'s empty schema
 * closes) but an OPS-plane reference-TO-VERIFY (the resolver looks the named
 * order up AUTHORITATIVELY and REFUSES/falls back if it doesn't resolve; the
 * ops confirm ladder still applies afterward) — the two capabilities that
 * declare a channel today (`payment.refund.issue`, `order.status.transition`)
 * are both ops-plane. Whether this `orderId`-as-reference idiom should
 * eventually migrate to a typed reference field is tracked as FE-D23 (an
 * owner-level design decision), not decided here.
 *
 * This is NOT a way to re-admit a forbidden field onto the extraction schema
 * itself: `assertSoundExtractionSchema` still rejects any `schema.fields`
 * entry named in `FORBIDDEN_EXTRACTION_FIELD_NAMES` exactly as before. A
 * channel is a SEPARATE allowance — the lint gate requires its `field` be
 * DISJOINT from `schema.fields`' own names (a channel is never an extraction
 * directive) and its `reason` non-empty (every exception must be justified,
 * never silently added — see `assertSoundExtractionSchema` below). The
 * plan-time filter (`ibatexas-planner.ts`'s `stripUnauthoredPayloadFields`)
 * allows schema-field-names UNION declared-channel-names; strips everything
 * else.
 */
export interface LegacyPayloadChannel {
  /** The raw payload key name the resolver accepts (e.g. `"orderId"`). */
  readonly field: string;
  /** Why this channel exists — REQUIRED, never empty (lint-enforced). */
  readonly reason: string;
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
  /** FE-T11 (review) — see {@link LegacyPayloadChannel}. Optional; absent
   *  (the default for every capability) means no exception exists. */
  readonly legacyPayloadChannels?: readonly LegacyPayloadChannel[];
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
 *
 * FE-T11 (review) also lints `legacyPayloadChannels` (see
 * {@link LegacyPayloadChannel}) — two checks that keep the exception
 * mechanism from becoming a forbidden-field backdoor: every channel's
 * `field` must be DISJOINT from `schema.fields`' own names (a channel is
 * never an extraction directive — the two mechanisms must never overlap
 * on the SAME name for the SAME capability), and every channel's `reason`
 * must be non-empty (an undocumented exception is rejected outright, never
 * silently accepted).
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
  const fieldNames = new Set(schema.fields.map((f) => f.name));
  for (const channel of schema.legacyPayloadChannels ?? []) {
    if (channel.reason.trim().length === 0) {
      throw new UnsoundExtractionSchemaError(
        `extraction schema for "${schema.capability}" declares a ` +
          `legacyPayloadChannel for field "${channel.field}" with an empty ` +
          `reason — every legacy channel must document why it exists (FE-T11).`,
      );
    }
    if (fieldNames.has(channel.field)) {
      throw new UnsoundExtractionSchemaError(
        `extraction schema for "${schema.capability}" declares a ` +
          `legacyPayloadChannel for field "${channel.field}" that COLLIDES ` +
          `with an authored extraction field of the same name — a legacy ` +
          `channel is never an extraction directive (FE-T11).`,
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

/** FE-T11 (review) — the set of field names a capability's declared
 *  {@link LegacyPayloadChannel}s allow (empty for the common case of no
 *  exception). Never overlaps with {@link extractionFieldNames} for a
 *  SOUND schema — `assertSoundExtractionSchema` enforces the disjointness. */
export function legacyChannelFieldNames(
  schema: CapabilityExtractionSchema,
): ReadonlySet<string> {
  return new Set((schema.legacyPayloadChannels ?? []).map((c) => c.field));
}
