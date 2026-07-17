// audit-metadata.ts — the audit-record extension (the decided test seam):
// materialize `ExtractionIR` + `HydratedIntentIR` (with per-field provenance)
// onto the `intent_audit` row via `@adjudicate/core`'s ADR-124 v5 `metadata`
// mechanism, so extraction accuracy and provenance coverage are observable
// DIRECTLY from the audit record rather than inferred from the collapsed
// post-resolution envelope.
//
// Wiring (see `claustrum-bootstrap.ts`'s `safeAuditedAdjudicate`): this pure
// function is passed as `AdjudicateAndAuditDeps.metadataProvider`, a
// SYNCHRONOUS hook `@adjudicate/core` runs "after buildAuditRecord and before
// sink.emit" — i.e. it receives the FINAL, POST-RESOLUTION `AuditRecord`
// (whose `envelope.payload` already carries the hydrated/resolved fields)
// and its return value is merged onto `record.metadata`. `metadata` is
// EXCLUDED from the `auditHash` pre-image (ADR-124), so this attaches
// governance/observability data without ever touching the kernel's
// tamper-evidence or the envelope's hashed shape (FE-0.4's "provenance never
// rides the kernel contract" is upheld: `envelope.payload` itself never
// carries a provenance key — only the SIDECAR `record.metadata` does).
//
// Deliberately narrow: only the capabilities explicitly dispatched below are
// recognized; every other capability returns `undefined` (a no-op —
// `attachAuditMetadata`/`metadataProvider` leave `record.metadata` absent
// when the provider returns undefined), so this is 100% inert for every
// other capability in the system. FE-T05 authored the first (
// order.status.transition); FE-T09 (D-a) added the three granular
// post-checkout amend kinds; FE-T10 added the money-tier slice
// (payment.refund.issue). Later rollout slices (T11-14) extend the
// capability set this function recognizes as their own extraction schemas
// land — the shape (derive ExtractionIR + HydratedIntentIR from the final
// envelope via the capability's `CapabilityExtractionSchema`) generalizes
// directly.

import type { AuditRecord } from "@adjudicate/core";
import {
  modelProvenance,
  resolverAuthoritativeProvenance,
  resolverGroundedProvenance,
} from "./field-trust.js";
import {
  hasGroundedField,
  type ExtractionIR,
  type FieldProvenanceMap,
  type HydratedIntentIR,
} from "./extraction-ir.js";
import {
  extractionFieldNames,
  type CapabilityExtractionSchema,
} from "./extraction-schema.js";
import { ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA } from "./order-status-transition.schema.js";
import {
  ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA,
  ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA,
  ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA,
} from "./order-amend-granular.schema.js";
import {
  OPS_REFUND_DEFAULT_REASON,
  PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA,
} from "./payment-refund-issue.schema.js";
import { PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA } from "./payment-pix-regenerate.schema.js";
import {
  ORDER_CART_ENSURE_EXTRACTION_SCHEMA,
  ORDER_ITEM_ADD_EXTRACTION_SCHEMA,
  ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA,
  ORDER_ITEM_REMOVE_EXTRACTION_SCHEMA,
  ORDER_COUPON_APPLY_EXTRACTION_SCHEMA,
} from "./order-cart-item.schema.js";
import {
  ORDER_NOTE_ADD_EXTRACTION_SCHEMA,
  ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA,
} from "./order-note-review.schema.js";
import {
  RESERVATION_CREATE_EXTRACTION_SCHEMA,
  RESERVATION_MODIFY_EXTRACTION_SCHEMA,
  RESERVATION_CANCEL_EXTRACTION_SCHEMA,
  RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA,
} from "./reservation-convenience.schema.js";
import {
  CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA,
  CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA,
  WHATSAPP_HANDOFF_REQUEST_EXTRACTION_SCHEMA,
} from "./customer-whatsapp-convenience.schema.js";

/** The shape materialized under `record.metadata.languageEngine`. */
export interface LanguageEngineAuditMetadata {
  readonly extractionIR: ExtractionIR;
  readonly hydratedIntentIR: HydratedIntentIR;
}

/**
 * Split a RESOLVED payload back into {extraction fields} (what the schema
 * says the model could have produced) and the REST (everything the resolver
 * added/stamped) — pure, schema-driven. Fields the schema doesn't declare are
 * NOT model output by contract (FE-1.1: the schema lists ONLY what the model
 * can produce), so they are always resolver-owned here.
 */
