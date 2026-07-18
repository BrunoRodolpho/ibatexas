"use client"

import { useTranslations } from "next-intl"
import { Button, Card, Heading, Text } from "@/components/atoms"
import { CalendarDays, Clock, Sparkles, X } from "lucide-react"
import { useReservationStore } from "@/domains/reservation"
import {
  buildModifyPayload,
  hasModifyChanges,
  fetchAvailabilitySlots,
  submitModify,
  toStrictSpecialRequests,
} from "@/domains/reservation"
import type { ReservationDTO } from "@ibatexas/types"
import { DatePicker } from "./DatePicker"
import { PartySizeSelector } from "./PartySizeSelector"
import { TimeslotGrid } from "./TimeslotGrid"
import { SpecialRequestsForm } from "./SpecialRequestsForm"

interface Props {
  /** Called with the server's updated reservation once the PATCH succeeds. */
  readonly onSaved: (updated: ReservationDTO) => void
}

function formatDateBR(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  })
}

export function ModifyReservationForm({ onSaved }: Props) {
  const t = useTranslations()
  const {
    modifyOriginal,
    selectedDate,
    partySize,
    specialRequests,
    selectedSlot,
    availableSlots,
    loadingSlots,
    slotsError,
    showSlotPicker,
    modifySubmitting,
    modifyError,
    setDate,
    setPartySize,
    setSpecialRequests,
    selectSlot,
    setAvailableSlots,
    setShowSlotPicker,
    setModifySubmitting,
    setModifyError,
    cancelModify,
  } = useReservationStore()

  // Guard: the page only renders this when modifyOriginal is set.
  if (!modifyOriginal) return null

  const openSlotPicker = async () => {
    setShowSlotPicker(true)
    setAvailableSlots([], true, null)
    try {
      const slots = await fetchAvailabilitySlots(selectedDate, partySize)
      setAvailableSlots(slots, false, null)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido."
      setAvailableSlots([], false, msg)
    }
  }

  const handleSave = async () => {
    const body = buildModifyPayload(modifyOriginal, {
      selectedTimeSlotId: selectedSlot?.timeSlotId,
      partySize,
      // Store shape is loose (`type: string`); the PATCH body requires the
      // strict enum — narrow at the boundary (soundness, nothing dropped for
      // the form's seven literal options).
      specialRequests: toStrictSpecialRequests(specialRequests),
    })

    if (!hasModifyChanges(body)) {
      setModifyError(t("reservations.modify_no_changes"))
      return
    }

    setModifySubmitting(true)
    setModifyError(null)
    try {
      const updated = await submitModify(modifyOriginal.id, body)
      onSaved(updated)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t("reservations.modify_error")
      setModifyError(msg)
    } finally {
      setModifySubmitting(false)
    }
  }

  const slotChanged =
    selectedSlot !== null && selectedSlot.timeSlotId !== modifyOriginal.timeSlot.id

  return (
    <Card className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-smoke-100 flex items-center justify-center">
            <CalendarDays className="w-4 h-4 text-charcoal-900" strokeWidth={1.5} />
          </div>
          <div>
            <Heading as="h2" variant="h3" className="text-charcoal-900">
              {t("reservations.modify_title")}
            </Heading>
            <Text variant="small" textColor="muted">
              {formatDateBR(modifyOriginal.timeSlot.date)} às {modifyOriginal.timeSlot.startTime}
            </Text>
          </div>
        </div>
        <button
          type="button"
          onClick={cancelModify}
          aria-label={t("common.cancel")}
          className="text-smoke-400 hover:text-charcoal-900 transition-micro"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="space-y-6">
        {/* Party size */}
        <PartySizeSelector value={partySize} onChange={setPartySize} />

        {/* Time slot */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-charcoal-700" strokeWidth={1.5} />
            <span className="text-sm font-medium text-charcoal-700">
              {t("reservations.time")}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Text className="text-charcoal-900 font-medium">
              {slotChanged && selectedSlot
                ? `${formatDateBR(selectedSlot.date)} às ${selectedSlot.startTime}`
                : `${formatDateBR(modifyOriginal.timeSlot.date)} às ${modifyOriginal.timeSlot.startTime}`}
            </Text>
            {!showSlotPicker && (
              <button
                type="button"
                onClick={openSlotPicker}
                className="text-sm text-brand-500 hover:text-brand-600 transition-colors duration-300"
              >
                {t("reservations.modify_change_time")}
              </button>
            )}
          </div>

          {showSlotPicker && (
            <div className="mt-4 space-y-4 rounded-sm border border-smoke-200 p-4">
              <DatePicker value={selectedDate} onChange={setDate} />
              <Button variant="secondary" size="sm" onClick={openSlotPicker}>
                {t("reservations.view_slots")}
              </Button>
              <TimeslotGrid
                slots={availableSlots}
                loading={loadingSlots}
                error={slotsError}
                onSelect={(slot) => {
                  selectSlot(slot)
                  setShowSlotPicker(false)
                }}
              />
            </div>
          )}
        </div>

        {/* Special requests */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-charcoal-700" strokeWidth={1.5} />
            <span className="text-sm font-medium text-charcoal-700">
              {t("reservations.special_requests")}
            </span>
          </div>
          <SpecialRequestsForm value={specialRequests} onChange={setSpecialRequests} />
        </div>
      </div>

      {modifyError && (
        <div className="mt-4 rounded-sm border border-accent-red/20 bg-accent-red/10 p-3 text-sm text-accent-red">
          {modifyError}
        </div>
      )}

      <div className="mt-8 flex gap-3">
        <Button variant="secondary" onClick={cancelModify} className="flex-1" size="lg">
          {t("common.cancel")}
        </Button>
        <Button
          onClick={handleSave}
          disabled={modifySubmitting}
          className="flex-1"
          size="lg"
        >
          {modifySubmitting ? t("reservations.modify_saving") : t("reservations.modify_save")}
        </Button>
      </div>
    </Card>
  )
}
