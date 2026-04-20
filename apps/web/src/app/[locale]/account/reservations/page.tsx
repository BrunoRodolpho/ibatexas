"use client"

import { useEffect, useCallback } from "react"
import { Link } from '@/i18n/navigation'
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { useSessionStore } from '@/domains/session'
import { useReservationStore } from '@/domains/reservation'
import { Heading, Text, Button, Card } from "@/components/atoms"
import { CalendarDays, Users, Sparkles, Check, Clock, Flame } from "lucide-react"
import type { ReservationDTO } from "@ibatexas/types"

import { DatePicker } from "./_components/DatePicker"
import { PartySizeSelector } from "./_components/PartySizeSelector"
import { TimeslotGrid } from "./_components/TimeslotGrid"
import { SpecialRequestsForm } from "./_components/SpecialRequestsForm"
import { ReservationConfirmation } from "./_components/ReservationConfirmation"
import { MyReservations } from "./_components/MyReservations"
import { getApiBase } from "@/lib/api"

// ── Step Progress Indicator ──────────────────────────────────────────────────
const STEPS = [
  { key: 'date-party', label: 'Data' },
  { key: 'timeslot', label: 'Horário' },
  { key: 'requests', label: 'Detalhes' },
  { key: 'confirmation', label: 'Confirmação' },
] as const

