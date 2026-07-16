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
// FE-T10 adds the money-tier slice (payment.refund.issue). FE-T12 (the
// orders governance-tier rollout) adds the two CUSTOMER-plane entries below
// (order.checkout.create, order.cancel). Later rollout slices (T13-14) add
// their capability's schema here as each is authored. Purely additive: a
// capability NOT in this map keeps today's generic `payload` shape,
// byte-identical.
//
// `AUTHORED_SCHEMAS` is exported so the schema-lint CI gate
// (`__tests__/schema-lint-gate.test.ts`, FE-T10) can walk EVERY registered
// schema generically — a future capability added here is automatically
// covered by that gate without any edit to the gate itself.

import {
  toPayloadJsonSchema,
  type CapabilityExtractionSchema,
} from "./extraction-schema.js";
import { ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA } from "./order-status-transition.schema.js";
import {
  ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA,
  ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA,
  ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA,
} from "./order-amend-granular.schema.js";
import { PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA } from "./payment-refund-issue.schema.js";
import { ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA } from "./order-checkout-create.schema.js";
import { ORDER_CANCEL_EXTRACTION_SCHEMA } from "./order-cancel.schema.js";

/** Every capability's authored extraction schema — the schema-lint gate's
 *  walk target (FE-T10). */
export const AUTHORED_SCHEMAS: readonly CapabilityExtractionSchema[] = [
  ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA,
  ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA,
  ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA,
  ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA,
  PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA,
  ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA,
  ORDER_CANCEL_EXTRACTION_SCHEMA,
];

/** capability -> its wire `payload` JSON-Schema (pre-built, asserted sound). */
export const EXTRACTION_SCHEMAS_BY_CAPABILITY: ReadonlyMap<
  string,
  Record<string, unknown>
> = new Map(
  AUTHORED_SCHEMAS.map((schema) => [schema.capability, toPayloadJsonSchema(schema)]),
);
