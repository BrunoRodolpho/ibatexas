// order-status-transition.schema.ts — the FIRST authored extraction schema
// (FE-T05, the first tracer). Wires the BKL-090 kitchen-advance verb
// (`order.status.transition`) through the extraction-schema authoring
// contract: the model sees ONLY `newStatus`; `orderId` is Identity-class
// (resolver-only) and is never listed here, never requested of the model.
//
// Scope of THIS tracer (deliberately narrow — see the ticket): the target
// order is always resolved from context ("meu último pedido" / no explicit
// reference given) — there is no order-reference field on this schema. A
// later rollout slice (T11-14) may add an optional NL order-reference field
// (mirroring the existing BKL-089 `order.note.add` reference-resolution
// idiom) without touching this contract's shape.

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

/**
 * The six real fulfillment statuses `order.status.transition` accepts,
 * VERBATIM English enum values (mirrors the BKL-144 doc-only schema in
 * `ops-tool-registry.ts` and the `OPS_PLANNER_PERSONA` mapping guide — the
 * BKL-090 legality guard reads `payload.newStatus` literally, no pt->en
 * normalization).
 */
export const ORDER_STATUS_TRANSITION_STATUSES = [
  "confirmed",
  "preparing",
  "ready",
  "in_delivery",
  "delivered",
  "canceled",
] as const;

export type OrderStatusTransitionStatus =
  (typeof ORDER_STATUS_TRANSITION_STATUSES)[number];

export const ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.status.transition",
    fields: [
      {
        name: "newStatus",
        // FE-T05 review (MINOR-1) — Directive class per FE-0.3's table
        // ("new status" is listed under Directive, alongside quantity /
        // payment method / note text): user/model-produced content the
        // runtime adjudicates before it can execute, NOT first-party State.
        // The runtime still validates it against the order's REAL current
        // status (the BKL-090 `requireLegalStatusTransition` guard) before
        // it can execute — never trusted outright.
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          enum: [...ORDER_STATUS_TRANSITION_STATUSES],
          description:
            "Status alvo — EXATAMENTE um destes valores em inglês " +
            "(contrato fechado; o guard não normaliza).",
        },
        required: true,
      },
    ],
    example: {
      utterance: "muda o status do meu último pedido para pronto",
      payload: { newStatus: "ready" },
    },
  };

// Fail closed at import time: a schema that would leak orderId (or any other
// identifier / PII field) can never even be loaded onto the wire.
assertSoundExtractionSchema(ORDER_STATUS_TRANSITION_EXTRACTION_SCHEMA);
