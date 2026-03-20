// Intelligence domain types and Zod schemas.
// Mirrors the pattern in reservation.types.ts.

import { z } from "zod"

// ─── Tool I/O Schemas ─────────────────────────────────────────────────────────

// get_customer_profile
export const GetCustomerProfileInputSchema = z.strictObject({})

export type GetCustomerProfileInput = z.infer<typeof GetCustomerProfileInputSchema>

// get_ordered_together
export const GetOrderedTogetherInputSchema = z.object({
  productId: z.string().describe("ID do produto principal"),
})

export type GetOrderedTogetherInput = z.infer<typeof GetOrderedTogetherInputSchema>

// submit_review
export const SubmitReviewInputSchema = z.object({
  productId: z.string().describe("ID do produto avaliado"),
  orderId: z.string().describe("ID do pedido ao qual o produto pertence"),
  rating: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("Nota de 1 a 5 estrelas"),
  comment: z.string().max(1000).optional().describe("Comentário opcional"),
})

export type SubmitReviewInput = z.infer<typeof SubmitReviewInputSchema>

// update_preferences
// Note: allergens must always be an explicit array — never inferred (CLAUDE.md hard rule).
export const UpdatePreferencesInputSchema = z.object({
  dietaryRestrictions: z
    .array(z.string())
    .optional()
    .describe("Ex: ['vegetariano', 'sem glúten']"),
  allergenExclusions: z
    .array(z.string())
    .optional()
    .describe("Lista ANVISA: gluten, lactose, castanhas, amendoim, ovos, peixes, frutos_do_mar, soja"),
  favoriteCategories: z
    .array(z.string())
    .optional()
    .describe("Handles de categoria, ex: ['churrasco', 'grelhados']"),
})

export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesInputSchema>

// get_also_added
export const GetAlsoAddedInputSchema = z.object({
  productId: z.string().describe("ID do produto principal"),
  limit: z.number().int().min(1).max(20).optional().describe("Número de sugestões (padrão: 6)"),
})

export type GetAlsoAddedInput = z.infer<typeof GetAlsoAddedInputSchema>
