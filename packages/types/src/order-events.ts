// Typed event contracts for order-related NATS events.
// These replace the untyped Record<string, unknown> payloads throughout the system.
//
// INVARIANT: OrderStatusChangedEvent.version is REQUIRED at every publish site.
// No event without version is allowed past the command layer.

import type { OrderFulfillmentStatus } from "./order-status.js"

// ── Shared ──────────────────────────────────────────────────────────────────

/** Denormalized line item included in order events. */
export interface OrderEventItem {
  productId: string
  variantId: string
  title: string
  quantity: number
  priceInCentavos: number
  /** Product type — determines amendment rules (food locked during preparing). */
  productType?: "food" | "frozen" | "merchandise"
}

/** Actor who triggered a state transition. */
export type OrderActor = "admin" | "system" | "system_backfill" | "customer"

// ── Domain Events (NATS subject: ibatexas.order.*) ──────────────────────────

export interface OrderPlacedEvent {
  orderId: string
  displayId: number
  customerId: string | null
  items: OrderEventItem[]
  totalInCentavos: number
  subtotalInCentavos: number
  shippingInCentavos: number
  customerEmail?: string
  customerName?: string
  customerPhone?: string
  shippingAddress?: {
    address_1?: string
    city?: string
    postal_code?: string
  }
  stripePaymentIntentId?: string
  paymentMethod: "pix" | "card" | "cash"
  paymentStatus?: string
  deliveryType?: string
  tipInCentavos?: number
  version: number
  timestamp: string
}

export interface OrderStatusChangedEvent {
  orderId: string
  displayId: number
  previousStatus: OrderFulfillmentStatus
  newStatus: OrderFulfillmentStatus
  customerId: string | null
  updatedBy: OrderActor
  /** Projection version AFTER this transition. REQUIRED — never omit. */
  version: number
  /** Correlation ID for end-to-end tracing (typically x-request-id). */
  correlationId?: string
  timestamp: string
}

export interface OrderCanceledEvent {
  orderId: string
  displayId: number
  customerId: string | null
  reason?: string
  canceledBy: OrderActor
  timestamp: string
}

export interface OrderRefundedEvent {
  orderId: string
  chargeId: string
  amountInCentavos: number
  timestamp: string
}

export interface OrderDisputedEvent {
  orderId: string
  disputeId: string
  amount: number
  reason: string
  timestamp: string
}

export interface OrderPaymentFailedEvent {
  orderId: string
  stripePaymentIntentId: string
  lastPaymentError?: string
  timestamp: string
}

// ── Payment Events (NATS subject: ibatexas.payment.*) ──────────────────

export interface PaymentStatusChangedEvent {
  orderId: string
  paymentId: string
  previousStatus: string
  newStatus: string
  method: string // "pix" | "card" | "cash"
  version: number
  stripeEventId?: string
  timestamp: string
}

export interface PaymentMethodChangedEvent {
  orderId: string
  paymentId: string
  previousMethod: string
  newMethod: string
  timestamp: string
}

// ── Order Amendment & Notes Events ─────────────────────────────────

export interface OrderAmendChange {
  type: "add" | "remove" | "update_qty"
  itemId?: string
  itemTitle: string
  productId?: string
  variantId?: string
  previousQty?: number
  newQty?: number
}

export interface OrderAmendedEvent {
  orderId: string
  /** @deprecated Use `changes` array instead. */
  action?: "add" | "remove" | "update_qty"
  changes: OrderAmendChange[]
  items: Array<{ title: string; quantity: number }>
  totalBeforeInCentavos: number
  totalAfterInCentavos: number
  timestamp: string
}

export interface OrderNoteAddedEvent {
  orderId: string
  noteId: string
  author: OrderActor
  timestamp: string
}

// ── Internal Events ─────────────────────────────────────────────────────────

export interface NotificationSendEvent {
  type: string
  customerId?: string
  sessionId?: string
  cartId?: string
  channel?: "whatsapp"
  body?: string
  message?: string
  /** Distinguishes customer vs staff notifications. */
  targetType?: "customer" | "staff"
}
