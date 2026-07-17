// wire-schemas.ts — the per-capability extraction schema -> `express_intent`
// wire registry (FE-1.1 / FE-1.4). Consumed by `ibatexas-planner.ts`'s
// `buildToolSurface`: when a turn's allowed-intent set contains a capability
// registered here, the model sees that capability's real, narrowed `payload`
// sub-schema instead of the generic `{type:"object"}` shape — the concrete
// fix for "the model sees one mutation verb whose payload is an untyped,
// empty-shaped object" (spec Problem Statement #1).
//
// FE-T05 authored the first entry (order.status.transition); FE-T09 (D-a,
// the amend inversion) adds the three granular post-checkout amend kinds;
// FE-T10 adds the money-tier slice (payment.refund.issue); FE-T11 adds the
// customer-plane "pay-pix" money-tier slice (payment.pix.regenerate); FE-T14
// adds the remaining convenience mutating verbs (cart/item, note/review,
// reservations, customer/whatsapp). Purely additive: a capability NOT in
// this map keeps today's generic `payload` shape, byte-identical.
//
// `AUTHORED_SCHEMAS` is exported so the schema-lint CI gate
// (`__tests__/schema-lint-gate.test.ts`, FE-T10) can walk EVERY registered
// schema generically — a future capability added here is automatically
// covered by that gate without any edit to the gate itself.

import {
  toPayloadJsonSchema,
  extractionFieldNames,
  legacyChannelFieldNames,
  type CapabilityExtractionSchema,
} from "./extraction-schema.js";
import { ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA } from "./order-status-transition.schema.js";
import {
  ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA,
  ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA,
  ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA,
} from "./order-amend-granular.schema.js";
import { PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA } from "./payment-refund-issue.schema.js";
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

/** Every capability's authored extraction schema — the schema-lint gate's
 *  walk target (FE-T10). */
export const AUTHORED_SCHEMAS: readonly CapabilityExtractionSchema[] = [
  ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA,
  ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA,
  ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA,
  ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA,
  PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA,
  // FE-T11 — customer-plane pay-pix money-tier slice.
  PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA,
  // FE-T14 — pack-orders cart/item family.
  ORDER_CART_ENSURE_EXTRACTION_SCHEMA,
  ORDER_ITEM_ADD_EXTRACTION_SCHEMA,
  ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA,
  ORDER_ITEM_REMOVE_EXTRACTION_SCHEMA,
  ORDER_COUPON_APPLY_EXTRACTION_SCHEMA,
  // FE-T14 — pack-orders free-text family.
  ORDER_NOTE_ADD_EXTRACTION_SCHEMA,
  ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA,
  // FE-T14 — pack-reservations family.
  RESERVATION_CREATE_EXTRACTION_SCHEMA,
  RESERVATION_MODIFY_EXTRACTION_SCHEMA,
  RESERVATION_CANCEL_EXTRACTION_SCHEMA,
  RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA,
  // FE-T14 — pack-customer-onboarding + pack-whatsapp family.
  CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA,
  CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA,
  WHATSAPP_HANDOFF_REQUEST_EXTRACTION_SCHEMA,
];

/** capability -> its wire `payload` JSON-Schema (pre-built, asserted sound). */
export const EXTRACTION_SCHEMAS_BY_CAPABILITY: ReadonlyMap<
  string,
  Record<string, unknown>
> = new Map(
  AUTHORED_SCHEMAS.map((schema) => [schema.capability, toPayloadJsonSchema(schema)]),
);

/**
 * FE-T11 (review) — capability -> the FULL set of payload key names the
 * plan-time filter allows through (`ibatexas-planner.ts`'s
 * `stripUnauthoredPayloadFields`): the schema's own extraction field names
 * UNION any declared `legacyPayloadChannels` (the two known ops-plane
 * explicit-reference exceptions — `payment.refund.issue` / `order.status.
 * transition`'s `orderId`; see each schema's own doc). This is the single
 * source of truth the filter reads — a schema author who adds a channel
 * here (in the schema file) is automatically covered, no filter edit needed.
 */
export const ALLOWED_PAYLOAD_FIELD_NAMES_BY_CAPABILITY: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map(
  AUTHORED_SCHEMAS.map((schema) => [
    schema.capability,
    new Set([...extractionFieldNames(schema), ...legacyChannelFieldNames(schema)]),
  ]),
);
