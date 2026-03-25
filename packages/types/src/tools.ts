// Catalog tool types and Zod schemas (tools that don't belong to a specific domain).

import { z } from "zod"

// ─── check_inventory ─────────────────────────────────────────────────────────

export const CheckInventoryInputSchema = z.object({
  variantId: z.string().describe("ID da variante do produto"),
})

export type CheckInventoryInput = z.infer<typeof CheckInventoryInputSchema>

export interface CheckInventoryOutput {
  available: boolean
  quantity: number
  nextAvailableAt: string | null
}

// ─── get_nutritional_info ────────────────────────────────────────────────────

export interface NutritionalInfo {
  per100g: {
    calories: number
    protein: number
    fat: number
    saturatedFat: number
    carbs: number
    sugars: number
    fiber: number
    sodium: number
  }
  servingSize: string
  servingsPerPackage: number
}

export const GetNutritionalInfoInputSchema = z.object({
  productId: z.string(),
})

export type GetNutritionalInfoInput = z.infer<typeof GetNutritionalInfoInputSchema>

export type GetNutritionalInfoOutput = NutritionalInfo | null

// ─── schedule_follow_up ──────────────────────────────────────────────────────

export const ScheduleFollowUpInputSchema = z.object({
  delayHours: z.number().min(1).max(72).describe("Horas até o lembrete (min 1, max 72)"),
  reason: z.string().describe("Motivo: 'thinking', 'cart_save', 'price_concern'"),
})

export type ScheduleFollowUpInput = z.infer<typeof ScheduleFollowUpInputSchema>

// ─── handoff_to_human ───────────────────────────────────────────────────────

export const HandoffToHumanInputSchema = z.object({
  sessionId: z.string().describe("ID da sessão de atendimento"),
  reason: z.string().optional().describe("Motivo da transferência para atendente humano"),
})

export type HandoffToHumanInput = z.infer<typeof HandoffToHumanInputSchema>

export interface HandoffToHumanOutput {
  success: boolean
  estimatedWaitMinutes?: number
  message: string
}
