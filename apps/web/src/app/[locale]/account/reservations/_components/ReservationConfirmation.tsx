"use client"

import Link from "next/link"
import { useLocale } from "next-intl"
import type { CreatedReservation } from "@/stores/useReservationStore"

const LOCATION_LABELS: Record<string, string> = {
  indoor: "Salão interno",
  outdoor: "Área externa",
  bar: "Balcão do bar",
  terrace: "Terraço",
}

interface Props {
  reservation: CreatedReservation
  onMakeAnother: () => void
}

export function ReservationConfirmation({ reservation, onMakeAnother }: Props) {
  const locale = useLocale()

  const dateTime = new Date(reservation.dateTime)
  const dateBR = dateTime.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  })
  const time = reservation.dateTime.split("T")[1]?.slice(0, 5) ?? ""
  const location = reservation.tableLocation
    ? (LOCATION_LABELS[reservation.tableLocation] ?? reservation.tableLocation)
    : "Salão"

  return (
    <div className="text-center">
      {/* Success icon */}
      <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
        <svg className="h-10 w-10 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <h2 className="text-2xl font-bold text-gray-900">Reserva confirmada!</h2>
      <p className="mt-2 text-gray-600">
        Você receberá uma confirmação pelo WhatsApp em breve.
      </p>

      {/* Details card */}
      <div className="mx-auto mt-8 max-w-sm rounded-2xl border border-gray-200 bg-white p-6 text-left shadow-sm">
        <div className="space-y-3">
          <div className="flex justify-between">
            <span className="text-sm text-gray-500">📅 Data</span>
            <span className="text-sm font-medium text-gray-900 capitalize">{dateBR}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-500">🕕 Horário</span>
            <span className="text-sm font-medium text-gray-900">{time}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-500">👥 Pessoas</span>
            <span className="text-sm font-medium text-gray-900">
              {reservation.partySize} {reservation.partySize === 1 ? "pessoa" : "pessoas"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-500">📍 Local</span>
            <span className="text-sm font-medium text-gray-900">{location}</span>
          </div>
          <div className="border-t border-gray-100 pt-3">
            <div className="flex justify-between">
              <span className="text-xs text-gray-400">ID da reserva</span>
              <span className="font-mono text-xs text-gray-500">{reservation.reservationId.slice(0, 12)}…</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-3">
        <Link
          href={`/${locale}/account/reservations`}
          className="rounded-lg border border-gray-300 px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Ver minhas reservas
        </Link>
        <button
          type="button"
          onClick={onMakeAnother}
          className="rounded-lg bg-orange-600 px-6 py-3 text-sm font-medium text-white hover:bg-orange-700"
        >
          Fazer outra reserva
        </button>
      </div>
    </div>
  )
}
