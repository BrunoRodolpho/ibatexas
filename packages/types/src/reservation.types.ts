// Reservation domain types, Zod schemas, and DTOs.
// All enums mirror the Prisma schema in packages/domain/prisma/schema.prisma.

import { z } from "zod"
import { MAX_PARTY_SIZE } from "./constants.js"

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum ReservationStatus {
  PENDING = "pending",
  CONFIRMED = "confirmed",
  SEATED = "seated",
  COMPLETED = "completed",
  CANCELLED = "cancelled",
  NO_SHOW = "no_show",
}

export enum TableLocation {
  INDOOR = "indoor",
  OUTDOOR = "outdoor",
  BAR = "bar",
  TERRACE = "terrace",
}

export enum SpecialRequestType {
  BIRTHDAY = "birthday",
  ANNIVERSARY = "anniversary",
  ALLERGY_WARNING = "allergy_warning",
  HIGHCHAIR = "highchair",
  WINDOW_SEAT = "window_seat",
  ACCESSIBLE = "accessible",
  OTHER = "other",
}

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

export const SpecialRequestSchema = z.object({
  type: z.nativeEnum(SpecialRequestType),
  notes: z.string().max(200).optional(),
})

export type SpecialRequest = z.infer<typeof SpecialRequestSchema>

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface TimeSlotDTO {
  id: string
  date: string          // ISO 8601 date: '2026-02-24'
  startTime: string     // '19:30'
  durationMinutes: number
  maxCovers: number
  reservedCovers: number
  availableCovers: number
}

export interface TableDTO {
  id: string
  number: string
  capacity: number
  location: TableLocation
  accessible: boolean
  active: boolean
}

export interface ReservationDTO {
  id: string
  displayId: number
  customerId: string
  partySize: number
  status: ReservationStatus
  specialRequests: SpecialRequest[]
  timeSlot: Pick<TimeSlotDTO, "id" | "date" | "startTime" | "durationMinutes">
  tableLocation: TableLocation | null   // derived from assigned tables
  confirmedAt: string | null
  checkedInAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WaitlistDTO {
  id: string
  customerId: string
  timeSlotId: string
  partySize: number
  position: number
  notifiedAt: string | null
  expiresAt: string
  createdAt: string
}

// ─── Tool I/O Schemas ─────────────────────────────────────────────────────────

// check_table_availability
export const CheckAvailabilityInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de data inválido. Use YYYY-MM-DD")
    .describe("Data no formato YYYY-MM-DD"),
  partySize: z
    .number()
    .int()
    .min(1)
    .max(MAX_PARTY_SIZE)
    .describe("Número de pessoas"),
  preferredTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe("Horário preferido HH:MM (opcional)"),
})

export type CheckAvailabilityInput = z.infer<typeof CheckAvailabilityInputSchema>

export interface AvailableSlot {
  timeSlotId: string
  date: string
  startTime: string
  durationMinutes: number
  availableCovers: number
  tableLocations: TableLocation[]   // locations with available capacity
}

export interface CheckAvailabilityOutput {
  slots: AvailableSlot[]
  message: string   // pt-BR summary for agent
}

// create_reservation
export const CreateReservationInputSchema = z.object({
  customerId: z.string().describe("ID do cliente (Medusa customer id)"),
  timeSlotId: z.string().describe("ID do horário retornado por check_table_availability"),
  partySize: z.number().int().min(1).max(MAX_PARTY_SIZE).describe("Número de pessoas"),
  specialRequests: z
    .array(SpecialRequestSchema)
    .optional()
    .default([])
    .describe("Solicitações especiais (aniversário, cadeirão, etc.)"),
})

export type CreateReservationInput = z.infer<typeof CreateReservationInputSchema>

export interface CreateReservationOutput {
  reservationId: string
  confirmed: boolean
  tableLocation: TableLocation | null
  dateTime: string   // ISO 8601 — '2026-02-24T19:30:00'
  partySize: number
  confirmationMessage: string   // pt-BR for agent/WhatsApp
}

// modify_reservation
export const ModifyReservationInputSchema = z.object({
  customerId: z.string(),
  reservationId: z.string().describe("ID da reserva a modificar"),
  newTimeSlotId: z.string().optional().describe("Novo horário (opcional)"),
  newPartySize: z.number().int().min(1).max(MAX_PARTY_SIZE).optional().describe("Novo número de pessoas"),
  specialRequests: z.array(SpecialRequestSchema).optional().describe("Novas solicitações especiais"),
})

export type ModifyReservationInput = z.infer<typeof ModifyReservationInputSchema>

export interface ModifyReservationOutput {
  success: boolean
  reservation: ReservationDTO | null
  message: string
}

// cancel_reservation
export const CancelReservationInputSchema = z.object({
  customerId: z.string(),
  reservationId: z.string().describe("ID da reserva a cancelar"),
  reason: z.string().max(200).optional().describe("Motivo do cancelamento"),
})

export type CancelReservationInput = z.infer<typeof CancelReservationInputSchema>

export interface CancelReservationOutput {
  success: boolean
  message: string
}

// get_my_reservations
export const GetMyReservationsInputSchema = z.object({
  customerId: z.string(),
  status: z.nativeEnum(ReservationStatus).optional().describe("Filtrar por status"),
  limit: z.number().int().min(1).max(50).optional().default(10),
})

export type GetMyReservationsInput = z.infer<typeof GetMyReservationsInputSchema>

export interface GetMyReservationsOutput {
  reservations: ReservationDTO[]
  total: number
}

// join_waitlist
export const JoinWaitlistInputSchema = z.object({
  customerId: z.string(),
  timeSlotId: z.string().describe("ID do horário esgotado"),
  partySize: z.number().int().min(1).max(MAX_PARTY_SIZE).describe("Número de pessoas"),
})

export type JoinWaitlistInput = z.infer<typeof JoinWaitlistInputSchema>

export interface JoinWaitlistOutput {
  waitlistId: string
  position: number
  message: string
}
