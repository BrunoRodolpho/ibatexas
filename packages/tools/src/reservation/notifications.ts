// WhatsApp notifications for reservations.
// Uses the WhatsAppSender interface injected at startup from apps/api.

import type { ReservationDTO, WaitlistDTO } from "@ibatexas/types"
import { locationLabel, formatDateBR } from "./utils.js"
import { getWhatsAppSender } from "../whatsapp/sender.js"

const APP_BASE_URL = process.env.APP_BASE_URL || "https://ibatexas.com.br"

/**
 * Send a reservation confirmation via WhatsApp.
 * Falls back to console log if WhatsApp sender is not configured.
 */
export async function sendReservationConfirmation(
  reservation: ReservationDTO,
  phone?: string,
): Promise<void> {
  // Append T12:00:00Z to avoid UTC midnight → previous-day-in-São-Paulo issue
  const dateStr = formatDateBR(new Date(`${reservation.timeSlot.date}T12:00:00Z`))
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

  const sender = getWhatsAppSender()
  if (!sender) {
    console.info("[whatsapp.stub] Reservation confirmation:", {
      to: phone ?? reservation.customerId,
      message,
    })
    return
  }

  if (!phone) {
    console.warn("[whatsapp.notification] No phone number for reservation confirmation:", reservation.id)
    return
  }

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    console.error("[whatsapp.notification.error] Reservation confirmation failed:", {
      reservationId: reservation.id,
      error: String(err),
    })
  }
}

/**
 * Notify customer their reservation was modified.
 */
export async function sendReservationModified(
  reservation: ReservationDTO,
  phone?: string,
): Promise<void> {
  const dateStr = formatDateBR(new Date(`${reservation.timeSlot.date}T12:00:00Z`))
  const location = locationLabel(reservation.tableLocation)

  const message = [
    `📝 *Reserva atualizada — IbateXas*`,
    ``,
    `📅 ${dateStr}`,
    `🕕 ${reservation.timeSlot.startTime}`,
    `👥 ${reservation.partySize} pessoa${reservation.partySize > 1 ? "s" : ""}`,
    `📍 ${location}`,
    ``,
    `ID: ${reservation.id}`,
  ].join("\n")

  const sender = getWhatsAppSender()
  if (!sender) {
    console.info("[whatsapp.stub] Reservation modified:", { to: phone ?? reservation.customerId, message })
    return
  }
  if (!phone) return

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    console.error("[whatsapp.notification.error] Reservation modified notification failed:", { reservationId: reservation.id, error: String(err) })
  }
}

/**
 * Notify customer their reservation was cancelled.
 */
export async function sendReservationCancelled(
  reservationId: string,
  date: string,
  startTime: string,
  phone?: string,
): Promise<void> {
  const dateStr = formatDateBR(new Date(`${date}T12:00:00Z`))

  const message = [
    `❌ *Reserva cancelada — IbateXas*`,
    ``,
    `Sua reserva para ${dateStr} às ${startTime} foi cancelada.`,
    ``,
    `Para fazer uma nova reserva: ${APP_BASE_URL}/conta/reservas`,
  ].join("\n")

  const sender = getWhatsAppSender()
  if (!sender) {
    console.info("[whatsapp.stub] Reservation cancelled:", { to: phone ?? reservationId, message })
    return
  }
  if (!phone) return

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    console.error("[whatsapp.notification.error] Reservation cancelled notification failed:", { reservationId, error: String(err) })
  }
}

/**
 * Send a day-of reminder for a confirmed reservation.
 */
export async function sendReservationReminder(
  reservation: ReservationDTO,
  phone?: string,
): Promise<void> {
  const location = locationLabel(reservation.tableLocation)

  const message = [
    `⏰ *Lembrete — IbateXas*`,
    ``,
    `Sua reserva é hoje às ${reservation.timeSlot.startTime}!`,
    `👥 ${reservation.partySize} pessoa${reservation.partySize > 1 ? "s" : ""}`,
    `📍 ${location}`,
    ``,
    `Te esperamos! 🔥🥩`,
  ].join("\n")

  const sender = getWhatsAppSender()
  if (!sender) {
    console.info("[whatsapp.stub] Reservation reminder:", { to: phone ?? reservation.customerId, message })
    return
  }
  if (!phone) return

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    console.error("[whatsapp.notification.error] Reservation reminder failed:", { reservationId: reservation.id, error: String(err) })
  }
}

/**
 * Notify a waitlist customer that a spot has opened.
 * Falls back to console log if WhatsApp sender is not configured.
 */
export async function notifyWaitlistSpotAvailable(
  waitlist: WaitlistDTO,
  date: string,
  startTime: string,
  phone?: string,
): Promise<void> {
  const dateStr = formatDateBR(new Date(`${date}T12:00:00Z`))

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

  const sender = getWhatsAppSender()
  if (!sender) {
    console.info("[whatsapp.stub] Waitlist notification:", {
      to: phone ?? waitlist.customerId,
      message,
    })
    return
  }

  if (!phone) {
    console.warn("[whatsapp.notification] No phone number for waitlist notification:", waitlist.id)
    return
  }

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    console.error("[whatsapp.notification.error] Waitlist notification failed:", {
      waitlistId: waitlist.id,
      error: String(err),
    })
  }
}