function splitResolvedPayload(
  schema: CapabilityExtractionSchema,
  resolvedPayload: Readonly<Record<string, unknown>>,
): {
  extractionPayload: Record<string, unknown>;
  resolverFieldNames: readonly string[];
} {
  const modelFieldNames = extractionFieldNames(schema);
  const extractionPayload: Record<string, unknown> = {};
  const resolverFieldNames: string[] = [];
  for (const [key, value] of Object.entries(resolvedPayload)) {
    if (modelFieldNames.has(key)) {
      extractionPayload[key] = value;
    } else {
      resolverFieldNames.push(key);
    }
  }
  return { extractionPayload, resolverFieldNames };
}

/**
 * FE-T05 review (MAJOR-1b) — the ONLY resolver-stamped (Identity-class)
 * field `order.status.transition` hydration ever adds beyond the extraction
 * schema, always from `resolveStatusTransitionOrderTarget`
 * (`ops-resolver.ts`), NEVER from the model. This is an explicit ALLOWLIST,
 * not a blanket pass-through: a stray key an adversarial/malformed model
 * completion smuggled into the resolved payload (json-mode does not enforce
 * `additionalProperties: false`) is DROPPED here, never materialized into
 * `HydratedIntentIR` — the audit-metadata sidecar must not become a second,
 * unfiltered leak surface for whatever the model happened to emit.
 */
const ORDER_STATUS_TRANSITION_RESOLVER_FIELDS: readonly string[] = ["orderId"];

/**
 * Project the resolved payload down to EXACTLY {schema-declared fields} ∪
 * {the capability's explicit resolver-field allowlist} — never a verbatim
 * copy of `resolvedPayload`. Every other key (however it got there) is
 * dropped, silently, before it ever reaches `record.metadata`.
 */
function projectHydratedPayload(
  extractionPayload: Readonly<Record<string, unknown>>,
  resolvedPayload: Readonly<Record<string, unknown>>,
  resolverFieldAllowlist: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extractionPayload };
  for (const key of resolverFieldAllowlist) {
    if (key in resolvedPayload) out[key] = resolvedPayload[key];
  }
  return out;
}

/**
 * order.status.transition-specific derivation (this tracer's one wired
 * capability). The resolved envelope payload is `{orderId, newStatus, ...}`
 * (see `ops-resolver.ts`'s `order.status.transition` branch — `orderId` is
 * ALWAYS resolver-filled under the FE-T05 extraction schema, since the model
 * is never shown an orderId field, and resolution in this tracer's scope is
 * always the grounded "most recent active order" fallback — see
 * `ops-order-resolution.ts`'s `resolveMostRecentActiveOrder`).
 */
function deriveOrderStatusTransition(
  resolvedPayload: Readonly<Record<string, unknown>>,
): LanguageEngineAuditMetadata {
  const schema = ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA;
  const { extractionPayload } = splitResolvedPayload(schema, resolvedPayload);

  const extractionProvenance: Record<string, ReturnType<typeof modelProvenance>> =
    {};
  for (const field of schema.fields) {
    if (field.name in extractionPayload) {
      extractionProvenance[field.name] = modelProvenance();
    }
  }
  const extractionIR: ExtractionIR = {
    capability: schema.capability,
    payload: extractionPayload,
    provenance: extractionProvenance,
  };

  // Hydration: orderId is ALWAYS resolver-filled (grounded/session-derived —
  // this tracer's scope is exactly the "meu último pedido" auto-resolve
  // path, never an explicit reference), newStatus stays model/untrusted.
  const hydratedProvenance: Record<string, FieldProvenanceMap[string]> = {
    ...extractionProvenance,
  };
  if (typeof resolvedPayload.orderId === "string") {
    hydratedProvenance.orderId = resolverGroundedProvenance();
  }
  const hydratedIntentIR: HydratedIntentIR = {
    capability: schema.capability,
    payload: projectHydratedPayload(
      extractionPayload,
      resolvedPayload,
      ORDER_STATUS_TRANSITION_RESOLVER_FIELDS,
    ),
    provenance: hydratedProvenance,
    confirmationRequired: hasGroundedField(hydratedProvenance),
  };

  return { extractionIR, hydratedIntentIR };
}

