// WhatsApp notification stubs for reservations.
// TODO: Step 12 — replace with Twilio WhatsApp API calls.

import type { ReservationDTO, WaitlistDTO } from "@ibatexas/types"
import { locationLabel, formatDateBR } from "./utils.js"

const APP_BASE_URL = process.env.APP_BASE_URL || "https://ibatexas.com.br"

/**
 * Send a reservation confirmation via WhatsApp.
 * Stub: logs to console. Step 12 will replace with Twilio Messages API.
 */
export async function sendReservationConfirmation(
  reservation: ReservationDTO,
  phone?: string,
): Promise<void> {
  // Append T12:00:00Z to avoid UTC midnight → previous-day-in-São-Paulo issue
  const dateStr = formatDateBR(new Date(reservation.timeSlot.date + "T12:00:00Z"))
  const location = locationLabel(reservation.tableLocation)

  const message = [
    `✅ *Reserva confirmada — IbateXas*`,
    ``,
    `📅 ${dateStr}`,
    `🕕 ${reservation.timeSlot.startTime}`,
    `👥 ${reservation.partySize} pessoa${reservation.partySize > 1 ? "s" : ""}`,
    `📍 ${location}`,
    ``,
    `ID: ${reservation.id}`,
    ``,
    `Para cancelar ou modificar acesse: ${APP_BASE_URL}/conta/reservas`,
  ].join("\n")

  // TODO: Step 12 — Twilio WhatsApp API
  console.info("[WhatsApp stub] Reservation confirmation:", {
    to: phone ?? reservation.customerId,
    message,
  })
}

/**
 * Notify a waitlist customer that a spot has opened.
 * Stub: logs to console. Step 12 will replace with Twilio Messages API.
 */
export async function notifyWaitlistSpotAvailable(
  waitlist: WaitlistDTO,
  date: string,
  startTime: string,
  phone?: string,
): Promise<void> {
  const dateStr = formatDateBR(new Date(date + "T12:00:00Z"))

  const message = [
    `🎉 *IbateXas — Vaga disponível!*`,
    ``,
    `Uma vaga abriu para:`,
    `📅 ${dateStr} às ${startTime}`,
    `👥 ${waitlist.partySize} pessoa${waitlist.partySize > 1 ? "s" : ""}`,
    ``,
    `Você tem 30 minutos para confirmar sua reserva:`,
    `${APP_BASE_URL}/conta/reservas`,
    ``,
    `Após esse prazo, a vaga será oferecida ao próximo da fila.`,
  ].join("\n")

  // TODO: Step 12 — Twilio WhatsApp API
  console.info("[WhatsApp stub] Waitlist notification:", {
    to: phone ?? waitlist.customerId,
    message,
  })
}
