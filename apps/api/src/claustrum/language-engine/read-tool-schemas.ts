// read-tool-schemas.ts — FE-T13: the per-read-tool extraction schema
// registry for the CHAT_DRIVABLE status/read-query surface.
//
// This is a STRUCTURALLY SEPARATE code path from wire-schemas.ts's
// `AUTHORED_SCHEMAS`/`EXTRACTION_SCHEMAS_BY_CAPABILITY`: that registry keys
// the `express_intent` tool's `payload` sub-schema by IntentEnvelope kind —
// it can never apply here. `plan.visibleReadTools` (the 12 chat-plane
// advertised read-only tools, unioned from `ToolClassification.READ_ONLY`
// across pack-orders/payments/reservations/customer-onboarding) is a
// DIFFERENT surface: `buildToolSurface` (ibatexas-planner.ts) gives EVERY
// read tool the SAME generic `{type:"object", additionalProperties:true}`
// schema today, regardless of what it actually accepts — the read-tool
// analog of the untyped payload blob FE-T05 fixed on the express_intent side
// (spec Problem Statement #1). No AuditRecord/HydratedIntentIR exists for a
// read tool call (reads never go through `adjudicate()`), so unlike the
// mutating rollout slices (T05/T09/T10) there is no per-capability
// "hydration + audit-metadata" derivation here — see the FE-T13 coverage
// report for the full accounting of what does and doesn't apply.
//
// Reused, NOT reimplemented: `CapabilityExtractionSchema` /
// `assertSoundExtractionSchema` / `toPayloadJsonSchema` /
// `FORBIDDEN_EXTRACTION_FIELD_NAMES` (extraction-schema.ts) are
// capability-agnostic — `capability` here is simply keyed by the read
// tool's NAME (e.g. "check_order_status") rather than an IntentEnvelope
// kind. The SAME schema-lint gate (read-tool-schema-lint-gate.test.ts)
// walks this registry too, so a forbidden identifier/PII field can never
// reach a read tool's wire schema either.
//
// Consolidated into ONE file (unlike order-status-transition.schema.ts /
// payment-refund-issue.schema.ts's one-file-per-capability convention):
// every schema here is 0-2 fields — the rollout slice's own calibration
// ("reads are LOW-RISK... typically 0-2 fields") — so grouping by pack
// keeps 12 near-trivial schemas from becoming 12 near-empty files.
//
// Scope: only the CUSTOMER/chat-plane read roster is covered. The 2
// staff/ops-only reads (`ops_snapshot`, the sales-analytics read) are NEVER
// chat-plane-advertised (`deriveIbatexasPlannerContext` pins staffId:null on
// this plane) — out of scope, they keep the generic fallback schema, same
// as any future unauthored read tool would.
//
// Identifier resolution: `orderId`/`paymentId` never appear as a field here
// (FORBIDDEN_EXTRACTION_FIELD_NAMES) — `check_order_status` /
// `get_payment_status` resolve the customer's own most-recent order
// server-side (claustrum-bootstrap.ts's executors, via `resolveOrderId`,
// resolve-and-assemble.ts) instead, mirroring order.status.transition's
// "most recent order" precedent (order-status-transition.schema.ts) exactly,
// just on the read side.

import {
  toPayloadJsonSchema,
  type CapabilityExtractionSchema,
  type ExtractionFieldJsonSchema,
} from "./extraction-schema.js";

/** A read tool with no model-facing field at all — every value it needs is
 *  resolved server-side from the authenticated session (owner, most-recent
 *  order, etc.), never from the model. Still an authored, SOUND, typed
 *  schema (`additionalProperties:false` via `toPayloadJsonSchema`) — a real
 *  tightening from today's `additionalProperties:true` blob, which lets the
 *  model stuff arbitrary (and, pre-FE-T13, sometimes forged) fields in. */
function emptyReadSchema(name: string, utterance: string): CapabilityExtractionSchema {
  return {
    capability: name,
    fields: [],
    example: { utterance, payload: {} },
  };
}

// ── pack-orders reads ───────────────────────────────────────────────────

export const GET_CART_READ_SCHEMA = emptyReadSchema(
  "get_cart",
  "o que tem no meu carrinho?",
);

