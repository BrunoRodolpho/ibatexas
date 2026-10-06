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

/**
 * A concrete worked example pairing an utterance with its expected payload.
 *
 * AUTHOR-FACING ONLY — this never reaches the model. {@link toPayloadJsonSchema}
 * is the sole schema→wire converter and it builds the advertised object from
 * `schema.fields` alone; `example` is not read on any production path (F-65
 * measured it: the only reads repo-wide are in `__tests__`, and rendering the
 * wire schema for reservation.create/modify and check_availability contains
 * none of their example literals). It documents intent for the next author and
 * gives the per-schema unit tests something to pin.
 *
 * Two consequences worth keeping straight:
 *  - A DATE in an `example` cannot bias extraction — it is not in the prompt.
 *    Do not "fix" a stale one; it is illustrative by construction.
 *  - A field `description` is the opposite: it IS copied onto the wire, so a
 *    date there is live prompt text AND a digested parse-cache key component.
 */
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
   *
   * DISTINCT from `legacyPayloadChannels` below (FE-T11): this exempts a
   * FORBIDDEN NAME from `FORBIDDEN_EXTRACTION_FIELD_NAMES` so it may appear
   * as a genuine `schema.fields` entry (a model-facing extraction field);
   * `legacyPayloadChannels` instead allows an UNAUTHORED raw payload key
   * through the plan-time filter without ever being a schema field at all.
   * The two mechanisms are orthogonal and may both be absent, one present,
   * or (in principle) both present on the same schema.
   */
  readonly permittedIdentifiers?: readonly string[];
  /** FE-T11 (review) — see {@link LegacyPayloadChannel}. Optional; absent
   *  (the default for every capability) means no exception exists. */
  readonly legacyPayloadChannels?: readonly LegacyPayloadChannel[];
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

/**
 * FE-D21 (the aliasing-heuristic arm) — `NEVER_EXEMPTABLE_FIELD_NAMES` is an
 * EXACT-name set, so an author (or a future auto-generated schema) could dodge
 * it by ALIASING the same safety-critical concept under a different name:
 * `emailAddress`, `customerEmail`, `cpfNumber`, `customerCpf`, `cpf_digits`,
 * `phoneNumber`, `allergenInfo`, `cardPanLast4` all name a NEVER_EXEMPTABLE
 * concept but slip past an exact-match. This closes that gap for the
 * safety-critical / PII half via a normalized SUBSTRING match against the
 * morphological STEM of each never-exemptable name.
 *
 * Scope is deliberate — the aliasing heuristic covers the NEVER_EXEMPTABLE set
 * ONLY, never `EXEMPTABLE_IDENTIFIER_NAMES`. Identifier names are already
 * exemptable per-capability (`permittedIdentifiers`), and their stems are
 * id-shaped: a substring rule over them would false-positive on legitimate
 * fields (`timeSlotId`/`newTimeSlotId` both embed `id`) while adding no safety
 * value (an aliased identifier leaks a reference, never PII, and the resolver
 * trust model already governs references). PII/safety concepts, by contrast,
 * must NEVER reach the model under ANY spelling.
 *
 * Stems are MORPHOLOGICAL roots of the real list, not SEMANTIC synonyms:
 * `emailAddress` (contains `email`) is caught; a pt-BR synonym like `telefone`
 * or `nome` (shares no substring with `phone`/`name`) is NOT — semantic-
 * synonym coverage is unbounded and false-positive-prone, so it stays a
 * reviewer-vigilance concern (the standing T11-14 review instruction to flag
 * near-alias field names), not a lint rule with an ever-growing hand-list.
 * The `pii-alias-stems cover every NEVER_EXEMPTABLE name` self-test pins the
 * 1:1 coverage, so adding a never-exemptable name without a matching stem
 * fails the build.
 */
export const PII_ALIAS_STEMS: readonly string[] = [
  "allergen", // allergens  (singular stem → allergens, allergenInfo, ...)
  "cpf", // cpf        → cpfNumber, customerCpf, cpf_digits, ...
  "email", // email      → emailAddress, customerEmail, ...
  "phone", // phone      → phoneNumber, customerPhone, ...
  "cardpan", // cardPan    → cardPanLast4, card_pan, ...  (kept whole: bare
  //                        `pan` would false-positive on panela/expand/...)
  "internal", // isInternal → internalOnly, isInternalNote, markInternal, ...
];

/**
 * FE-D21 — the narrow, centralized escape hatch for the aliasing heuristic: a
 * NORMALIZED field name that embeds a stem only COINCIDENTALLY (the token is
 * not the PII/safety concept). Currently empty — no authored schema field
 * trips the heuristic. An entry here MUST carry a comment justifying why the
 * token is a false positive, and must NEVER be used to re-admit a genuine
 * alias of a NEVER_EXEMPTABLE field (that is what the exact, unconditional
 * NEVER_EXEMPTABLE check upstream guarantees can never happen for the exact
 * names). Centralized (not per-schema) because a coincidental collision is a
 * property of the token, not the capability, and one auditable list is the
 * single place a security review sweeps.
 */
export const PII_ALIAS_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // (intentionally empty)
]);

/** Normalize a field name for the aliasing heuristic: lowercase and strip
 *  every non-alphanumeric char, so `cpf_digits`, `card-pan` and `CardPan`
 *  all collapse onto the same comparable token (`cpfdigits` / `cardpan`). */
export function normalizeExtractionFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * FE-D21 — the PII/safety stem a field name embeds (i.e. the name reads as an
 * alias of a NEVER_EXEMPTABLE field), or `undefined` if it is clean. Honors
 * {@link PII_ALIAS_ALLOWLIST} (a coincidental-collision escape). The
 * `allowlist` param defaults to the module allowlist and exists so the escape
 * path is unit-testable without a live allowlist entry.
 */
export function forbiddenPiiAliasStem(
  name: string,
  allowlist: ReadonlySet<string> = PII_ALIAS_ALLOWLIST,
): string | undefined {
  const normalized = normalizeExtractionFieldName(name);
  if (allowlist.has(normalized)) return undefined;
  return PII_ALIAS_STEMS.find((stem) => normalized.includes(stem));
}

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
    // FE-D21 — aliasing hardening: a name that EMBEDS a NEVER_EXEMPTABLE stem
    // (emailAddress→email, customerCpf→cpf, allergenInfo→allergen, ...) is an
    // alias of a safety-critical/PII concept and is rejected the same way the
    // exact name is. Checked AFTER the exact NEVER_EXEMPTABLE/identifier
    // checks above so an exact forbidden name still reports via its own
    // (clearer, unconditional) message; this catches only the aliases those
    // exact checks miss. Never consulted for the identifier half (see
    // PII_ALIAS_STEMS' doc for why identifiers are out of scope).
    const aliasStem = forbiddenPiiAliasStem(field.name);
    if (aliasStem !== undefined) {
      throw new UnsoundExtractionSchemaError(
        `extraction schema for "${schema.capability}" exposes field ` +
          `"${field.name}" whose normalized name embeds the forbidden ` +
          `PII/safety stem "${aliasStem}" (FE-D21 alias hardening) — this ` +
          `reads as an alias of a NEVER_EXEMPTABLE field (e.g. ` +
          `emailAddress→email, customerCpf→cpf, cpf_digits→cpf, ` +
          `allergenInfo→allergen). Rename the field so it does not embed a ` +
          `PII/safety concept. A genuine COINCIDENTAL collision (the token is ` +
          `not the concept) may be added to PII_ALIAS_ALLOWLIST with a ` +
          `justifying comment — never use it to re-admit a real alias.`,
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