/**
 * FE-T09 (D-a) — `order.amend.add_item`'s resolver-stamped (Identity-class)
 * fields: `orderId` (auto-resolved "most recent order", same grounded/guess
 * semantics as `order.status.transition`'s) and `variantId` + `allergens`
 * (resolved from the model's explicit NL `item` reference via
 * `resolveProductForItem` — an EXPLICIT-reference resolution, not a guess,
 * hence `authoritative` per FE-0.4's "a resolved identifier from an explicit
 * reference" mapping, not `grounded`).
 */
const ORDER_AMEND_ADD_ITEM_RESOLVER_FIELDS: readonly string[] = [
  "orderId",
  "variantId",
  "allergens",
];

/** `order.amend.update_qty` / `order.amend.remove_item` share the same
 *  resolver-stamped fields: `orderId` (grounded) + `itemId` (authoritative —
 *  resolved from the model's explicit NL `item` reference). */
const ORDER_AMEND_UPDATE_QTY_RESOLVER_FIELDS: readonly string[] = ["orderId", "itemId"];
const ORDER_AMEND_REMOVE_ITEM_RESOLVER_FIELDS: readonly string[] = ["orderId", "itemId"];

/**
 * Shared derivation shape, originally authored for the three granular amend
 * kinds (FE-T09) and reused as-is by FE-T14's cart/item family (the logic is
 * fully capability-agnostic — a schema + a resolver-field allowlist + which
 * of those fields are `authoritative`) — mirrors `deriveOrderStatusTransition`'s
 * structure exactly, parameterized by the capability's schema, its
 * resolver-field allowlist, and which of those resolver fields get
 * `authoritative` provenance (an explicit-reference/deterministic
 * resolution) vs. the default `grounded` (an auto-resolved guess).
 */
function deriveGranularAmend(
  schema: CapabilityExtractionSchema,
  resolverFieldAllowlist: readonly string[],
  authoritativeResolverFields: ReadonlySet<string>,
  resolvedPayload: Readonly<Record<string, unknown>>,
): LanguageEngineAuditMetadata {
  const { extractionPayload } = splitResolvedPayload(schema, resolvedPayload);

  const extractionProvenance: Record<string, ReturnType<typeof modelProvenance>> =
    {};
  for (const field of schema.fields) {
    if (field.name in extractionPayload) {
      extractionProvenance[field.name] = modelProvenance();
    }
  }
  const extractionIR: ExtractionIR = {
    capability: schema.capability,
    payload: extractionPayload,
    provenance: extractionProvenance,
  };

  const hydratedProvenance: Record<string, FieldProvenanceMap[string]> = {
    ...extractionProvenance,
  };
  for (const key of resolverFieldAllowlist) {
    if (!(key in resolvedPayload)) continue;
    hydratedProvenance[key] = authoritativeResolverFields.has(key)
      ? resolverAuthoritativeProvenance()
      : resolverGroundedProvenance();
  }
  const hydratedIntentIR: HydratedIntentIR = {
    capability: schema.capability,
    payload: projectHydratedPayload(
      extractionPayload,
      resolvedPayload,
      resolverFieldAllowlist,
    ),
    provenance: hydratedProvenance,
    confirmationRequired: hasGroundedField(hydratedProvenance),
  };

  return { extractionIR, hydratedIntentIR };
}