export const GET_ORDER_HISTORY_READ_SCHEMA = emptyReadSchema(
  "get_order_history",
  "quais foram meus últimos pedidos?",
);

/** `orderId` is Identity-class and forbidden — resolved server-side. The one
 *  optional field, `orderReference`, is a Directive-class NL display-number
 *  reference ("pedido 1234", "#1234") — NEVER the internal orderId itself;
 *  `check_order_status`'s executor (claustrum-bootstrap.ts) resolves it via
 *  `resolveCustomerOrderReference` (resolve-and-assemble.ts), which parses a
 *  display number and IDOR-checks it against the caller before trusting it,
 *  falling back to the customer's own most-recent order (same auto-resolve
 *  as when the field is absent, which will be the common case). */
export const CHECK_ORDER_STATUS_READ_SCHEMA: CapabilityExtractionSchema = {
  capability: "check_order_status",
  fields: [
    {
      name: "orderReference",
      trustClass: "directive",
      jsonSchema: {
        type: "string",
        description:
          "Número do pedido, SOMENTE se o cliente mencionar um explicitamente " +
          "(ex.: \"1234\", \"#1234\"). Deixe de fora se não for mencionado — " +
          "resolve automaticamente para o pedido mais recente.",
      },
      required: false,
    },
  ],
  example: { utterance: "cadê meu pedido?", payload: {} },
};

export const GET_RECOMMENDATIONS_READ_SCHEMA: CapabilityExtractionSchema = {
  capability: "get_recommendations",
  fields: [
    {
      name: "context",
      // State class: a situational/UI-context hint (where in the
      // conversation flow the recommendation was triggered from), not
      // user-authored intent content — the model relays where it is, never
      // fabricates a customer request. See field-trust.ts's State doc.
      trustClass: "state",
      jsonSchema: {
        type: "string",
        enum: ["homepage", "cart", "product_page"],
        description: "Contexto da recomendação (opcional) — de onde a pergunta partiu.",
      },
      required: false,
    },
  ],
  example: { utterance: "o que vocês recomendam?", payload: {} },
};

/** `get_also_added` / `get_ordered_together` both key off `productId` — a
 *  PUBLIC catalog reference (not an owner-scoped resource id: no
 *  authorization decision is ever gated on trusting this string, unlike
 *  orderId/paymentId/cartId). FE-T14 added `productId` to
 *  `FORBIDDEN_EXTRACTION_FIELD_NAMES` for a DIFFERENT capability
 *  (order.review.submit's OWN productId — an owner-scoped, purchase-bound
 *  reference, a structurally different role) — these two read schemas name
 *  it in their own `permittedIdentifiers` below, a narrow per-capability
 *  exception, not a reversal of the forbidden-by-default posture.
 *  Classified State (not Directive): the model relays an id it already
 *  holds from an EARLIER read this same conversation (a menu/search/
 *  recommendation result) — it is "consumed ONLY as a lookup key" into the
 *  copurchase/co-order data (field-trust.ts's own State definition,
 *  verbatim), never typed by the customer and never used to gate
 *  ownership. */
const PRODUCT_ID_LOOKUP_KEY_JSON_SCHEMA = {
  type: "string" as const,
  description:
    "ID do produto — SEMPRE um id já retornado por uma leitura anterior nesta " +
    "conversa (busca de cardápio, recomendação, carrinho), NUNCA inventado ou " +
    "digitado pelo cliente.",
};

export const GET_ALSO_ADDED_READ_SCHEMA: CapabilityExtractionSchema = {
  capability: "get_also_added",
  fields: [
    {
      name: "productId",
      trustClass: "state",
      jsonSchema: PRODUCT_ID_LOOKUP_KEY_JSON_SCHEMA,
      required: true,
    },
  ],
  example: { utterance: "o que combina com esse hambúrguer?", payload: { productId: "prod_123" } },
  permittedIdentifiers: ["productId"],
};

export const GET_ORDERED_TOGETHER_READ_SCHEMA: CapabilityExtractionSchema = {
  capability: "get_ordered_together",
  fields: [
    {
      name: "productId",
      trustClass: "state",
      jsonSchema: PRODUCT_ID_LOOKUP_KEY_JSON_SCHEMA,
      required: true,
    },
  ],
  example: { utterance: "o que eu costumo pedir junto desse item?", payload: { productId: "prod_123" } },
  permittedIdentifiers: ["productId"],
};

