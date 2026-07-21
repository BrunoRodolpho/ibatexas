// order-cart-item.schema.ts — FE-T14 (rollout: convenience mutating verbs).
// The pack-orders cart/item family: order.cart.ensure, order.item.add,
// order.item.update, order.item.remove, order.coupon.apply. All five are
// session-scoped cart operations (never a "most recent order" guess like
// order.status.transition/order.note.add) — none are in
// AUTORESOLVE_CONFIRM_KINDS (compose-policy-packs.ts) or ORDER_AUTORESOLVE_
// KINDS (resolve-and-assemble.ts): the active cart is resolved
// deterministically from the session (BKL-028), not auto-resolved from an
// implicit "which order?" guess, so none of these force a confirm on that
// basis.
//
// ── order.cart.ensure ────────────────────────────────────────────────────
// Wire payload (`OrderCartEnsurePayload`, pack-orders/src/types.ts) is
// `{cartId?: string}` — 100% resolver-filled (cartId is Identity-class,
// forbidden). The model has nothing to extract; this mirrors read-tool-
// schemas.ts's `emptyReadSchema` precedent exactly (a real, sound,
// `additionalProperties:false` tightening over today's anything-goes blob,
// even with zero fields).
//
// ── order.item.add ───────────────────────────────────────────────────────
// Wire payload (`OrderItemAddPayload`) is `{cartId, variantId, quantity,
// allergens}` — cartId/variantId are Identity-class (forbidden), allergens
// is safety-critical (Hard Rule #1, forbidden by name AND by the
// `requireExplicitAllergens` guard, which REFUSEs an absent/non-array
// value). The model sees ONLY `{item, quantity?}` — the exact
// order-amend-granular.schema.ts shape (order.amend.add_item's sibling
// convention) — resolve-and-assemble.ts's `resolveProductForItem` (BKL-061)
// resolves `item` to `variantId` + the product's EXPLICIT stored
// `allergens` array (never inferred), UNCONDITIONALLY stripping whatever
// the model's completion carried under that key first (the FE-T09b review
// fix — a smuggled `allergens: []` must never survive unexamined).
//
// ── order.item.update / order.item.remove ────────────────────────────────
// Wire payloads (`OrderItemUpdatePayload`/`OrderItemRemovePayload`) need
// `itemId` — the real Medusa CART line-item id (`update_cart`/
// `remove_from_cart`'s REST contract, NOT the catalog `variantId` —
// verified against packages/tools/src/cart/update-cart.ts /
// remove-from-cart.ts directly, the doc at docs/architecture/design/
// agent-tools.md is stale here). `itemId` is Identity-class (forbidden), so
// the model sees `{item, quantity}` (update) / `{item}` (remove) — the same
// loose-NL-reference convention as add. FE-T14 adds `resolveCartLineItem`
// (resolve-and-assemble.ts, a cart-scoped sibling of the granular amend
// kinds' `resolveOrderLineItem`) to resolve it against the LIVE cart's line
// items — never a catalog-wide guess.
//
// ── order.coupon.apply ───────────────────────────────────────────────────
// Wire payload (`OrderCouponApplyPayload`) is `{cartId, code}` — cartId is
// forbidden; `code` is the coupon string the customer states verbatim
// (Directive, required). The wire field is `code`, not `couponCode` (the
// doc at agent-tools.md is stale here too).

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

const ITEM_REFERENCE_JSON_SCHEMA = {
  type: "string",
  description:
    "Referência em linguagem natural ao item do carrinho (ex.: \"coca\", " +
    "\"o hambúrguer\"). NUNCA um ID — a referência é resolvida pelo runtime.",
} as const;

export const ORDER_CART_ENSURE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.cart.ensure",
    fields: [],
    example: { utterance: "quero fazer um pedido", payload: {} },
  };

export const ORDER_ITEM_ADD_EXTRACTION_SCHEMA: CapabilityExtractionSchema = {
  capability: "order.item.add",
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
    utterance: "quero uma coca",
    payload: { item: "coca", quantity: 1 },
  },
};

export const ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.item.update",
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
          description: "Nova quantidade desejada para o item no carrinho.",
        },
        required: true,
      },
    ],
    example: {
      utterance: "muda a quantidade da coca pra 2",
      payload: { item: "coca", quantity: 2 },
    },
  };

export const ORDER_ITEM_REMOVE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.item.remove",
    fields: [
      {
        name: "item",
        trustClass: "directive",
        jsonSchema: ITEM_REFERENCE_JSON_SCHEMA,
        required: true,
      },
    ],
    example: {
      utterance: "tira a coca do carrinho",
      payload: { item: "coca" },
    },
  };

export const ORDER_COUPON_APPLY_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.coupon.apply",
    fields: [
      {
        name: "code",
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          description: "Código do cupom de desconto informado pelo cliente.",
        },
        required: true,
      },
    ],
    example: {
      utterance: "aplica o cupom PROMO10",
      payload: { code: "PROMO10" },
    },
  };

// Fail closed at import time — a schema that would leak cartId/variantId/
// itemId/allergens (or any other identifier / PII field) can never even be
// loaded onto the wire.
assertSoundExtractionSchema(ORDER_CART_ENSURE_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(ORDER_ITEM_ADD_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(ORDER_ITEM_UPDATE_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(ORDER_ITEM_REMOVE_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(ORDER_COUPON_APPLY_EXTRACTION_SCHEMA);