function StepProgress({ currentStep }: { readonly currentStep: string }) {
  const currentIndex = STEPS.findIndex((s) => s.key === currentStep)

  return (
    <div className="flex items-center justify-between mb-10">
      {STEPS.map((s, i) => {
        const isCompleted = i < currentIndex
        const isActive = i === currentIndex

        let dotColor: string
        if (isCompleted) {
          dotColor = 'bg-brand-500 text-white'
        } else if (isActive) {
          dotColor = 'bg-charcoal-900 text-white'
        } else {
          dotColor = 'bg-smoke-200 text-smoke-400'
        }

        return (
          <div key={s.key} className="flex items-center flex-1 last:flex-none">
            {/* Dot + label */}
            <div className="flex flex-col items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-micro ${dotColor}`}
              >
                {isCompleted ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span
                className={`mt-1.5 text-micro uppercase tracking-editorial font-medium ${
                  isActive ? 'text-charcoal-900' : 'text-smoke-400'
                }`}
              >
                {s.label}
              </span>
            </div>

            {/* Connecting line */}
            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-px mx-2 ${
                  i < currentIndex ? 'bg-brand-500' : 'bg-smoke-200'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

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
        `${getApiBase()}/api/reservations/availability?date=${selectedDate}&partySize=${partySize}`,
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
      const res = await fetch(`${getApiBase()}/api/reservations?customerId=${customerId}&limit=20`)
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
      const res = await fetch(`${getApiBase()}/api/reservations`, {
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
      const res = await fetch(`${getApiBase()}/api/reservations/${reservationId}`, {
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
    globalThis.scrollTo({ top: 0, behavior: "smooth" })
  }

  // ── Auth guard ─────────────────────────────────────────────────────────────

  const router = useRouter()

  if (!customerId) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <div className="bg-smoke-100 warm-glow rounded-sm p-10 text-center">
          {/* Icon */}
          <div className="flex justify-center mb-6">
            <div className="w-14 h-14 rounded-full bg-smoke-50 flex items-center justify-center shadow-sm">
              <CalendarDays className="w-6 h-6 text-charcoal-900" strokeWidth={1.5} />
            </div>
          </div>

          <Heading as="h1" variant="h2" className="text-charcoal-900 mb-3">
            {t("reservations.title")}
          </Heading>
          <Text textColor="muted" className="mb-6">
            {t("reservations.login_required")}
          </Text>

          {/* Value proposition */}
          <div className="text-left space-y-3 mb-8">
            {[
              { icon: CalendarDays, text: 'Reserve sua mesa com antecedência' },
              { icon: Users, text: 'Grupos de até 20 pessoas' },
              { icon: Sparkles, text: 'Solicitações especiais como aniversários' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <Icon className="w-4 h-4 text-brand-500 flex-shrink-0" />
                <Text variant="small" textColor="secondary">{text}</Text>
              </div>
            ))}
          </div>

          <Button
            onClick={() => router.push('/entrar?next=/account/reservations')}
            className="w-full"
            size="lg"
          >
            {t("checkout.login_button")}
          </Button>

          <p className="mt-6">
            <Link href="/search" className="text-sm text-brand-500 hover:text-brand-600 transition-colors duration-300">
              {t("cart.continue_shopping")} →
            </Link>
          </p>
        </div>
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

  const hasReservations = myReservations.length > 0

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">

      {/* Header with back link + brand punctuation */}
      <div className="mb-6">
        <Link
          href="/account"
          className="text-sm text-smoke-400 hover:text-charcoal-900 transition-micro"
        >
          ← {t("account.title")}
        </Link>
        <div className="flex items-center gap-3 mt-3 mb-2">
          <Flame className="w-4 h-4 text-brand-500 flex-shrink-0" strokeWidth={1.5} />
          <div className="h-px flex-1 bg-smoke-200/60" />
        </div>
        <Heading as="h1" variant="h1" className="text-charcoal-900">
          {t("reservations.title")}
        </Heading>
      </div>

      {/* ── My reservations (only when they exist) ───────────────────────── */}
      {(hasReservations || loadingMyReservations) && (
        <div className="mb-12">
          <MyReservations
            reservations={myReservations}
            loading={loadingMyReservations}
            onCancel={cancelReservation}
            onModify={handleModify}
          />
        </div>
      )}

      {/* ── Booking form ─────────────────────────────────────────────────── */}
      <div>
        {/* Only show section heading when reservations exist above */}
        {hasReservations && (
          <div className="mb-6">
            <Heading as="h2" variant="h2" className="text-charcoal-900">
              {t("reservations.new")}
            </Heading>
          </div>
        )}

        {/* Step progress */}
        <StepProgress currentStep={step} />

        {/* Step back indicator */}
        {step !== "date-party" && (
          <div className="mb-6 flex items-center gap-2">
            <button
              onClick={() => setStep("date-party")}
              className="text-sm text-brand-500 hover:text-brand-600 transition-colors duration-300"
            >
              {t("common.back")}
            </button>
            <span className="text-smoke-300">·</span>
            <Text variant="small" textColor="muted">
              {step === "timeslot" && t("reservations.time")}
              {step === "requests" && t("reservations.special_requests")}
            </Text>
          </div>
        )}

        {/* ── Step 1: Date + Party size ─────────────────────────────────── */}
        {step === "date-party" && (
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-9 h-9 rounded-full bg-smoke-100 flex items-center justify-center">
                <CalendarDays className="w-4 h-4 text-charcoal-900" strokeWidth={1.5} />
              </div>
              <Heading as="h2" variant="h3" className="text-charcoal-900">
                {hasReservations ? t("reservations.choose_date") : t("reservations.new")}
              </Heading>
            </div>

            <div className="space-y-6">
              <DatePicker value={selectedDate} onChange={setDate} />
              <PartySizeSelector value={partySize} onChange={setPartySize} />
            </div>

            <Button
              disabled={!selectedDate}
              onClick={fetchAvailability}
              className="mt-8 w-full"
              size="lg"
            >
              {t("reservations.view_slots")}
            </Button>
          </Card>
        )}

        {/* ── Step 2: Pick time slot ──────────────────────────────────────── */}
        {step === "timeslot" && (
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-9 h-9 rounded-full bg-smoke-100 flex items-center justify-center">
                <Clock className="w-4 h-4 text-charcoal-900" strokeWidth={1.5} />
              </div>
              <Heading as="h2" variant="h3" className="text-charcoal-900">
                Horários disponíveis para {partySize} {partySize === 1 ? "pessoa" : "pessoas"} em{" "}
                {new Date(selectedDate + "T00:00:00").toLocaleDateString("pt-BR", {
                  day: "numeric",
                  month: "long",
                })}
              </Heading>
            </div>
            <TimeslotGrid
              slots={availableSlots}
              loading={loadingSlots}
              error={slotsError}
              onSelect={selectSlot}
            />
          </Card>
        )}

        {/* ── Step 3: Special requests + confirm ─────────────────────────── */}
        {step === "requests" && selectedSlot && (
          <Card className="p-6">
            {/* Summary card */}
            <div className="mb-6 rounded-sm bg-charcoal-900 text-smoke-50 p-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-charcoal-800 flex items-center justify-center">
                  <Check className="w-4 h-4 text-brand-400" />
                </div>
                <div>
                  <Text className="font-semibold text-smoke-50">
                    {new Date(selectedSlot.date + "T00:00:00").toLocaleDateString("pt-BR", {
                      weekday: "long",
                      day: "2-digit",
                      month: "long",
                    })}{" "}
                    às {selectedSlot.startTime}
                  </Text>
                  <Text variant="small" className="text-smoke-200">
                    {partySize} {partySize === 1 ? "pessoa" : "pessoas"} · {selectedSlot.durationMinutes} min
                  </Text>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-smoke-100 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-charcoal-900" strokeWidth={1.5} />
              </div>
              <Heading as="h2" variant="h3" className="text-charcoal-900">
                {t("reservations.special_requests")}
              </Heading>
            </div>

            <SpecialRequestsForm value={specialRequests} onChange={setSpecialRequests} />

            {createError && (
              <div className="mt-4 rounded-sm border border-accent-red/20 bg-accent-red/10 p-3 text-sm text-accent-red">
                {createError}
              </div>
            )}

            <div className="mt-8 flex gap-3">
              <Button
                variant="secondary"
                onClick={() => setStep("timeslot")}
                className="flex-1"
                size="lg"
              >
                {t("common.back")}
              </Button>
              <Button
                onClick={submitReservation}
                disabled={creating}
                className="flex-1"
                size="lg"
              >
                {creating ? t("reservations.confirming") : t("reservations.confirm")}
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