// ── pack-payments reads ──────────────────────────────────────────────────

/** `orderId` is Identity-class and forbidden — same `orderReference`
 *  NL-display-number field + resolution posture as
 *  CHECK_ORDER_STATUS_READ_SCHEMA above. */
export const GET_PAYMENT_STATUS_READ_SCHEMA: CapabilityExtractionSchema = {
  capability: "get_payment_status",
  fields: [
    {
      name: "orderReference",
      trustClass: "directive",
      jsonSchema: {
        type: "string",
        description:
          "Número do pedido, SOMENTE se o cliente mencionar um explicitamente " +
          "(ex.: \"1234\", \"#1234\"). Deixe de fora se não for mencionado — " +
          "resolve automaticamente para o pedido mais recente.",
      },
      required: false,
    },
  ],
  example: { utterance: "meu pagamento caiu?", payload: {} },
};

export const GET_PAYMENT_HISTORY_READ_SCHEMA = emptyReadSchema(
  "get_payment_history",
  "quais foram meus últimos pagamentos?",
);

// ── pack-reservations reads ──────────────────────────────────────────────

/** Unlike every other read here, `check_availability` has genuine
 *  customer-authored planning parameters (Directive class — untrusted user
 *  intent, not a first-party lookup key) and NO owner scope at all (a guest
 *  can check availability): `date`/`partySize` are required; `preferredTime`
 *  is an optional narrowing. Mirrors `CheckAvailabilityInputSchema`
 *  (@ibatexas/types) — the SAME fields the real handler already validates,
 *  just now the ONLY fields the model can propose (vs. today's anything-goes
 *  blob). */
export const CHECK_AVAILABILITY_READ_SCHEMA: CapabilityExtractionSchema = {
  capability: "check_availability",
  fields: [
    {
      name: "date",
      trustClass: "directive",
      jsonSchema: {
        type: "string",
        description: "Data desejada da reserva, formato YYYY-MM-DD.",
      },
      required: true,
    },
    {
      name: "partySize",
      trustClass: "directive",
      jsonSchema: {
        type: "number",
        description: "Número de pessoas (1 a 20).",
      },
      required: true,
    },
    {
      name: "preferredTime",
      trustClass: "directive",
      jsonSchema: {
        type: "string",
        description: "Horário preferido, formato HH:MM (opcional).",
      },
      required: false,
    },
  ],
  example: {
    utterance: "tem mesa pra 4 pessoas sábado dia 20, data 2026-07-18?",
    payload: { date: "2026-07-18", partySize: 4 },
  },
};

export const GET_MY_RESERVATIONS_READ_SCHEMA: CapabilityExtractionSchema = {
  capability: "get_my_reservations",
  fields: [
    {
      name: "status",
      // Directive class: an explicit customer-stated filter preference
      // ("só as confirmadas"), not a first-party-loaded fact.
      trustClass: "directive",
      jsonSchema: {
        type: "string",
        enum: ["pending", "confirmed", "seated", "completed", "cancelled", "no_show"],
        description: "Filtrar por status da reserva (opcional).",
      },
      required: false,
    },
  ],
  example: { utterance: "quais são minhas reservas?", payload: {} },
};

// ── pack-customer-onboarding reads ───────────────────────────────────────

export const GET_MY_PROFILE_READ_SCHEMA = emptyReadSchema(
  "get_my_profile",
  "qual é o meu perfil?",
);

export const GET_MY_PREFERENCES_READ_SCHEMA = emptyReadSchema(
  "get_my_preferences",
  "quais são minhas restrições alimentares salvas?",
);

/** Every read tool's authored extraction schema — the schema-lint gate's
 *  walk target (mirrors wire-schemas.ts's `AUTHORED_SCHEMAS`). */
