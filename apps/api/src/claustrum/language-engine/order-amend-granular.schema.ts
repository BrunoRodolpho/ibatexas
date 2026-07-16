// order-amend-granular.schema.ts — FE-T09 (D-a, the amend inversion).
//
// Per FE-1.2 (verified constraint): the grouped post-checkout amend
// capability (`order.amend.request`) is resolver-composed-only and NOT a
// model extraction target — it carries a nested change array (an
// under-extraction hazard) and, critically, has no allergen field for added
// lines. The model instead emits these THREE granular single-op amend
// capabilities. `order.amend.add_item`'s wire contract
// (`OrderAmendAddItemPayload`) carries a REQUIRED explicit `allergens` array
// (CLAUDE.md rule #1) — that field is FORBIDDEN on this schema (see
// `extraction-schema.ts`'s `FORBIDDEN_EXTRACTION_FIELD_NAMES`), so a
// post-checkout add can never bypass the allergen-explicitness rule by
// having the model fill it: `allergens` is always resolver/menu-derived at
// hydration (`resolve-and-assemble.ts`'s `resolveProductForItem`, the SAME
// Typesense-backed resolution `order.item.add` already uses) or the kernel's
// `requireExplicitAllergens` guard REFUSEs the intent outright.
//
// `orderId` (Identity, resolver-only — the customer's target order,
// auto-resolved to "most recent" exactly like `order.amend.request` today)
// and `itemId`/`variantId` (Identity, resolver-only — resolved from the NL
// `item` reference via the same product-search hydration) are NEVER listed
// here; `assertSoundExtractionSchema` fails closed on any of the three.

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

const ITEM_REFERENCE_JSON_SCHEMA = {
  type: "string",
  description:
    "Referência em linguagem natural ao item do pedido (ex.: \"coca\", " +
    "\"o hambúrguer\"). NUNCA um ID — a referência é resolvida pelo runtime.",
} as const;

export const ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.amend.add_item",
    fields: [
      {
        name: "item",
        trustClass: "directive",
        jsonSchema: ITEM_REFERENCE_JSON_SCHEMA,
        required: true,
      },
      {
        name: "quantity",
        trustClass: "directive",
        jsonSchema: {
          type: "number",
          description: "Quantidade do item a adicionar (padrão: 1 se não informado).",
        },
        required: false,
      },
    ],
    example: {
      utterance: "adiciona uma coca no meu pedido",
      payload: { item: "coca", quantity: 1 },
    },
  };

export const ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.amend.update_qty",
    fields: [
      {
        name: "item",
        trustClass: "directive",
        jsonSchema: ITEM_REFERENCE_JSON_SCHEMA,
        required: true,
      },
      {
        name: "quantity",
        trustClass: "directive",
        jsonSchema: {
          type: "number",
          description: "Nova quantidade desejada para o item.",
        },
        required: true,
      },
    ],
    example: {
      utterance: "muda a quantidade do hambúrguer pra 2",
      payload: { item: "hambúrguer", quantity: 2 },
    },
  };

export const ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.amend.remove_item",
    fields: [
      {
        name: "item",
        trustClass: "directive",
        jsonSchema: ITEM_REFERENCE_JSON_SCHEMA,
        required: true,
      },
    ],
    example: {
      utterance: "tira a coca do meu pedido",
      payload: { item: "coca" },
    },
  };

// Fail closed at import time — a schema that would leak orderId/variantId/
// itemId/allergens (or any other identifier / PII field) can never even be
// loaded onto the wire.
assertSoundExtractionSchema(ORDER_AMEND_ADD_ITEM_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(ORDER_AMEND_UPDATE_QTY_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(ORDER_AMEND_REMOVE_ITEM_EXTRACTION_SCHEMA);
