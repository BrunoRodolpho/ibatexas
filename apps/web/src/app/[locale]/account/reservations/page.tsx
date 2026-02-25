"use client"

import { useEffect, useCallback } from "react"
import { Link } from '@/i18n/navigation'
import { useTranslations } from "next-intl"
import { useSessionStore } from "@/stores"
import { useReservationStore } from "@/stores/useReservationStore"
import type { ReservationDTO } from "@ibatexas/types"

import { DatePicker } from "./_components/DatePicker"
import { PartySizeSelector } from "./_components/PartySizeSelector"
import { TimeslotGrid } from "./_components/TimeslotGrid"
import { SpecialRequestsForm } from "./_components/SpecialRequestsForm"
import { ReservationConfirmation } from "./_components/ReservationConfirmation"
import { MyReservations } from "./_components/MyReservations"

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"

export default function ReservationsPage() {
  const t = useTranslations()
  const { customerId } = useSessionStore()

  const {
    step,
    selectedDate,
    partySize,
    selectedSlot,
    specialRequests,
    availableSlots,
    loadingSlots,
    slotsError,
    createdReservation,
    creating,
    createError,
    myReservations,
    loadingMyReservations,
    setDate,
    setPartySize,
    setStep,
    setAvailableSlots,
    selectSlot,
    setSpecialRequests,
    setCreatedReservation,
    setCreating,
    setCreateError,
    setMyReservations,
    reset,
  } = useReservationStore()

  // ── Fetch availability ─────────────────────────────────────────────────────

  const fetchAvailability = useCallback(async () => {
    if (!selectedDate || partySize < 1) return

    setAvailableSlots([], true, null)
    setStep("timeslot")

    try {
      const res = await fetch(
        `${API}/api/reservations/availability?date=${selectedDate}&partySize=${partySize}`,
      )
      if (!res.ok) throw new Error("Erro ao buscar disponibilidade.")
      const data = await res.json()
      setAvailableSlots(data.slots ?? [], false, null)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido."
      setAvailableSlots([], false, msg)
    }
  }, [selectedDate, partySize, setAvailableSlots, setStep])

  // ── Fetch my reservations ──────────────────────────────────────────────────

  const fetchMyReservations = useCallback(async () => {
    if (!customerId) return

    setMyReservations([], true)

    try {
      const res = await fetch(`${API}/api/reservations?customerId=${customerId}&limit=20`)
      if (!res.ok) throw new Error("Erro ao carregar reservas.")
      const data = await res.json()
      setMyReservations(data.reservations ?? [], false)
    } catch {
      setMyReservations([], false)
    }
  }, [customerId, setMyReservations])

  useEffect(() => {
    if (customerId) fetchMyReservations()
  }, [customerId, fetchMyReservations])

  // ── Submit reservation ─────────────────────────────────────────────────────

  const submitReservation = async () => {
    if (!selectedSlot || !customerId) return

    setCreating(true)
    setCreateError(null)

    try {
      const res = await fetch(`${API}/api/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId,
          timeSlotId: selectedSlot.timeSlotId,
          partySize,
          specialRequests,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.message ?? "Erro ao criar reserva.")
      }

      const data = await res.json()
      setCreatedReservation(data)
      setStep("confirmation")
      fetchMyReservations()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido."
      setCreateError(msg)
    } finally {
      setCreating(false)
    }
  }

  // ── Cancel reservation ─────────────────────────────────────────────────────

  const cancelReservation = async (reservationId: string) => {
    if (!customerId || !confirm("Confirmar cancelamento desta reserva?")) return

    try {
      const res = await fetch(`${API}/api/reservations/${reservationId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId }),
      })

      if (!res.ok) {
        const data = await res.json()
        alert(data.message ?? "Erro ao cancelar reserva.")
        return
      }

      fetchMyReservations()
    } catch {
      alert("Erro ao cancelar reserva. Tente novamente.")
    }
  }

  const handleModify = (reservation: ReservationDTO) => {
    setDate(reservation.timeSlot.date)
    setPartySize(reservation.partySize)
    setSpecialRequests(reservation.specialRequests as { type: string; notes?: string }[])
    setStep("date-party")
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  // ── Auth guard ─────────────────────────────────────────────────────────────

  if (!customerId) {
    return (
      <div className="mx-auto max-w-md px-4 py-12 text-center sm:px-6">
        <div className="mb-6 text-4xl">🍽️</div>
        <h1 className="text-3xl font-bold text-gray-900">{t("reservations.title")}</h1>
        <p className="mt-4 text-gray-600">{t("reservations.login_required")}</p>
        <button className="mt-8 w-full rounded-lg bg-orange-600 px-6 py-3 font-medium text-white hover:bg-orange-700">
          {t("checkout.login_button")}
        </button>
        <p className="mt-6">
          <Link href={"/search"} className="text-orange-600 hover:text-orange-700">
            {t("cart.continue_shopping")} →
          </Link>
        </p>
      </div>
    )
  }

  // ── Confirmation screen ────────────────────────────────────────────────────

  if (step === "confirmation" && createdReservation) {
    return (
      <div className="mx-auto max-w-lg px-4 py-12 sm:px-6">
        <ReservationConfirmation
          reservation={createdReservation}
          onMakeAnother={() => { reset(); fetchMyReservations() }}
        />
      </div>
    )
  }

  // ── Main flow ──────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">

      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">{t("reservations.title")}</h1>
      </div>

      {/* Step back indicator */}
      {step !== "date-party" && (
        <div className="mb-6 flex items-center gap-2 text-sm text-gray-500">
          <button
            onClick={() => setStep("date-party")}
            className="text-orange-600 hover:text-orange-700"
          >
            ← Voltar
          </button>
          <span>·</span>
          <span className="text-gray-400">
            {step === "timeslot" && "Escolher horário"}
            {step === "requests" && "Solicitações especiais"}
          </span>
        </div>
      )}

      {/* ── Step 1: Date + Party size ─────────────────────────────────────── */}
      {step === "date-party" && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-6 text-lg font-semibold text-gray-900">
            🗓️ Nova reserva
          </h2>

          <div className="space-y-6">
            <DatePicker value={selectedDate} onChange={setDate} />
            <PartySizeSelector value={partySize} onChange={setPartySize} />
          </div>

          <button
            type="button"
            disabled={!selectedDate}
            onClick={fetchAvailability}
            className="mt-8 w-full rounded-lg bg-orange-600 px-6 py-3 font-medium text-white hover:bg-orange-700 disabled:opacity-50"
          >
            Ver horários disponíveis →
          </button>
        </div>
      )}

      {/* ── Step 2: Pick time slot ────────────────────────────────────────── */}
      {step === "timeslot" && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-6 text-lg font-semibold text-gray-900">
            🕕 Horários disponíveis para {partySize} {partySize === 1 ? "pessoa" : "pessoas"} em{" "}
            {new Date(selectedDate + "T00:00:00").toLocaleDateString("pt-BR", {
              day: "numeric",
              month: "long",
            })}
          </h2>
          <TimeslotGrid
            slots={availableSlots}
            loading={loadingSlots}
            error={slotsError}
            onSelect={selectSlot}
          />
        </div>
      )}

      {/* ── Step 3: Special requests + confirm ───────────────────────────── */}
      {step === "requests" && selectedSlot && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          {/* Summary card */}
          <div className="mb-6 rounded-xl bg-orange-50 p-4">
            <div className="flex items-center gap-3">
              <div className="text-2xl">📋</div>
              <div>
                <p className="font-semibold text-gray-900">
                  {new Date(selectedSlot.date + "T00:00:00").toLocaleDateString("pt-BR", {
                    weekday: "long",
                    day: "2-digit",
                    month: "long",
                  })}{" "}
                  às {selectedSlot.startTime}
                </p>
                <p className="text-sm text-gray-600">
                  {partySize} {partySize === 1 ? "pessoa" : "pessoas"} · {selectedSlot.durationMinutes} min
                </p>
              </div>
            </div>
          </div>

          <h2 className="mb-4 text-lg font-semibold text-gray-900">
            Solicitações especiais
          </h2>

          <SpecialRequestsForm value={specialRequests} onChange={setSpecialRequests} />

          {createError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {createError}
            </div>
          )}

          <div className="mt-8 flex gap-3">
            <button
              type="button"
              onClick={() => setStep("timeslot")}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Voltar
            </button>
            <button
              type="button"
              onClick={submitReservation}
              disabled={creating}
              className="flex-1 rounded-lg bg-orange-600 px-4 py-3 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60"
            >
              {creating ? "Confirmando…" : "Confirmar reserva ✓"}
            </button>
          </div>
        </div>
      )}

      {/* ── My reservations ──────────────────────────────────────────────── */}
      <div className="mt-12">
        <h2 className="mb-4 text-xl font-bold text-gray-900">
          {t("reservations.my_reservations")}
        </h2>
        <MyReservations
          reservations={myReservations}
          loading={loadingMyReservations}
          onCancel={cancelReservation}
          onModify={handleModify}
        />
      </div>
    </div>
  )
}
