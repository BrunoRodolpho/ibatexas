// order-checkout-create.schema.ts — FE-T12 (the orders governance-tier
// rollout), the first CUSTOMER-plane schema this rollout ticket authors.
// Wires `order.checkout.create` through the extraction-schema authoring
// contract: the model sees ONLY `payment_method`; `cartId` and `pixDetails`
// are NEVER listed here, never requested of the model.
//
// `cartId` (Identity, resolver-only, FORBIDDEN_EXTRACTION_FIELD_NAMES) is
// resolved deterministically from the session's active-cart Redis key
// (`resolve-and-assemble.ts`'s `loadCartCtx`, `cart:active:session:<sessionId>`)
// — UNLIKE `order.cancel`'s "most recent order" guess, this is not a
// candidate among several; it is THE customer's one active cart, bound by
// session. So checkout is deliberately NOT in `ORDER_AUTORESOLVE_KINDS` — no
// forced confirmation is needed on this account (the money-boundary
// CONFIRM/ESCALATE below is a wholly separate, guard-level reason to confirm).
//
// `pixDetails` (`{name, email, cpf}`) is PII — `email`/`cpf` are
// FORBIDDEN_EXTRACTION_FIELD_NAMES regardless of trustClass — so it is never
// authored onto this schema at all, exactly like `allergens` on
// `order.amend.add_item` (order-amend-granular.schema.ts). It stays fully
// resolver/HTTP-filled; a chat-driven PIX checkout with no saved PIX details
// is an existing wiring/guard concern this ticket does not touch or need to.
//
// The checkout money boundary (>=R$1000 CONFIRM, >=R$10000 REFUSE —
// `confirmLargeTicket`/`refuseAmountAboveCap`, pack-orders/src/policies.ts)
// is PURE guard-level policy, orthogonal to this schema: it fires on the
// cart total regardless of what the model extracted. This ticket asserts it
// stays intact via corpus `decision` expectations only — zero edits to
// pack-orders' guards.
//
// The field is OPTIONAL (team-lead review, FE-T12) — NOT required, even
// though the wire contract's `OrderCheckoutCreatePayload.paymentMethod` is a
// non-optional TS field. A REQUIRED closed-enum extraction field invites the
// 4B to FABRICATE a value on an utterance that names none ("quero fechar o
// pedido" mentions no method at all) — exactly the class of confident-wrong
// completion the extraction-schema contract exists to prevent. Absence flows
// to the EXISTING, unmodified honest path: `validatePaymentMethod`
// (pack-orders/src/policies.ts) REFUSEs with `refuseCheckoutMissingPaymentMethod`
// when `payload.paymentMethod` is null/undefined — a real, already-audited
// refusal code, not an invented default. The corpus asserts this directly
// (method-absent cases expect `extractionIR.payload` EMPTY and
// `decision: REFUSE`).
//
// `payment_method` (snake_case), NOT `paymentMethod` (team-lead ruling,
// live-calibration finding): the local 4B showed a 100%-stable bias toward
// `payment_method` across EVERY observed live call against the originally-
// authored `paymentMethod` field name — never once produced the camelCase
// form. Rather than fight a deterministic model bias with more prompt text,
// the WIRE contract is renamed to match what the model reliably produces;
// `resolve-and-assemble.ts`'s `mapCheckoutPaymentMethodWireField` renames it
// to the internal `paymentMethod` key `OrderCheckoutCreatePayload`/
// `validatePaymentMethod` (pack-orders, BYTE-UNTOUCHED) actually reads —
// mirrors the established BKL-094/BKL-089 rename idiom (payment.refund.
// issue's `orderReference`→`orderId`, `amount`→`refundAmountCentavos`). The
// audit-metadata sidecar stays honest: `deriveOrderCheckoutCreate` surfaces
// the value under the WIRE name (`payment_method`) in `extractionIR`, since
// that is what the model actually produced.
//
// `delivery_type` (team-lead ruling, cart-seeding investigation follow-up):
// a SECOND optional Directive field, same snake_case bias-accommodation
// logic as `payment_method`. Exists because `requireSlotsFilledForCheckout`
// (pack-orders/src/policies.ts, a STATE guard that runs BEFORE
// `validatePaymentMethod`/the money-band guards) REFUSEs
// `order.checkout.slots_incomplete` whenever `ctx.fulfillment` is null — and
// `ctx.fulfillment` is populated ONLY from `payload.deliveryType`/
// `payload.fulfillment` (`resolve-and-assemble.ts`'s `buildCartCtx`). The
// HTTP cart route always threads this slot explicitly; the chat planner
// never had a schema field for it, so chat checkout structurally could
// never progress past this guard regardless of payment_method or cart
// contents — live-caught during this ticket's own cart-seeding
// investigation, not a pre-existing gap this ticket introduced. Adding this
// field lets a chat customer supply BOTH slots in one turn and reach the
// SAME money-band guards the HTTP route always could — no new confirm path,
// no guard changes, the existing ladder. Absence flows to the existing
// `refuseSlotsIncomplete` refusal, same "never fabricate, let the honest
// guard fire" posture as `payment_method`'s absence handling.

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