export const READ_TOOL_AUTHORED_SCHEMAS: readonly CapabilityExtractionSchema[] = [
  GET_CART_READ_SCHEMA,
  GET_ORDER_HISTORY_READ_SCHEMA,
  CHECK_ORDER_STATUS_READ_SCHEMA,
  GET_RECOMMENDATIONS_READ_SCHEMA,
  GET_ALSO_ADDED_READ_SCHEMA,
  GET_ORDERED_TOGETHER_READ_SCHEMA,
  GET_PAYMENT_STATUS_READ_SCHEMA,
  GET_PAYMENT_HISTORY_READ_SCHEMA,
  CHECK_AVAILABILITY_READ_SCHEMA,
  GET_MY_RESERVATIONS_READ_SCHEMA,
  GET_MY_PROFILE_READ_SCHEMA,
  GET_MY_PREFERENCES_READ_SCHEMA,
];

/** read-tool-name -> its wire JSON-Schema (pre-built, asserted sound via
 *  `toPayloadJsonSchema`'s internal `assertSoundExtractionSchema` call —
 *  same fail-closed-at-import-time posture as wire-schemas.ts). */
export const READ_TOOL_SCHEMAS_BY_NAME: ReadonlyMap<string, Record<string, unknown>> = new Map(
  READ_TOOL_AUTHORED_SCHEMAS.map((schema) => [schema.capability, toPayloadJsonSchema(schema)]),
);

/** read-tool-name -> its full authored schema (fields + trust classes) —
 *  the lookup {@link sanitizeReadToolInput} needs; `READ_TOOL_SCHEMAS_BY_NAME`
 *  only carries the already-flattened wire JSON-Schema. */
const READ_TOOL_SCHEMAS_FULL_BY_NAME: ReadonlyMap<string, CapabilityExtractionSchema> = new Map(
  READ_TOOL_AUTHORED_SCHEMAS.map((schema) => [schema.capability, schema]),
);

/** Does `value`'s runtime type/enum membership match a field's declared
 *  {@link ExtractionFieldJsonSchema}? Pure. */
function matchesFieldSchema(js: ExtractionFieldJsonSchema, value: unknown): boolean {
  if (js.type === "string" && typeof value !== "string") return false;
  if (js.type === "number" && typeof value !== "number") return false;
  if (js.type === "boolean" && typeof value !== "boolean") return false;
  if (js.enum !== undefined && !js.enum.includes(value as string)) return false;
  return true;
}

/**
 * FE-T13 P5 fail-safe (team-lead ruling): the advertised `inputSchema` is
 * currently ADVERTISEMENT-ONLY — nothing in the dispatch path
 * (`translateToolCalls`, ibatexas-planner.ts) validates a read tool's
 * `call.input` against it before invoking the executor; `call.input` flows
 * through verbatim. Rather than let a model that emits an out-of-schema
 * field (a forged identifier, a malformed enum value, an extra key) pass it
 * straight to the real handler — which may or may not itself Zod-validate,
 * and if it doesn't, would silently accept junk — this SANITIZES the input
 * at the one dispatch choke point (ibatexas-planner.ts's read-loop
 * invocation) for every tool with an AUTHORED schema:
 *
 *   - a field NOT declared on the schema is DROPPED (never forwarded);
 *   - a declared field whose runtime type/enum doesn't match is DROPPED
 *     (treated as absent — never coerced, never forwarded malformed);
 *   - a tool with NO authored schema yet is untouched (today's behavior,
 *     unaffected — the 2 staff/ops-only reads never reach the chat-plane
 *     dispatch path anyway).
 *
 * Never throws, never hard-fails a read: the worst case is an
 * over-stripped call that behaves exactly like today's argless call (P4 —
 * availability wins; reads are low-irreversibility). This is METADATA
 * enforcing a structural shape (P5: "metadata DESCRIBES, guards
 * IMPLEMENT") — it is NOT a business-logic decision (ownership, legality,
 * money thresholds all stay exactly where they already lived, inside each
 * real handler / kernel guard).
 */
export function sanitizeReadToolInput(toolName: string, rawInput: unknown): Record<string, unknown> {
  const schema = READ_TOOL_SCHEMAS_FULL_BY_NAME.get(toolName);
  const input = rawInput !== null && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  if (schema === undefined) return input;

  const out: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const value = input[field.name];
    if (value === undefined) continue;
    if (!matchesFieldSchema(field.jsonSchema, value)) continue;
    out[field.name] = value;
  }
  return out;
}
