// customer-whatsapp-convenience.schema.ts — FE-T14 (rollout: convenience
// mutating verbs). The pack-customer-onboarding + pack-whatsapp family:
// customer.preferences.update, customer.pix.details.save,
// whatsapp.handoff.request.
//
// ── customer.preferences.update ─────────────────────────────────────────
// Wire payload (`CustomerPreferencesUpdatePayload`, pack-customer-
// onboarding/src/types.ts) is `{allergenExclusions, dietaryFlags?,
// favoriteCategories?}` — `allergenExclusions` is REQUIRED and the
// executor (packages/tools/src/intelligence/update-preferences.ts)
// hard-REFUSEs when it is not an explicit array (Hard Rule #1: "Allergens:
// always explicit array — never infer from product name or description").
// This is the sharpest live safety gap this rollout slice closes: WITHOUT
// an authored schema, the model sees the generic `{type:"object"}` blob
// for this capability and COULD legally infer/stuff `allergenExclusions`
// straight from conversational text, a Hard-Rule-#1 violation the untyped
// path structurally permits today. `allergenExclusions` is therefore NEVER
// exposed on this schema — the model sees ONLY `{dietaryFlags?,
// favoriteCategories?}` (both non-safety-critical preference metadata, per
// the pack type's own doc comment) — FE-T14's resolve-and-assemble.ts
// addition UNCONDITIONALLY strips whatever the resolved payload carries
// under `allergenExclusions` and refills it from the customer's CURRENT
// saved preferences (never wiped, never model-touched), mirroring the
// order.item.add allergens precedent exactly.
//
// ── customer.pix.details.save ───────────────────────────────────────────
// Wire payload (via `SetPixDetailsInputSchema`, packages/tools/src/cart/
// set-pix-details.ts) is `{name?, email?, cpf?}` — ALL THREE are PII.
// `email`/`cpf` are hard-forbidden by name (FORBIDDEN_EXTRACTION_FIELD_
// NAMES); `name` is NOT literally on that list (it names a public-facing
// convention, "orderId"-style identifiers and structured safety fields,
// not free-text PII by name) but is unambiguously PII here — a customer's
// full legal name collected for PIX billing. This schema is therefore
// EMPTY (mirrors read-tool-schemas.ts's `emptyReadSchema` precedent): the
// model can never populate ANY of name/email/cpf via the typed wire.
//
// KNOWN PRODUCT-BEHAVIOR CHANGE (flagged, not silently absorbed): today,
// with the generic untyped blob, the model can ATTEMPT to fill name/email/
// cpf from free text (whether or not `set_pix_details`'s own Zod/semantic
// validation then accepts it). After this schema lands, `customer.pix.
// details.save` proposals via `express_intent` can never carry any of the
// three — the "call set_pix_details progressively with partial data
// collected from chat" UX effectively stops working through this path.
// PII cannot safely be narrowed any other way (per-field consent capture
// belongs in a dedicated, explicit flow — e.g. a web form deep link — not
// free-text extraction), so this is the correct tightening; it is called
// out here because it is a bigger behavior change than a typical schema
// narrowing, not merely a safety fix with no functional cost.
//
// ── whatsapp.handoff.request ─────────────────────────────────────────────
// Wire payload (`WhatsAppHandoffRequestPayload`, pack-whatsapp/src/types.ts)
// is `{sessionId, reason?}` — `sessionId` is Identity-class, always
// runtime-injected by the executor (register-ibatexas-tool-packs.ts:
// `sessionId: ctx.sessionId`), never the payload. The model sees ONLY
// `{reason?}` — free text, audit-redacted per agent-tools.md
// ("the free-text reason is audit-redacted").

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

export const CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "customer.preferences.update",
    fields: [
      {
        name: "dietaryFlags",
        trustClass: "directive",
        // freeform: true — genuinely open-vocabulary preference words (any
        // diet name a customer might say), not a fixed enum; see extraction-
        // schema.ts's ExtractionFieldJsonSchema doc for why this must be an
        // explicit opt-in, never a silent default.
        jsonSchema: {
          type: "array",
          items: { type: "string", freeform: true },
          description:
            "Restrições alimentares mencionadas pelo cliente (ex.: " +
            "[\"vegetariano\", \"sem glúten\"]). NUNCA inclua alergias aqui.",
        },
        required: false,
      },
      {
        name: "favoriteCategories",
        trustClass: "directive",
        // freeform: true — same open-vocabulary reasoning as dietaryFlags.
        jsonSchema: {
          type: "array",
          items: { type: "string", freeform: true },
          description:
            "Categorias favoritas mencionadas pelo cliente (ex.: " +
            "[\"churrasco\", \"grelhados\"]).",
        },
        required: false,
      },
    ],
    example: {
      utterance: "sou vegetariano e adoro comida grelhada",
      payload: { dietaryFlags: ["vegetariano"], favoriteCategories: ["grelhados"] },
    },
  };

export const CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "customer.pix.details.save",
    fields: [],
    example: {
      utterance: "meu nome é João Silva, email joao@example.com, cpf 123.456.789-00",
      payload: {},
    },
  };

export const WHATSAPP_HANDOFF_REQUEST_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "whatsapp.handoff.request",
    fields: [
      {
        name: "reason",
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          description:
            "Motivo do pedido de atendimento humano, se mencionado. Omita " +
            "se não houver motivo explícito.",
        },
        required: false,
      },
    ],
    example: {
      utterance: "quero falar com uma pessoa, meu pedido não chegou",
      payload: { reason: "meu pedido não chegou" },
    },
  };

// Fail closed at import time — a schema that would leak allergenExclusions/
// email/cpf/sessionId (or any other identifier / PII / safety-critical
// field) can never even be loaded onto the wire.
assertSoundExtractionSchema(CUSTOMER_PREFERENCES_UPDATE_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(CUSTOMER_PIX_DETAILS_SAVE_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(WHATSAPP_HANDOFF_REQUEST_EXTRACTION_SCHEMA);
