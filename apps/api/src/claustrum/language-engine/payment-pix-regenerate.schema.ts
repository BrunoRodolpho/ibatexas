// payment-pix-regenerate.schema.ts — the FE-T11 money-tier extraction schema
// for the customer-plane "pay-pix" family (the sole customer-driven pack-
// payments kind with a registered chat tool — see pack-payments/src/
// capabilities.ts's own module doc: "Of the customer-driven kinds only
// payment.pix.regenerate is LLM-proposable"). Wires the BKL-030-adjacent
// "my PIX code expired, send a new one" verb (`payment.pix.regenerate`)
// through the extraction-schema authoring contract.
//
// ── Zero model-fillable fields — deliberate, not an oversight ───────────────
//
// `RegeneratePixInput` (packages/tools/src/cart/regenerate-pix.ts) is
// `{orderId: string}` — the ENTIRE wire payload is the target order, and
// `orderId` is Identity-class (resolver-only), forbidden on an authored
// extraction schema by construction (FORBIDDEN_EXTRACTION_FIELD_NAMES,
// extraction-schema.ts). Unlike `payment.refund.issue` (an amount + a reason
// the model can genuinely contribute), there is no Directive-class content
// left for the model to produce here: the customer's whole ask ("manda um
// novo pix", "o código expirou, gera outro") IS the capability selection —
// nothing about IT varies per utterance. So this schema's `fields` array is
// deliberately EMPTY.
//
// This still does REAL work on the wire: `toPayloadJsonSchema` turns an
// empty `fields` array into `{type:"object", properties:{},
// additionalProperties:false}` — the model's payload for this capability
// becomes STRUCTURALLY forced to `{}`, closing a live gap. Before this
// schema, `payment.pix.regenerate` fell through to the generic
// `payload:{type:"object"}` shape (wire-schemas.ts's documented fallback for
// any unregistered capability) — unconstrained, so a model that hallucinates
// an `orderId` key gets it threaded straight through
// `resolve-and-assemble.ts`'s `resolveOrderId`, which reads `payload.orderId`
// as an EXPLICIT reference (`autoResolved: false`) and silently SKIPS the
// auto-resolve confirm gate (`confirmOnAutoResolveGuard`,
// compose-policy-packs.ts) that every genuine auto-resolved case forces.
// Closing the wire to `{}` removes the model's only avenue to smuggle that
// field in.
//
// ── The target order — auto-resolve is ALREADY wired, nothing new here ──────
//
// `payment.pix.regenerate` is already a member of BOTH
// `resolve-and-assemble.ts`'s `ORDER_AUTORESOLVE_KINDS` (explicit orderId
// wins; else auto-resolve the customer's most-recent order) and
// `compose-policy-packs.ts`'s `AUTORESOLVE_CONFIRM_KINDS` (an auto-resolved
// target forces `REQUEST_CONFIRMATION`) — this ticket reuses that live
// production wiring exactly as-is, mirroring `order.status.transition`'s own
// "deliberately narrow… no order-reference field" scope note
// (order-status-transition.schema.ts), not `payment.refund.issue`'s explicit-
// reference resolution (there is no ambient "most recent PIX-eligible order"
// distinction the model could usefully disambiguate from a single utterance).

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

export const PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "payment.pix.regenerate",
    fields: [],
    example: {
      utterance: "o código pix expirou, gera outro pra mim",
      payload: {},
    },
  };

// Fail closed at import time: a schema that would leak orderId (or any other
// identifier / PII field) can never even be loaded onto the wire.
assertSoundExtractionSchema(PAYMENT_PIX_REGENERATE_EXTRACTION_SCHEMA);