/**
 * FE-T10 — the money-tier resolver-stamped fields `payment.refund.issue`
 * hydration adds beyond the extraction schema (STOP-GATE B,
 * `ops-resolver.ts`'s `resolveRefundTarget`): `paymentId` + the three
 * balance-snapshot fields, ALWAYS stamped from the live DB payment row,
 * NEVER from the model. `reason` is included too — NOT because it is
 * resolver-owned in general (it usually is model content), but so its
 * RESOLVER-DEFAULTED value (see `reasonIsResolverDefault` above) still
 * appears in the hydrated payload after being deliberately stripped from
 * `extractionPayload`; when `reason` IS genuine model content the spread in
 * `projectHydratedPayload` below re-derives the identical value from
 * `resolvedPayload`, a no-op overwrite. An explicit allowlist, exactly like
 * `ORDER_STATUS_TRANSITION_RESOLVER_FIELDS` — a stray key an
 * adversarial/malformed completion smuggled in is dropped here, never
 * materialized into `HydratedIntentIR`.
 *
 * `orderId` is listed defensively/forward-compatibly: verified live (FE-T10
 * calibration, psql against `intent_audit.envelope_jsonb`) that
 * `resolveRefundTarget`'s `stampedPayload` (ops-resolver.ts) NEVER actually
 * includes `orderId` today — the resolved order id is threaded only into the
 * kernel's `state.ctx.orderId`, never the audited envelope payload. Keeping
 * the entry costs nothing (an absent key is simply never copied by
 * `projectHydratedPayload`) and means a future resolver change that DOES
 * start stamping `orderId` onto the wire payload is picked up here for free,
 * without a corresponding code change. The `hydratedProvenance.orderId`
 * branch below is the same story: dead code today, not exercised by any
 * live case in this ticket's corpus, kept for that same forward-compat reason.
 */
const PAYMENT_REFUND_ISSUE_RESOLVER_FIELDS: readonly string[] = [
  "orderId",
  "paymentId",
  "refundableBalanceCentavos",
  "amountInCentavos",
  "currentRefundedCentavos",
  "reason",
];

/**
 * payment.refund.issue-specific derivation (FE-T10, the money-tier slice).
 * Unlike `order.status.transition`'s ALWAYS-grounded "most recent order"
 * auto-resolve, the refund order reference is resolved from an EXPLICIT
 * model-supplied reference (a display number or customer name —
 * `resolveOrderByReference`, BKL-089) — an authoritative resolution, not a
 * guess (field-trust.ts's own distinction: "a resolved identifier from an
 * explicit reference -> authoritative"). So `hasGroundedField` alone would
 * (correctly) read `confirmationRequired: false` here — hydration itself
 * made no guess. The turn STILL always confirms for a SEPARATE, already-
 * proven reason: the BKL-085 UNTRUSTED-taint refund CONFIRM overlay
 * (pack-payments/src/policies.ts), a kernel-level policy independent of
 * hydration's own grounded-guess reasoning. `record.decision.kind` is read
 * directly (this function receives the full `AuditRecord`, unlike
 * `deriveOrderStatusTransition`/`deriveGranularAmend`) so
 * `confirmationRequired` stays an HONEST union of BOTH sources — never
 * overloading `hasGroundedField`'s documented "auto-resolved guess" meaning,
 * which the other derivations still rely on unchanged.
 */
