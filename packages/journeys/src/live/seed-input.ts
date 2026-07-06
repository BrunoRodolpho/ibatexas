// live/seed-input.ts — PURE input builders for the WS9 ops live suite's
// governed refundable-order seed. NO IO: given an amount, a run id and a
// display id, it returns the EXACT command-service inputs the executor then
// envelopes through the domain (`order.projection.create` + `payment.create`
// + `payment.status.transition`).
//
// This mirrors the production governed-seed recipe in
// apps/api/src/subscribers/cart-intelligence.ts (createOrderProjection /
// createPaymentRow): the SAME `*FromEnvelope` entry points on the domain
// command services, the SAME SYSTEM-actor taint. The seed is therefore
// audited + kernel-gated, never a raw money-table INSERT (WS9 governance bar).
//
// Split PURE-from-IO so these builders are cheap to unit-test with no DB /
// prisma / network (packages/journeys is coverage-excluded, but the shape of
// a money seed is worth pinning). The executor
// (live/seed-refundable-order.ts) owns the envelope construction + the actual
// service calls.
//
// pt-BR (CLAUDE.md rule #4): no user-facing strings here — structural tooling.

import type {
  CreateOrderProjectionInput,
  OrderProjectionCreatePayload,
  PaymentCreatePayload,
} from "@ibatexas/domain"

/**
 * Mirrors `@ibatexas/domain` ITEMS_SCHEMA_VERSION (medusa-order.mapper.ts:8).
 * Hard-copied (not imported) to keep this module free of a domain RUNTIME
 * import so the unit test loads no prisma client.
 */
export const WS9_ITEMS_SCHEMA_VERSION = 1

/** Payment methods the seed supports (subset of the domain's set). */
export type SeedPaymentMethod = "cash" | "pix" | "card"

export interface RefundableSeedOptions {
  /** The paid, refundable balance in centavos (CLAUDE.md rule #2). */
  readonly amountInCentavos: number
  /**
   * A unique-per-run token (the executor supplies e.g. `${Date.now()}-<rand>`).
   * Threads into the order id so re-runs never collide — the suite is
   * safe to run repeatedly.
   */
  readonly runId: string
  /**
   * The order's human display id. The executor picks a value in a dedicated
   * TEST BAND (>= 900000) so seeded orders never shadow real display ids.
   */
  readonly displayId: number
  /** Injectable clock (default `new Date()`); pinned in tests. */
  readonly now?: Date
  /**
   * Customer id for the projection. Default `null` — matches the 2026-07-04
   * live seeds (order_projections.customer_id is nullable, FK ON DELETE SET
   * NULL) and avoids needing a seeded customer row.
   */
  readonly customerId?: string | null
  /** Payment method. Default `cash` (cash_pending -> paid is a single hop). */
  readonly method?: SeedPaymentMethod
}

/**
 * The fully-resolved seed plan: everything the executor needs to build the
 * three system envelopes. Nothing here touches IO.
 */
export interface RefundableSeedPlan {
  readonly orderId: string
  readonly displayId: number
  readonly customerId: string | null
  readonly amountInCentavos: number
  readonly method: SeedPaymentMethod
  /** Payload for the `order.projection.create` envelope. */
  readonly orderProjectionPayload: OrderProjectionCreatePayload
  /** The `fullInput` closure arg `createFromEnvelope` takes alongside it. */
  readonly orderProjectionFullInput: CreateOrderProjectionInput
  /** Payload for the `payment.create` envelope. */
  readonly paymentCreatePayload: PaymentCreatePayload
  /**
   * The paid transition applied AFTER the payment row exists. `paymentId` is
   * only known post-create, so the executor fills it in; here we carry the
   * fixed parts (target status + SYSTEM actor).
   */
  readonly paidTransition: { readonly newStatus: "paid"; readonly actor: "system" }
}

/** The dedicated display-id band for WS9 seeds (keeps them off real orders). */
export const WS9_DISPLAY_ID_BASE = 900_000

/** A friendly, unmistakably-synthetic customer name stamped on seeds. */
export const WS9_SEED_CUSTOMER_NAME = "WS9 Ops Live Suite"

/**
 * Build the governed refundable-order seed plan.
 *
 * The plan drives an order to a PAID, refundable payment of exactly
 * `amountInCentavos`:
 *   1. `order.projection.create` (fulfillment pending, payment paid mirror)
 *   2. `payment.create` (method -> initial status cash_pending / awaiting)
 *   3. `payment.status.transition` -> paid (cash_pending -> paid is valid;
 *      types/payment-status.ts VALID_PAYMENT_TRANSITIONS)
 *
 * @throws if `amountInCentavos` is not a positive integer, or `displayId` is
 *         not a positive integer, or `runId` is empty.
 */
export function buildRefundableOrderSeed(
  opts: RefundableSeedOptions,
): RefundableSeedPlan {
  if (!Number.isInteger(opts.amountInCentavos) || opts.amountInCentavos <= 0) {
    throw new Error(
      `buildRefundableOrderSeed: amountInCentavos must be a positive integer (centavos), got ${String(opts.amountInCentavos)}`,
    )
  }
  if (!Number.isInteger(opts.displayId) || opts.displayId <= 0) {
    throw new Error(
      `buildRefundableOrderSeed: displayId must be a positive integer, got ${String(opts.displayId)}`,
    )
  }
  if (opts.runId.trim() === "") {
    throw new Error("buildRefundableOrderSeed: runId must be a non-empty token")
  }

  const now = opts.now ?? new Date()
  const method: SeedPaymentMethod = opts.method ?? "cash"
  const customerId = opts.customerId ?? null
  const amountInCentavos = opts.amountInCentavos
  const displayId = opts.displayId
  const orderId = `order_ws9_refund_${opts.runId}`

  const orderProjectionPayload: OrderProjectionCreatePayload = {
    orderId,
    displayId,
    customerId,
    fulfillmentStatus: "pending",
    paymentStatus: "paid",
    totalInCentavos: amountInCentavos,
  }

  const orderProjectionFullInput: CreateOrderProjectionInput = {
    id: orderId,
    displayId,
    customerId,
    customerEmail: null,
    customerName: WS9_SEED_CUSTOMER_NAME,
    customerPhone: null,
    fulfillmentStatus: "pending",
    paymentStatus: "paid",
    totalInCentavos: amountInCentavos,
    subtotalInCentavos: amountInCentavos,
    shippingInCentavos: 0,
    itemCount: 1,
    itemsJson: [
      {
        productId: "ws9-seed",
        variantId: "ws9-seed",
        title: "WS9 ops live suite seed item",
        quantity: 1,
        priceInCentavos: amountInCentavos,
      },
    ],
    itemsSchemaVersion: WS9_ITEMS_SCHEMA_VERSION,
    shippingAddressJson: null,
    deliveryType: "pickup",
    paymentMethod: method,
    tipInCentavos: 0,
    medusaCreatedAt: now,
  }

  const paymentCreatePayload: PaymentCreatePayload = {
    orderId,
    method,
    amountInCentavos,
  }

  return {
    orderId,
    displayId,
    customerId,
    amountInCentavos,
    method,
    orderProjectionPayload,
    orderProjectionFullInput,
    paymentCreatePayload,
    paidTransition: { newStatus: "paid", actor: "system" },
  }
}
