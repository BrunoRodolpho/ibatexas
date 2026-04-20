// Cart domain types and Zod schemas.
// Mirrors the pattern in reservation.types.ts.

import { z } from "zod"

// ─── Tool I/O Schemas ─────────────────────────────────────────────────────────

// add_to_cart
export const AddToCartInputSchema = z.object({
  cartId: z.string().describe("ID do carrinho"),
  variantId: z.string().describe("ID da variante do produto"),
  quantity: z.number().int().min(1).describe("Quantidade a adicionar (mínimo 1)"),
})

export type AddToCartInput = z.infer<typeof AddToCartInputSchema>

// cancel_order
export const CancelOrderInputSchema = z.object({
  orderId: z.string().describe("ID do pedido a cancelar"),
})

export type CancelOrderInput = z.infer<typeof CancelOrderInputSchema>

// cancel_item (individual item cancellation)
export const CancelItemInputSchema = z.object({
  orderId: z.string().describe("ID do pedido"),
  itemTitle: z.string().describe("Nome do item a cancelar"),
})

export type CancelItemInput = z.infer<typeof CancelItemInputSchema>

// amend_order
export const AmendOrderInputSchema = z.object({
  orderId: z.string().describe("ID do pedido"),
  action: z.enum(["add", "remove", "update_qty", "change_payment"]).describe("Ação: add (adicionar item), remove (remover item), update_qty (alterar quantidade), change_payment (trocar forma de pagamento)"),
  variantId: z.string().optional().describe("ID da variante (obrigatório para add)"),
  itemTitle: z.string().optional().describe("Nome do item (para remove/update_qty)"),
  quantity: z.number().int().min(1).optional().describe("Quantidade (para add e update_qty)"),
  paymentMethod: z.enum(["pix", "card", "cash"]).optional().describe("Novo método de pagamento (obrigatório para change_payment)"),
})

export type AmendOrderInput = z.infer<typeof AmendOrderInputSchema>

export interface AmendOrderResult {
  success: boolean
  message: string
  needsEscalation?: boolean
  /** New PIX copia-e-cola code (set when amendment changed total on a PIX order) */
  newPixQrCodeText?: string
  /** New PIX QR code SVG URL */
  newPixQrCodeUrl?: string
  /** Stripe PaymentIntent client secret (set when payment method changed to card) */
  stripeClientSecret?: string | null
}

// check_order_status
export const CheckOrderStatusInputSchema = z.object({
  orderId: z.string().describe("ID do pedido"),
})

export type CheckOrderStatusInput = z.infer<typeof CheckOrderStatusInputSchema>

// create_checkout
export const CreateCheckoutInputSchema = z.object({
  cartId: z.string().describe("ID do carrinho"),
  paymentMethod: z
    .enum(["pix", "card", "cash"])
    .describe("Método de pagamento: pix, card (cartão) ou cash (dinheiro na entrega)"),
  tipInCentavos: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Gorjeta em centavos (opcional). Ex: 1000 = R$10,00"),
  deliveryCep: z
    .string()
    .optional()
    .describe("CEP de entrega (obrigatório para delivery)"),
})

export type CreateCheckoutInput = z.infer<typeof CreateCheckoutInputSchema>

// get_cart
export const GetCartInputSchema = z.object({
  cartId: z.string().describe("ID do carrinho Medusa"),
})

export type GetCartInput = z.infer<typeof GetCartInputSchema>

// update_cart
export const UpdateCartInputSchema = z.object({
  cartId: z.string(),
  itemId: z.string().describe("ID do item no carrinho (line item ID)"),
  quantity: z.number().int().min(1).describe("Nova quantidade"),
})

export type UpdateCartInput = z.infer<typeof UpdateCartInputSchema>

// remove_from_cart
export const RemoveFromCartInputSchema = z.object({
  cartId: z.string(),
  itemId: z.string().describe("ID do item no carrinho"),
})

export type RemoveFromCartInput = z.infer<typeof RemoveFromCartInputSchema>

// reorder
export const ReorderInputSchema = z.object({
  orderId: z.string().describe("ID do pedido anterior"),
})

export type ReorderInput = z.infer<typeof ReorderInputSchema>

// get_or_create_cart
export const GetOrCreateCartInputSchema = z.strictObject({})

export type GetOrCreateCartInput = z.infer<typeof GetOrCreateCartInputSchema>

// apply_coupon
export const ApplyCouponInputSchema = z.object({
  cartId: z.string(),
  code: z.string().describe("Código do cupom ou promoção"),
})

export type ApplyCouponInput = z.infer<typeof ApplyCouponInputSchema>

// get_order_history
export const GetOrderHistoryInputSchema = z.strictObject({})

export type GetOrderHistoryInput = z.infer<typeof GetOrderHistoryInputSchema>

// regenerate_pix
export const RegeneratePixInputSchema = z.object({
  orderId: z.string().describe("ID do pedido"),
})

export type RegeneratePixInput = z.infer<typeof RegeneratePixInputSchema>
