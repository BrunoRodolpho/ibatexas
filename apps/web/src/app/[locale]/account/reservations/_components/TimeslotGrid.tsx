"use client"

import type { AvailableSlot } from "@/stores/useReservationStore"

interface Props {
  slots: AvailableSlot[]
  loading: boolean
  error: string | null
  onSelect: (slot: AvailableSlot) => void
}

const LOCATION_LABELS: Record<string, string> = {
  indoor: "🪵 Salão interno",
  outdoor: "🌿 Área externa",
  bar: "🍺 Bar",
  terrace: "☀️ Terraço",
}

function groupByPeriod(slots: AvailableSlot[]): { label: string; slots: AvailableSlot[] }[] {
  const lunch = slots.filter((s) => {
    const [h] = s.startTime.split(":").map(Number)
    return (h ?? 0) < 16
  })
  const dinner = slots.filter((s) => {
    const [h] = s.startTime.split(":").map(Number)
    return (h ?? 0) >= 16
  })

  const groups = []
  if (lunch.length > 0) groups.push({ label: "☀️ Almoço", slots: lunch })
  if (dinner.length > 0) groups.push({ label: "🌙 Jantar", slots: dinner })
  return groups
}

export function TimeslotGrid({ slots, loading, error, onSelect }: Props) {
  if (loading) {
    return (
      <div className="py-8 text-center text-gray-500">
        <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-orange-600 border-t-transparent" />
        <p className="mt-2 text-sm">Verificando disponibilidade…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    )
  }

  if (slots.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-gray-500">Nenhum horário disponível para esta data.</p>
        <p className="mt-1 text-sm text-gray-400">Tente outra data ou entre na lista de espera.</p>
      </div>
    )
  }

  const groups = groupByPeriod(slots)

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.label}>
          <h4 className="mb-3 text-sm font-semibold text-gray-600">{group.label}</h4>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {group.slots.map((slot) => (
              <button
                key={slot.timeSlotId}
                type="button"
                onClick={() => onSelect(slot)}
                className="rounded-xl border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-orange-400 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-orange-400"
              >
                <div className="text-xl font-bold text-gray-900">{slot.startTime}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {slot.durationMinutes} min
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {slot.tableLocations.map((loc) => (
                    <span
                      key={loc}
                      className="rounded-full bg-orange-50 px-2 py-0.5 text-xs text-orange-700"
                    >
                      {LOCATION_LABELS[loc] ?? loc}
                    </span>
                  ))}
                </div>
                <div className="mt-2 text-xs text-green-600">
                  {slot.availableCovers} vaga{slot.availableCovers !== 1 ? "s" : ""}
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