/**
 * The three settlement channels `OrderCheckoutCreatePayload.paymentMethod`
 * accepts (packages/pack-orders/src/types.ts) — a closed enum, same "copy
 * the string verbatim" contract as `order.status.transition`'s `newStatus`.
 */
export const ORDER_CHECKOUT_CREATE_PAYMENT_METHODS = [
  "pix",
  "card",
  "cash",
] as const;

export type OrderCheckoutCreatePaymentMethod =
  (typeof ORDER_CHECKOUT_CREATE_PAYMENT_METHODS)[number];

/**
 * The two fulfillment slots `buildCartCtx`'s `ctx.fulfillment` accepts
 * (resolve-and-assemble.ts — `fulfillmentRaw === "pickup" || fulfillmentRaw
 * === "delivery"`) — a closed enum, same contract as payment methods above.
 */
export const ORDER_CHECKOUT_CREATE_DELIVERY_TYPES = [
  "pickup",
  "delivery",
] as const;

export type OrderCheckoutCreateDeliveryType =
  (typeof ORDER_CHECKOUT_CREATE_DELIVERY_TYPES)[number];

export const ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "order.checkout.create",
    fields: [
      {
        name: "payment_method",
        // Directive per FE-0.3's table (payment method is listed alongside
        // quantity/new status/note text): user/model-produced content the
        // runtime still adjudicates (`validatePaymentMethod`,
        // ORDERS_GUARD_REFS) before it can execute.
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          enum: [...ORDER_CHECKOUT_CREATE_PAYMENT_METHODS],
          description:
            "Forma de pagamento — EXATAMENTE um destes valores em inglês " +
            "(contrato fechado; o guard não normaliza): pix, card, cash. " +
            'Se o cliente disser "no pix"/"cartão"/"em dinheiro" (ou similar), ' +
            "inclua este campo — ex.: \"pago no pix\" => payment_method: \"pix\". " +
            "Omita APENAS se o cliente não mencionar uma forma de pagamento — " +
            "NUNCA escolha uma por conta própria.",
        },
        required: false,
      },
      {
        name: "delivery_type",
        // Directive — same posture as payment_method: model/user-produced
        // content the runtime still adjudicates (requireSlotsFilledForCheckout)
        // before it can execute.
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          enum: [...ORDER_CHECKOUT_CREATE_DELIVERY_TYPES],
          description:
            "Tipo de entrega — EXATAMENTE um destes valores em inglês " +
            "(contrato fechado; o guard não normaliza): pickup, delivery. " +
            'Se o cliente disser "retiro"/"buscar"/"entrega"/"manda pra casa" ' +
            '(ou similar), inclua este campo — ex.: "retiro no balcão" => ' +
            "delivery_type: \"pickup\". Omita APENAS se o cliente não mencionar " +
            "retirada ou entrega — NUNCA escolha um por conta própria.",
        },
        required: false,
      },
    ],
    example: {
      utterance:
        "quero fechar o pedido, vou pagar no pix, vou retirar no balcão",
      payload: { payment_method: "pix", delivery_type: "pickup" },
    },
  };

// Fail closed at import time: a schema that would leak cartId/pixDetails (or
// any other identifier / PII field) can never even be loaded onto the wire.
assertSoundExtractionSchema(ORDER_CHECKOUT_CREATE_EXTRACTION_SCHEMA);