function derivePaymentRefundIssue(record: AuditRecord): LanguageEngineAuditMetadata {
  const resolvedPayload = record.envelope.payload as Readonly<
    Record<string, unknown>
  >;
  const schema = PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA;
  const { extractionPayload } = splitResolvedPayload(schema, resolvedPayload);

  const extractionProvenance: Record<string, ReturnType<typeof modelProvenance>> =
    {};
  for (const field of schema.fields) {
    if (field.name in extractionPayload) {
      extractionProvenance[field.name] = modelProvenance();
    }
  }

  // FE-T10 review — `reason` is OPTIONAL on the schema, and the resolver
  // applies ITS OWN default (`OPS_REFUND_DEFAULT_REASON`, ops-resolver.ts)
  // when the model supplied none — under the SAME wire key, so mere
  // PRESENCE cannot distinguish "the model said this" from "the resolver
  // defaulted it" the way a RENAMED field (orderReference->orderId,
  // amount->refundAmountCentavos) unambiguously can. Recognize the exact
  // default string and reclassify it: NOT model extraction (dropped from
  // extractionIR entirely — the model produced nothing here); a genuinely
  // RESOLVER-supplied value in the hydrated intent instead (see below).
  let reasonIsResolverDefault = false;
  if (extractionPayload.reason === OPS_REFUND_DEFAULT_REASON) {
    delete extractionPayload.reason;
    delete extractionProvenance.reason;
    reasonIsResolverDefault = true;
  }

  // FE-T10 review — the schema's `amount` (reais) is REWRITTEN to the wire's
  // `refundAmountCentavos` (BKL-094 coercion, ops-resolver.ts) BEFORE this
  // function ever sees the payload, so `splitResolvedPayload` (which only
  // matches SCHEMA-declared names) can never surface it — without this, "the
  // amount extracted correctly" would be UNASSERTABLE by any corpus case
  // (neither IR would ever carry the resolved cents value). The rewritten
  // value is still fundamentally the model's Directive content — the
  // resolver only changed its UNIT REPRESENTATION (reais -> exact centavos),
  // never its authorship — so it keeps `modelProvenance()` (untrusted),
  // exactly like the schema's OWN `amount`/`reason` fields, NOT
  // `resolverAuthoritativeProvenance()` (which is reserved for a genuine
  // reference LOOKUP, e.g. `orderId` below). Present in BOTH IRs under its
  // WIRE name (`refundAmountCentavos`) — the one name every consumer
  // (policies.ts's magnitude ladder, a corpus author) actually reads.
  if (
    typeof resolvedPayload.refundAmountCentavos === "number" &&
    Number.isFinite(resolvedPayload.refundAmountCentavos)
  ) {
    extractionPayload.refundAmountCentavos = resolvedPayload.refundAmountCentavos;
    extractionProvenance.refundAmountCentavos = modelProvenance();
  }

  const extractionIR: ExtractionIR = {
    capability: schema.capability,
    payload: extractionPayload,
    provenance: extractionProvenance,
  };

  const hydratedProvenance: Record<string, FieldProvenanceMap[string]> = {
    ...extractionProvenance,
  };
  if (typeof resolvedPayload.orderId === "string") {
    // DEAD CODE TODAY (verified live, FE-T10): `resolveRefundTarget`'s
    // `stampedPayload` never actually carries `orderId` — see the doc
    // comment on `PAYMENT_REFUND_ISSUE_RESOLVER_FIELDS` above. Kept as
    // defensive/forward-compatible handling for the day the resolver does
    // stamp it — explicit reference resolution (BKL-089), never a "most
    // recent order" guess, hence `authoritative` and not `grounded`.
    hydratedProvenance.orderId = resolverAuthoritativeProvenance();
  }
  if (reasonIsResolverDefault) {
    // A deterministic, fully-confident system default — not a guess (never
    // `grounded`), and not model content (already excluded from
    // extractionIR above).
    hydratedProvenance.reason = resolverAuthoritativeProvenance();
  }
  const hydratedIntentIR: HydratedIntentIR = {
    capability: schema.capability,
    payload: projectHydratedPayload(
      extractionPayload,
      resolvedPayload,
      PAYMENT_REFUND_ISSUE_RESOLVER_FIELDS,
    ),
    provenance: hydratedProvenance,
    confirmationRequired:
      hasGroundedField(hydratedProvenance) ||
      record.decision.kind === "REQUEST_CONFIRMATION" ||
      record.decision.kind === "ESCALATE",
  };

  return { extractionIR, hydratedIntentIR };
}

/**
 * FE-T11 — `payment.pix.regenerate`'s ONLY resolver-stamped field: `orderId`,
 * ALWAYS auto-resolved to the customer's most-recent order
 * (`resolve-and-assemble.ts`'s `ORDER_AUTORESOLVE_KINDS` /
 * `resolveOrderId`) — never from the model (the extraction schema declares
 * zero fields; see `payment-pix-regenerate.schema.ts`'s header). Same
 * "auto-resolved guess" semantics as `order.status.transition`'s own
 * `orderId` (never `authoritative` — there is no explicit-reference
 * resolution path for this capability, only the auto-resolve fallback), so
 * this reuses `deriveGranularAmend`'s already-generalized shape with an
 * EMPTY `authoritativeResolverFields` set, exactly like
 * `deriveOrderStatusTransition` would if it too were expressed against the
 * shared helper.
 */
const PAYMENT_PIX_REGENERATE_RESOLVER_FIELDS: readonly string[] = ["orderId"];

/**
 * FE-T14 — the pack-orders cart/item family's resolver-stamped fields.
 * Unlike order.status.transition/the granular amend kinds, NONE of these
 * five are an auto-resolved "most recent X" GUESS: `cartId` is deterministic
 * session resolution (BKL-028, exactly one active cart per session, never
 * ambiguous), and `variantId`/`itemId` are resolved from the model's
 * EXPLICIT NL `item` reference (BKL-061 / FE-T14's `resolveCartLineItem`) —
 * the same "authoritative, not grounded" reasoning FE-T09 already
 * established for the granular amend kinds' own variantId/itemId. None of
 * these five kinds are in AUTORESOLVE_CONFIRM_KINDS (compose-policy-packs.ts)
 * for exactly this reason, so `confirmationRequired` is correctly always
 * `false` here (`hasGroundedField` finds nothing tagged `grounded`).
 */
