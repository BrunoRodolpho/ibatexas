// Staff types and DTOs for the staff/admin domain

import { z } from "zod"

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum StaffRole {
  OWNER = "OWNER",
  MANAGER = "MANAGER",
  ATTENDANT = "ATTENDANT",
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface StaffDTO {
  id: string
  phone: string
  name: string
  role: StaffRole
  active: boolean
}

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

export const StaffSendOtpBody = z.object({
  phone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "Telefone inválido — use formato internacional: +5511999999999"),
})

export const StaffVerifyOtpBody = z.object({
  phone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "Telefone inválido — use formato internacional: +5511999999999"),
  code: z.string().regex(/^\d{6}$/, "Código inválido — deve ter 6 dígitos"),
})

export type StaffSendOtpInput = z.infer<typeof StaffSendOtpBody>
export type StaffVerifyOtpInput = z.infer<typeof StaffVerifyOtpBody>
