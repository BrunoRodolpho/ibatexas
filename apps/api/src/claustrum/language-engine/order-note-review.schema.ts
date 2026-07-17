// order-note-review.schema.ts — FE-T14 (rollout: convenience mutating
// verbs). The pack-orders free-text family: order.note.add, order.review.
// submit. Both carry genuine free-text Directive content the model must
// copy VERBATIM (never paraphrase, never invent) — the corpus for each
// asserts verbatim-fidelity on positive cases and field-ABSENT on
// no-content cases (CRITICAL DESIGN RULE 6, FE-T14).
//
// ── order.note.add ───────────────────────────────────────────────────────
// Wire payload (`OrderNoteAddPayload`, pack-orders/src/types.ts) is
// `{orderId, body, isInternal?}` — orderId is Identity-class (forbidden);
// `isInternal` is EXPLICITLY on FORBIDDEN_EXTRACTION_FIELD_NAMES (the
// customer-facing/internal-staff-only distinction is never a model
// decision — always resolver-defaulted `false` for customer-originated
// notes, per docs/architecture/design/agent-tools.md: "Note is stored as
// customer-visible"). The model sees ONLY `{body}` — required, free text.
// `order.note.add` is ALREADY fully wired for auto-resolve (both
// ORDER_AUTORESOLVE_KINDS, resolve-and-assemble.ts, and
// AUTORESOLVE_CONFIRM_KINDS, compose-policy-packs.ts, already list it —
// no resolver change needed here, unlike the cart/item family).
//
// ── order.review.submit ──────────────────────────────────────────────────
// Wire payload (`OrderReviewSubmitPayload`) is `{orderId, productId,
// rating, comment?}`. `orderId`/`productId` are Identity-class (forbidden
// in spirit — see below) — the model sees ONLY `{rating, comment?}`.
// UNLIKE every other kind in this rollout slice, `order.review.submit` has
// NO resolver path for EITHER identifier today: `SubmitReviewInputSchema.
// parse(input)` (submit-review.ts) requires both directly, and neither
// ORDER_AUTORESOLVE_KINDS nor any other resolver stamps them — this
// capability is "registered-but-unadvertised" (definitions.ts,
// register-ibatexas-tool-packs.ts: "the orders planner never advertises
// it; reviews arrive via the web flow"), a stable, deliberate state, not
// a bug this rollout slice is fixing. The schema is authored here for
// COVERAGE (the ticket's AC3: every CHAT_DRIVABLE mutating capability has
// an authored schema); the capability stays deliberately UNADVERTISED (the
// customer planner never offers it) and ships with NO corpus (an
// unadvertised kind can never be live-driven — a corpus would be dead
// data).
//
// `productId` is deliberately NOT added to FORBIDDEN_EXTRACTION_FIELD_
// NAMES — a name-ban was the wrong tool here (owner ruling): `productId`
// is a genuinely different class for `get_also_added`/`get_ordered_
// together` (a public catalog lookup key, read-tool-schemas.ts's own
// precedent) than it would be for THIS capability, and this schema's own
// field list (`{rating, comment?}`, no `productId`) is already the real
// protection — a model-smuggled `productId` has nowhere to land on this
// wire, and #272's parse-seam filter closes the remaining json-mode gap
// (additionalProperties isn't strictly enforced) once it lands.
//
// The full orderId/productId resolution + advertisement activation is
// tracked as FE-D28 (carved): resolve the reviewed product from the
// order's own line items via an NL `item` reference (mirroring the
// granular amend kinds' itemId pattern) and an optional `order_reference`
// display-number field reusing FE-T13's `resolveCustomerOrderReference`
// (already on dev, IDOR-checked) — see the FE-T14 PR body for the full
// reasoning. `productId` stays resolver-side when that lands: an
// order-line lookup keyed off the NL `item` reference, exactly like
// `variantId`/`itemId` elsewhere in this rollout — never a wire field.

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

export const ORDER_NOTE_ADD_EXTRACTION_SCHEMA: CapabilityExtractionSchema = {
  capability: "order.note.add",
  fields: [
    {
      name: "body",
      trustClass: "directive",
      jsonSchema: {
        type: "string",
        description:
          "Texto da observação, EXATAMENTE como o cliente disse — nunca " +
          "resuma, parafraseie ou invente conteúdo.",
      },
      required: true,
    },
  ],
  example: {
    utterance: "adiciona uma observação no meu pedido: sem cebola, por favor",
    payload: { body: "sem cebola, por favor" },
  },
};

export const ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.review.submit",
    fields: [
      {
        name: "rating",
        // `ExtractionFieldJsonSchema.enum` is string-only (mirrors the
        // status-enum precedent, order-status-transition.schema.ts) — a
        // 1-5 star rating is a `number` field, so the valid range is
        // described in prose instead (same idiom as
        // CHECK_AVAILABILITY_READ_SCHEMA's `partySize`, read-tool-
        // schemas.ts, rather than a speculative numeric-enum extension for
        // this one field).
        trustClass: "directive",
        jsonSchema: {
          type: "number",
          description: "Nota de 1 a 5 dada pelo cliente.",
        },
        required: true,
      },
      {
        name: "comment",
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          description:
            "Comentário da avaliação, EXATAMENTE como o cliente disse. " +
            "Omita se não houver comentário explícito.",
        },
        required: false,
      },
    ],
    example: {
      utterance: "dou 5 estrelas pro pedido, chegou rapidinho e quentinho",
      payload: { rating: 5, comment: "chegou rapidinho e quentinho" },
    },
  };

// Fail closed at import time — a schema that would leak orderId/productId/
// isInternal (or any other identifier / PII field) can never even be
// loaded onto the wire.
assertSoundExtractionSchema(ORDER_NOTE_ADD_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA);
