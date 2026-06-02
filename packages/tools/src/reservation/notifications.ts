// WhatsApp notifications for reservations.
// Uses the WhatsAppSender interface injected at startup from apps/api.

import type { ReservationDTO, WaitlistDTO } from "@ibatexas/types"
import { getWhatsAppSender } from "../whatsapp/sender.js"
import { locationLabel, formatDateBR } from "./utils.js"
import { toolLog } from "../logger.js"

const log = toolLog("tools:reservation")

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
    // LGPD: never log the raw phone — presence boolean + internal id only.
    log.warn({
      event: "whatsapp_stub",
      kind: "reservation_confirmation",
      reservationId: reservation.id,
      customerId: reservation.customerId,
      phone_present: !!phone,
      message,
    }, "WhatsApp confirmation (sender not configured)")
    return
  }

  if (!phone) {
    log.warn({
      event: "whatsapp_no_phone",
      kind: "reservation_confirmation",
      reservationId: reservation.id,
    }, "No phone number for reservation confirmation")
    return
  }

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    log.error({
      event: "whatsapp_send_failed",
      kind: "reservation_confirmation",
      reservationId: reservation.id,
      err: String(err),
    }, "Reservation confirmation failed")
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
    log.warn({ event: "whatsapp_stub", kind: "reservation_modified", reservationId: reservation.id, customerId: reservation.customerId, phone_present: !!phone, message }, "WhatsApp reservation-modified (sender not configured)")
    return
  }
  if (!phone) return

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    log.error({ event: "whatsapp_send_failed", kind: "reservation_modified", reservationId: reservation.id, err: String(err) }, "Reservation modified notification failed")
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
    log.warn({ event: "whatsapp_stub", kind: "reservation_cancelled", reservationId, phone_present: !!phone, message }, "WhatsApp reservation-cancelled (sender not configured)")
    return
  }
  if (!phone) return

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    log.error({ event: "whatsapp_send_failed", kind: "reservation_cancelled", reservationId, err: String(err) }, "Reservation cancelled notification failed")
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
    log.warn({ event: "whatsapp_stub", kind: "reservation_reminder", reservationId: reservation.id, customerId: reservation.customerId, phone_present: !!phone, message }, "WhatsApp reservation-reminder (sender not configured)")
    return
  }
  if (!phone) return

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    log.error({ event: "whatsapp_send_failed", kind: "reservation_reminder", reservationId: reservation.id, err: String(err) }, "Reservation reminder failed")
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
    log.warn({
      event: "whatsapp_stub",
      kind: "waitlist_notification",
      waitlistId: waitlist.id,
      customerId: waitlist.customerId,
      phone_present: !!phone,
      message,
    }, "WhatsApp waitlist-notification (sender not configured)")
    return
  }

  if (!phone) {
    log.warn({
      event: "whatsapp_no_phone",
      kind: "waitlist_notification",
      waitlistId: waitlist.id,
    }, "No phone number for waitlist notification")
    return
  }

  try {
    await sender.sendText(`whatsapp:${phone}`, message)
  } catch (err) {
    log.error({
      event: "whatsapp_send_failed",
      kind: "waitlist_notification",
      waitlistId: waitlist.id,
      err: String(err),
    }, "Waitlist notification failed")
  }
}
