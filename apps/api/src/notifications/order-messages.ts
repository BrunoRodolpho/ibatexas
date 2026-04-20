// Order status change notification messages (pt-BR)
// Used by the order.status_changed NATS subscriber to send WhatsApp updates.

import { formatOrderId } from "@ibatexas/types"

const STATUS_MESSAGES: Record<string, (displayId: number) => string> = {
  confirmed: (id) =>
    `✅ Seu pedido ${formatOrderId(id)} foi confirmado! Estamos preparando com carinho.`,
  preparing: (id) =>
    `👨‍🍳 Pedido ${formatOrderId(id)} esta sendo preparado! Em breve estara pronto.`,
  ready: (id) =>
    `📦 Pedido ${formatOrderId(id)} esta pronto! Aguardando retirada ou saindo para entrega.`,
  in_delivery: (id) =>
    `🚗 Pedido ${formatOrderId(id)} saiu para entrega! Fique atento.`,
  delivered: (id) =>
    `🎉 Pedido ${formatOrderId(id)} foi entregue! Obrigado pela preferencia. Avalie sua experiencia!`,
  canceled: (id) =>
    `Pedido ${formatOrderId(id)} foi cancelado. Se precisar de ajuda, fale conosco.`,
}

/**
 * Build a pt-BR WhatsApp message for an order status transition.
 * Returns empty string for non-notifiable statuses (pending, canceled).
 */
export function buildOrderStatusMessage(displayId: number, status: string): string {
  const builder = STATUS_MESSAGES[status]
  return builder ? builder(displayId) : ""
}

/**
 * Build a pt-BR WhatsApp confirmation message for a newly placed order.
 * Separate from STATUS_MESSAGES because order.placed is the initial event, not a status transition.
 */
export function buildOrderReceivedMessage(displayId: number): string {
  return `🔥 Pedido ${formatOrderId(displayId)} recebido! Em breve vamos confirmar e começar a preparar. Acompanhe por aqui.`
}
