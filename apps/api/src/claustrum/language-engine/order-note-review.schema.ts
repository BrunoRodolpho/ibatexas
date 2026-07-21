// order-note-review.schema.ts — FE-T14 (rollout: convenience mutating
// verbs). The pack-orders free-text family: order.note.add, order.review.
// submit. Both carry genuine free-text Directive content the model must
// copy VERBATIM (never paraphrase, never invent) — the corpus for each
// asserts verbatim-fidelity on positive cases and field-ABSENT on
// no-content cases (CRITICAL DESIGN RULE 6, FE-T14).
//
// ── order.note.add ───────────────────────────────────────────────────────
// Wire payload (`OrderNoteAddPayload`, pack-orders/src/types.ts) is
// `{orderId, body, isInternal?}` — orderId is Identity-class (forbidden).
// FE-D30 — `isInternal` is no longer a permitted payload channel here (its
// `legacyPayloadChannels` entry was dropped): the customer-facing/internal
// distinction is never a model OR ops-plane-model decision, so the ops-plane
// executor (`executeNote`, ops-tool-registry.ts) now forces `isInternal: true`
// (fail-closed to internal) unconditionally. A public note is a deterministic
// staff-UI toggle on the admin HTTP path ONLY (no such UI toggle exists yet, so
// ops-plane notes are simply always-internal). The model sees ONLY `{body}` —
// required, free text.
// `order.note.add` is ALREADY fully wired for auto-resolve (both
// ORDER_AUTORESOLVE_KINDS, resolve-and-assemble.ts, and
// AUTORESOLVE_CONFIRM_KINDS, compose-policy-packs.ts, already list it —
// no resolver change needed here, unlike the cart/item family). It ALSO
// shares the ops-plane explicit-reference channel `order.status.
// transition` already declares (BKL-089, `resolveOrderTarget`,
// ops-resolver.ts, explicitly documents the resolution branch as
// "shared ... order.note.add / order.status.transition"): a staff
// message can name an orderId directly (e.g. "adiciona uma nota no
// pedido order_1"), and the plan-time filter must not strip it before
// that authoritative direct-lookup runs — the same `legacyPayloadChannels`
// exception, same reason, as order-status-transition.schema.ts's own.
//
// ── order.review.submit ──────────────────────────────────────────────────
// Wire payload (`OrderReviewSubmitPayload`) is `{orderId, productId,
// rating, comment?}`. `orderId`/`productId` are Identity-class (forbidden)
// — the model sees `{rating, comment?}` PLUS two Directive-class NL
// reference fields it MAY name (`orderReference`, `item`), never the
// internal ids themselves.
//
// FE-D28 (ACTIVATION) — review-by-chat is now real. Both identifiers are
// resolved server-side, mirroring the established idioms of this rollout
// slice (never a wire field, `productId` stays forbidden-by-default —
// unlike the read-tool `permittedIdentifiers` pair below):
//   - `orderId`: `resolveCustomerOrderReference` (resolve-and-assemble.ts,
//     FE-T13) parses the optional `orderReference` display number ("pedido
//     1234"), IDOR-checks it against the caller, and falls back to the
//     customer's most-recent order when absent — the SAME auto-resolve
//     `order.note.add`/`order.amend.*` already use (grounded → forces a
//     REQUEST_CONFIRMATION so a wrong "which order?" guess never
//     auto-executes).
//   - `productId`: resolved from the order's OWN line items — a review is
//     purchase-bound, you can only review a product you bought. When the
//     order has exactly one distinct product it resolves unambiguously; a
//     multi-product order is disambiguated by the model's NL `item`
//     reference against those lines (the SAME exact-title + variantId
//     bridge `resolveLineItemByNameOrVariant` gives the granular amend
//     kinds — `resolveReviewedProduct`, resolve-and-assemble.ts). A
//     no-match / still-ambiguous reference resolves to no product (an
//     honest disambiguation reply downstream), never a guess.
//
// `productId` remains on FORBIDDEN_EXTRACTION_FIELD_NAMES (extraction-
// schema.ts, via `EXEMPTABLE_IDENTIFIER_NAMES`) so no future schema can
// leak it by DEFAULT. Its OTHER role — `get_also_added`/
// `get_ordered_together`'s public catalog lookup key (read-tool-schemas.ts)
// — is a structurally different, non-owner-scoped use of the SAME name;
// those two schemas declare `permittedIdentifiers: ["productId"]`, a
// narrow, explicit, auditable per-schema exception (never the reverse —
// `NEVER_EXEMPTABLE_FIELD_NAMES`, the PII/safety-critical half, admits no
// such exception, structurally). This capability declares NO
// `permittedIdentifiers`: its `productId` stays forbidden-by-default and
// is only ever resolver-stamped.

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
  legacyPayloadChannels: [
    {
      field: "orderId",
      reason:
        "BKL-089 order-reference-resolution — resolveOrderTarget " +
        "(ops-resolver.ts) tries an authoritative direct lookup on a " +
        "model/staff-supplied orderId (the SAME shared branch order." +
        "status.transition uses) before falling back to auto-resolve; " +
        "an ops-plane authoritative lookup, not a customer-plane " +
        "autoresolve hazard.",
    },
  ],
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
      {
        // FE-D28 — optional NL product reference; the runtime matches it
        // against the reviewed order's OWN line items to resolve the
        // (Identity-class, forbidden) productId. Omit when the order has a
        // single product (resolved unambiguously) or the customer names no
        // specific item — NEVER an id.
        name: "item",
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          description:
            "Referência em linguagem natural ao item avaliado do pedido " +
            "(ex.: \"a costela\", \"o hambúrguer\"), SOMENTE se o cliente " +
            "citar um. NUNCA um ID — a referência é resolvida pelo runtime. " +
            "Deixe de fora se a avaliação for do pedido como um todo.",
        },
        required: false,
      },
      {
        // FE-D28 — optional NL display-number reference for the reviewed
        // order (same Directive-class idiom as CHECK_ORDER_STATUS_READ_
        // SCHEMA's orderReference; resolved + IDOR-checked server-side).
        name: "orderReference",
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          description:
            "Número do pedido avaliado, SOMENTE se o cliente mencionar um " +
            "explicitamente (ex.: \"1234\", \"#1234\"). Deixe de fora se não " +
            "for mencionado — resolve automaticamente para o pedido mais recente.",
        },
        required: false,
      },
    ],
    example: {
      utterance: "dou 5 estrelas pro pedido, chegou rapidinho e quentinho",
      payload: { rating: 5, comment: "chegou rapidinho e quentinho" },
    },
  };

// Fail closed at import time — a schema that would leak orderId/productId
// (or any other identifier / PII field) can never even be loaded onto the wire.
assertSoundExtractionSchema(ORDER_NOTE_ADD_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(ORDER_REVIEW_SUBMIT_EXTRACTION_SCHEMA);