const ORDER_CART_ENSURE_RESOLVER_FIELDS: readonly string[] = ["cartId"];
const ORDER_ITEM_ADD_RESOLVER_FIELDS: readonly string[] = ["cartId", "variantId", "allergens"];
const ORDER_ITEM_UPDATE_RESOLVER_FIELDS: readonly string[] = ["cartId", "itemId"];
const ORDER_ITEM_REMOVE_RESOLVER_FIELDS: readonly string[] = ["cartId", "itemId"];
const ORDER_COUPON_APPLY_RESOLVER_FIELDS: readonly string[] = ["cartId"];

/**
 * FE-T14 — order.note.add's resolver-stamped field. Unlike the cart/item
 * family, `orderId` here IS an auto-resolved "most recent order" GUESS
 * (ORDER_AUTORESOLVE_KINDS, resolve-and-assemble.ts already lists
 * order.note.add, alongside AUTORESOLVE_CONFIRM_KINDS,
 * compose-policy-packs.ts) — same `grounded` posture as
 * order.status.transition's own orderId, not `authoritative`.
 */
const ORDER_NOTE_ADD_RESOLVER_FIELDS: readonly string[] = ["orderId"];

/**
 * FE-T14 — order.review.submit's resolver-stamped fields. UNLIKE every
 * other kind in this rollout slice, there is no chat-reachable resolution
 * path for either identifier today (see order-note-review.schema.ts's
 * header) — `orderId`/`productId` are supplied directly by whichever
 * caller built the envelope (today: the web review flow), never guessed,
 * so both are `authoritative`, never `grounded`, if/when they appear in a
 * resolved payload. This derivation is schema-driven and channel-agnostic
 * — it materializes useful ExtractionIR/HydratedIntentIR observability for
 * an order.review.submit audit record regardless of which caller produced
 * it, without requiring a new chat-side resolver.
 */
const ORDER_REVIEW_SUBMIT_RESOLVER_FIELDS: readonly string[] = ["orderId", "productId"];

/**
 * FE-T14 — the pack-reservations family's resolver-stamped fields.
 * reservation.create/waitlist.join have NONE (a brand-new resource, no
 * existing target to resolve — hydratedIntentIR is byte-identical to
 * extractionIR for these two). reservation.modify/cancel both auto-resolve
 * `reservationId` (RESERVATION_AUTORESOLVE_KINDS, resolve-and-assemble.ts)
 * — a GUESS, hence `grounded`, never `authoritative`, same posture as
 * order.status.transition's own orderId.
 */
const RESERVATION_MODIFY_RESOLVER_FIELDS: readonly string[] = ["reservationId"];
const RESERVATION_CANCEL_RESOLVER_FIELDS: readonly string[] = ["reservationId"];

/**
 * FE-T14 — customer.preferences.update's resolver-stamped field.
 * `allergenExclusions` is ALWAYS resolver-preserved-from-current
 * (resolve-and-assemble.ts's dedicated FE-T14 block) — a deterministic
 * lookup of the customer's OWN saved row, never a guess among several
 * candidates, hence `authoritative`, never `grounded`.
 */
const CUSTOMER_PREFERENCES_UPDATE_RESOLVER_FIELDS: readonly string[] = ["allergenExclusions"];

/**
 * The `AdjudicateAndAuditDeps.metadataProvider` implementation: given the
 * FINAL, post-resolution `AuditRecord`, return the `{languageEngine: {...}}`
 * metadata to merge onto `record.metadata`, or `undefined` for every
 * capability this tracer does not (yet) recognize.
 */
