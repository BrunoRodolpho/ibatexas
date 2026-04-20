"use client"

import { useTranslations } from "next-intl"
import { Button, Card } from "@/components/atoms"
import { Users, MapPin } from "lucide-react"
import type { ReservationDTO } from "@ibatexas/types"

interface Props {
  readonly reservations: ReservationDTO[]
  readonly loading: boolean
  readonly onCancel: (id: string) => void
  readonly onModify: (reservation: ReservationDTO) => void
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  confirmed: "bg-green-100 text-green-800",
  seated: "bg-blue-100 text-blue-800",
  completed: "bg-smoke-100 text-smoke-500",
  cancelled: "bg-red-100 text-red-700",
  no_show: "bg-red-100 text-red-700",
}

function formatDateBR(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  })
}

export function MyReservations({ reservations, loading, onCancel, onModify }: Props) {
  const t = useTranslations()

  const STATUS_LABELS: Record<string, { label: string; color: string }> = {
    pending: { label: t("reservations.status_pending"), color: STATUS_COLORS.pending },
    confirmed: { label: t("reservations.status_confirmed"), color: STATUS_COLORS.confirmed },
    seated: { label: t("reservations.status_seated"), color: STATUS_COLORS.seated },
    completed: { label: t("reservations.status_completed"), color: STATUS_COLORS.completed },
    cancelled: { label: t("reservations.status_cancelled"), color: STATUS_COLORS.cancelled },
    no_show: { label: t("reservations.status_no_show"), color: STATUS_COLORS.no_show },
  }

  const LOCATION_LABELS: Record<string, string> = {
    indoor: t("reservations.location_indoor"),
    outdoor: t("reservations.location_outdoor"),
    bar: t("reservations.location_bar"),
    terrace: t("reservations.location_terrace"),
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={`skel-${i}`} className="h-24 rounded-sm skeleton" />
        ))}
      </div>
    )
  }

  if (reservations.length === 0) {
    return (
      <div className="py-8 text-center text-smoke-400">
        <p>{t("reservations.empty")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {reservations.map((r) => {
        const statusInfo = STATUS_LABELS[r.status] ?? { label: r.status, color: "bg-smoke-100 text-smoke-500" }
        const canModifyOrCancel = ["pending", "confirmed"].includes(r.status)

        return (
          <Card key={r.id} className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-charcoal-900">
                    {formatDateBR(r.timeSlot.date)} às {r.timeSlot.startTime}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusInfo.color}`}>
                    {statusInfo.label}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-sm text-smoke-400">
                  <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {r.partySize} {r.partySize === 1 ? "pessoa" : "pessoas"}</span>
                  {r.tableLocation && (
                    <span className="inline-flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> {LOCATION_LABELS[r.tableLocation] ?? r.tableLocation}</span>
                  )}
                </div>
                {r.specialRequests.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.specialRequests.map((sr) => (
                      <span
                        key={sr.type}
                        className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700"
                      >
                        {sr.type}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {canModifyOrCancel && (
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onModify(r)}
                  >
                    {t("common.modify")}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => onCancel(r.id)}
                  >
                    {t("reservations.cancel")}
                  </Button>
                </div>
              )}
            </div>
          </Card>
        )
      })}
    </div>
  )
}
