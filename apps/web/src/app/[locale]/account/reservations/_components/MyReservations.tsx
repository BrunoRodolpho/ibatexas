"use client"

import type { ReservationDTO } from "@ibatexas/types"

interface Props {
  reservations: ReservationDTO[]
  loading: boolean
  onCancel: (id: string) => void
  onModify: (reservation: ReservationDTO) => void
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "Aguardando confirmação", color: "bg-yellow-100 text-yellow-800" },
  confirmed: { label: "Confirmada", color: "bg-green-100 text-green-800" },
  seated: { label: "Em andamento", color: "bg-blue-100 text-blue-800" },
  completed: { label: "Concluída", color: "bg-gray-100 text-gray-700" },
  cancelled: { label: "Cancelada", color: "bg-red-100 text-red-700" },
  no_show: { label: "Não compareceu", color: "bg-red-100 text-red-700" },
}

const LOCATION_LABELS: Record<string, string> = {
  indoor: "Salão interno",
  outdoor: "Área externa",
  bar: "Bar",
  terrace: "Terraço",
}

function formatDateBR(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  })
}

export function MyReservations({ reservations, loading, onCancel, onModify }: Props) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
    )
  }

  if (reservations.length === 0) {
    return (
      <div className="py-8 text-center text-gray-500">
        <p>Você ainda não tem reservas.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {reservations.map((r) => {
        const statusInfo = STATUS_LABELS[r.status] ?? { label: r.status, color: "bg-gray-100 text-gray-700" }
        const canModifyOrCancel = ["pending", "confirmed"].includes(r.status)

        return (
          <div key={r.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-gray-900">
                    {formatDateBR(r.timeSlot.date)} às {r.timeSlot.startTime}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusInfo.color}`}>
                    {statusInfo.label}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-sm text-gray-500">
                  <span>👥 {r.partySize} {r.partySize === 1 ? "pessoa" : "pessoas"}</span>
                  {r.tableLocation && (
                    <span>📍 {LOCATION_LABELS[r.tableLocation] ?? r.tableLocation}</span>
                  )}
                </div>
                {r.specialRequests.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.specialRequests.map((sr, i) => (
                      <span
                        key={i}
                        className="rounded-full bg-orange-50 px-2 py-0.5 text-xs text-orange-700"
                      >
                        {sr.type}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {canModifyOrCancel && (
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => onModify(r)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Modificar
                  </button>
                  <button
                    onClick={() => onCancel(r.id)}
                    className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                  >
                    Cancelar
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
