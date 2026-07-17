// order-cancel.schema.ts — FE-T12 (the orders governance-tier rollout).
// Wires `order.cancel` through the extraction-schema authoring contract:
// the model sees ONLY the optional `reason`; `orderId` is Identity-class
// (resolver-only) and is never listed here, never requested of the model.
//
// Scope of THIS schema (deliberately narrow, mirroring FE-T05's own scope
// choice for order.status.transition): NO order-reference field. `order.cancel`
// is already in BOTH `ORDER_AUTORESOLVE_KINDS` and `AUTORESOLVE_CONFIRM_KINDS`
// (apps/api/src/claustrum/resolve-and-assemble.ts /
// compose-policy-packs.ts) — the customer-plane resolver accepts an explicit
// `payload.orderId` (a FORBIDDEN extraction-schema field name, never
// model-fillable) or auto-resolves the customer's most-recent order and
// FORCES a REQUEST_CONFIRMATION, already wired end-to-end (proven live,
// D-014 — see the `cancel-confirm-gate` scripted-pipeline fixture). There is
// no BKL-089-style NL-reference→id resolver on the customer plane (that
// idiom is ops-resolver.ts, staff-only) to hang an `orderReference` field
// on; adding one here would risk exactly the "second confirmation path"
// hazard the existing auto-resolve+confirm machinery already closes. This
// schema therefore rides that machinery completely unchanged.

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

export const ORDER_CANCEL_EXTRACTION_SCHEMA: CapabilityExtractionSchema = {
  capability: "order.cancel",
  fields: [
    {
      name: "reason",
      // Directive, optional, free text — purely descriptive/audit content.
      // Confirmed NEITHER `gatePaidCancel` NOR `escalateLargeCancel`
      // (pack-orders/src/policies.ts) key off `reason`; both key off the
      // order's paid/total amount, so this field carries no gating weight.
      trustClass: "directive",
      jsonSchema: {
        type: "string",
        description:
          "Motivo do cancelamento, se mencionado (ex.: 'mudei de ideia', " +
          "'pedido errado'). Omita se não houver motivo explícito.",
      },
      required: false,
    },
  ],
  example: {
    utterance: "cancela meu pedido, por favor, mudei de ideia",
    payload: { reason: "mudei de ideia" },
  },
};

// Fail closed at import time: a schema that would leak orderId (or any
// other identifier / PII field) can never even be loaded onto the wire.
assertSoundExtractionSchema(ORDER_CANCEL_EXTRACTION_SCHEMA);
