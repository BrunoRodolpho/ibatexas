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

// apply_coupon
export const ApplyCouponInputSchema = z.object({
  cartId: z.string(),
  code: z.string().describe("Código do cupom ou promoção"),
})

export type ApplyCouponInput = z.infer<typeof ApplyCouponInputSchema>

// get_order_history
export const GetOrderHistoryInputSchema = z.strictObject({})

export type GetOrderHistoryInput = z.infer<typeof GetOrderHistoryInputSchema>