export function buildLanguageEngineAuditMetadata(
  record: AuditRecord,
): Readonly<Record<string, unknown>> | undefined {
  const payload = record.envelope.payload as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (payload === undefined) return undefined;

  if (record.envelope.kind === "order.status.transition") {
    return { languageEngine: deriveOrderStatusTransition(payload) };
  }
  if (record.envelope.kind === "order.amend.add_item") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA,
        ORDER_AMEND_ADD_ITEM_RESOLVER_FIELDS,
        new Set(["variantId", "allergens"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "order.amend.update_qty") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA,
        ORDER_AMEND_UPDATE_QTY_RESOLVER_FIELDS,
        new Set(["itemId"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "order.amend.remove_item") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA,
        ORDER_AMEND_REMOVE_ITEM_RESOLVER_FIELDS,
        new Set(["itemId"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "payment.refund.issue") {
    return { languageEngine: derivePaymentRefundIssue(record) };
  }
  if (record.envelope.kind === "payment.pix.regenerate") {
    return {
      languageEngine: deriveGranularAmend(
        PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA,
        PAYMENT_PIX_REGENERATE_RESOLVER_FIELDS,
        new Set(), // orderId is always a GROUNDED auto-resolve guess, never authoritative.
        payload,
      ),
    };
  }
  if (record.envelope.kind === "order.cart.ensure") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_CART_ENSURE_EXTRACTION_SCHEMA,
        ORDER_CART_ENSURE_RESOLVER_FIELDS,
        new Set(["cartId"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "order.item.add") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_ITEM_ADD_EXTRACTION_SCHEMA,
        ORDER_ITEM_ADD_RESOLVER_FIELDS,
        new Set(["cartId", "variantId", "allergens"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "order.item.update") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA,
        ORDER_ITEM_UPDATE_RESOLVER_FIELDS,
        new Set(["cartId", "itemId"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "order.item.remove") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_ITEM_REMOVE_EXTRACTION_SCHEMA,
        ORDER_ITEM_REMOVE_RESOLVER_FIELDS,
        new Set(["cartId", "itemId"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "order.coupon.apply") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_COUPON_APPLY_EXTRACTION_SCHEMA,
        ORDER_COUPON_APPLY_RESOLVER_FIELDS,
        new Set(["cartId"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "order.note.add") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_NOTE_ADD_EXTRACTION_SCHEMA,
        ORDER_NOTE_ADD_RESOLVER_FIELDS,
        new Set(), // orderId is grounded (an auto-resolved guess), never authoritative.
        payload,
      ),
    };
  }
  if (record.envelope.kind === "order.review.submit") {
    return {
      languageEngine: deriveGranularAmend(
        ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA,
        ORDER_REVIEW_SUBMIT_RESOLVER_FIELDS,
        new Set(["orderId", "productId"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "reservation.create") {
    return {
      languageEngine: deriveGranularAmend(
        RESERVATION_CREATE_EXTRACTION_SCHEMA,
        [],
        new Set(),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "reservation.modify") {
    return {
      languageEngine: deriveGranularAmend(
        RESERVATION_MODIFY_EXTRACTION_SCHEMA,
        RESERVATION_MODIFY_RESOLVER_FIELDS,
        new Set(), // reservationId is grounded (an auto-resolved guess), never authoritative.
        payload,
      ),
    };
  }
  if (record.envelope.kind === "reservation.cancel") {
    return {
      languageEngine: deriveGranularAmend(
        RESERVATION_CANCEL_EXTRACTION_SCHEMA,
        RESERVATION_CANCEL_RESOLVER_FIELDS,
        new Set(), // reservationId is grounded (an auto-resolved guess), never authoritative.
        payload,
      ),
    };
  }
  if (record.envelope.kind === "reservation.waitlist.join") {
    return {
      languageEngine: deriveGranularAmend(
        RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA,
        [],
        new Set(),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "customer.preferences.update") {
    return {
      languageEngine: deriveGranularAmend(
        CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA,
        CUSTOMER_PREFERENCES_UPDATE_RESOLVER_FIELDS,
        new Set(["allergenExclusions"]),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "customer.pix.details.save") {
    return {
      languageEngine: deriveGranularAmend(
        CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA,
        [],
        new Set(),
        payload,
      ),
    };
  }
  if (record.envelope.kind === "whatsapp.handoff.request") {
    return {
      languageEngine: deriveGranularAmend(
        WHATSAPP_HANDOFF_REQUEST_EXTRACTION_SCHEMA,
        [],
        new Set(),
        payload,
      ),
    };
  }
  return undefined;
}
