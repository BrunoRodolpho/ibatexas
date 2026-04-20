// Centralized action validator — single source of truth for what customer actions
// are allowed given order type, fulfillment status, payment status, and payment method.
//
// Implements decision matrix §4-6. Pure function — no IO, no side effects.

import type { OrderFulfillmentStatus } from "./order-status.js"
import type { PaymentStatus } from "./payment-status.js"
import type { PaymentMethod } from "./payment-status.js"
import type { OrderType } from "./order-type.js"

export type CustomerAction =
  | "cancel_order"
  | "amend_add_item"
  | "amend_remove_item"
  | "amend_update_qty"
  | "change_payment_method"
  | "retry_payment"
  | "regenerate_pix"
  | "add_notes"
  | "change_delivery_address"
  | "switch_order_type"

export interface ActionContext {
  fulfillmentStatus: OrderFulfillmentStatus
  paymentStatus?: PaymentStatus
  paymentMethod?: PaymentMethod
  orderType?: OrderType
  orderCreatedAt?: Date
  ponrMinutes?: number
  newPaymentMethod?: PaymentMethod
}

export type ActionResult =
  | { allowed: true }
  | { allowed: false; reason: string; escalate?: boolean }

const ALLOWED: ActionResult = { allowed: true }

function deny(reason: string, escalate = false): ActionResult {
  return { allowed: false, reason, escalate: escalate || undefined }
}

/** Check if order was created within PONR window */
function withinPonr(ctx: ActionContext): boolean {
  if (!ctx.orderCreatedAt || !ctx.ponrMinutes) return true // No PONR data = allow
  const elapsed = (Date.now() - ctx.orderCreatedAt.getTime()) / 60_000
  return elapsed <= ctx.ponrMinutes
}

/**
 * Validates whether a customer action is allowed given the current order/payment state.
 * Returns { allowed: true } or { allowed: false, reason, escalate? }.
 */
export function canPerformAction(action: CustomerAction, ctx: ActionContext): ActionResult {
  const fs = ctx.fulfillmentStatus
  const ps = ctx.paymentStatus

  switch (action) {
    // ── §4.1 Cancel Order ──────────────────────────────────────────────
    case "cancel_order": {
      if (fs === "canceled") return deny("Pedido já cancelado.")
      if (fs === "delivered") return deny("Pedido já entregue.")
      if (fs === "ready" || fs === "in_delivery") return deny("Pedido não pode mais ser cancelado.")
      if (fs === "preparing") return deny("Cozinha já está preparando. Entre em contato com o restaurante.", true)
      // pending or confirmed
      if (!withinPonr(ctx)) return deny("Prazo para cancelamento expirou. Entre em contato com o restaurante.", true)
      return ALLOWED
    }

    // ── §4.2 Add Item ──────────────────────────────────────────────────
    case "amend_add_item": {
      if (fs === "canceled") return deny("Pedido cancelado.")
      if (fs === "delivered") return deny("Pedido já entregue.")
      if (fs === "ready" || fs === "in_delivery") return deny("Pedido pronto — não pode adicionar itens.")
      // pending, confirmed, preparing — all allowed for adds
      return ALLOWED
    }

    // ── §4.3 Remove Item / Change Quantity ─────────────────────────────
    case "amend_remove_item":
    case "amend_update_qty": {
      if (fs === "canceled") return deny("Pedido cancelado.")
      if (fs === "delivered") return deny("Pedido já entregue.")
      if (fs === "ready" || fs === "in_delivery") return deny("Pedido pronto — não pode ser alterado.")
      if (fs === "preparing") return deny("Cozinha já está preparando. Um atendente foi notificado.", true)
      // pending or confirmed — check PONR
      if (!withinPonr(ctx)) return deny("Prazo para alteração expirou. Um atendente foi notificado.", true)
      return ALLOWED
    }

    // ── §4.4 Change Payment Method ─────────────────────────────────────
    case "change_payment_method": {
      if (!ps) return deny("Status de pagamento desconhecido.")
      const blocked: string[] = ["paid", "refunded", "canceled", "waived", "switching_method", "partially_refunded", "disputed"]
      if (blocked.includes(ps)) return deny("Pagamento já finalizado — não pode trocar método.")
      // Cash blocked for delivery
      if (ctx.newPaymentMethod === "cash" && ctx.orderType === "delivery") {
        return deny("Pagamento em dinheiro não disponível para entrega.")
      }
      return ALLOWED
    }

    // ── §4.5 Retry Payment ─────────────────────────────────────────────
    case "retry_payment": {
      if (!ps) return deny("Status de pagamento desconhecido.")
      const retryable: string[] = ["payment_failed", "payment_expired"]
      if (!retryable.includes(ps)) return deny("Pagamento não está em estado que permite nova tentativa.")
      return ALLOWED
    }

    // ── §4.6 Regenerate PIX ────────────────────────────────────────────
    case "regenerate_pix": {
      if (!ps) return deny("Status de pagamento desconhecido.")
      if (ctx.paymentMethod !== "pix") return deny("Regeneração disponível apenas para PIX.")
      if (ps !== "payment_expired") return deny("PIX só pode ser regenerado quando expirado.")
      return ALLOWED
    }

    // ── §4.7 Add Notes ─────────────────────────────────────────────────
    case "add_notes": {
      if (fs === "canceled") return deny("Pedido cancelado — não pode adicionar observações.")
      return ALLOWED
    }

    // ── §4.8 Change Delivery Address ───────────────────────────────────
    case "change_delivery_address": {
      if (ctx.orderType !== "delivery") return deny("Endereço de entrega não aplicável.")
      if (fs === "canceled") return deny("Pedido cancelado.")
      if (fs === "delivered") return deny("Pedido já entregue.")
      if (fs === "ready" || fs === "in_delivery") return deny("Pedido pronto — endereço não pode ser alterado.")
      if (fs === "preparing") return deny("Cozinha já está preparando. Entre em contato com o restaurante.", true)
      if (!withinPonr(ctx)) return deny("Prazo para alteração de endereço expirou.", true)
      return ALLOWED
    }

    // ── §4.9 Switch Order Type ─────────────────────────────────────────
    case "switch_order_type": {
      if (fs === "canceled") return deny("Pedido cancelado.")
      if (fs === "delivered") return deny("Pedido já entregue.")
      if (fs !== "pending") {
        if (fs === "confirmed") return deny("Pedido já confirmado. Entre em contato com o restaurante.", true)
        return deny("Tipo do pedido não pode ser alterado neste momento.")
      }
      if (!withinPonr(ctx)) return deny("Prazo para alteração expirou.", true)
      return ALLOWED
    }

    default:
      return deny("Ação não reconhecida.")
  }
}
