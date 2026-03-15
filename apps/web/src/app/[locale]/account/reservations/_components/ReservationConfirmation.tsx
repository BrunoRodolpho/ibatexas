"use client"

import { Link } from '@/i18n/navigation'

import type { CreatedReservation } from '@/domains/reservation'

const LOCATION_LABELS: Record<string, string> = {
  indoor: "Salão interno",
  outdoor: "Área externa",
  bar: "Balcão do bar",
  terrace: "Terraço",
}

interface Props {
  readonly reservation: CreatedReservation
  readonly onMakeAnother: () => void
}

export function ReservationConfirmation({ reservation, onMakeAnother }: Props) {

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
      <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50">
        <svg className="h-10 w-10 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <h2 className="text-2xl font-display font-bold text-charcoal-900">Reserva confirmada!</h2>
      <p className="mt-2 text-smoke-400">
        Você receberá uma confirmação pelo WhatsApp em breve.
      </p>

      {/* Details card */}
      <div className="mx-auto mt-8 max-w-sm rounded-sm border border-smoke-200 bg-smoke-50 p-6 text-left">
        <div className="space-y-3">
          <div className="flex justify-between">
            <span className="text-sm text-smoke-400">📅 Data</span>
            <span className="text-sm font-medium text-charcoal-900 capitalize">{dateBR}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-smoke-400">🕕 Horário</span>
            <span className="text-sm font-medium text-charcoal-900">{time}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-smoke-400">👥 Pessoas</span>
            <span className="text-sm font-medium text-charcoal-900">
              {reservation.partySize} {reservation.partySize === 1 ? "pessoa" : "pessoas"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-smoke-400">📍 Local</span>
            <span className="text-sm font-medium text-charcoal-900">{location}</span>
          </div>
          <div className="border-t border-smoke-200 pt-3">
            <div className="flex justify-between">
              <span className="text-xs text-smoke-300">ID da reserva</span>
              <span className="font-mono text-xs text-smoke-400">{reservation.reservationId.slice(0, 12)}…</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-3">
        <Link
          href={"/account/reservations"}
          className="rounded-sm border border-smoke-200 px-6 py-3 text-sm font-medium text-charcoal-700 hover:bg-smoke-100 transition-all duration-500"
        >
          Ver minhas reservas
        </Link>
        <button
          type="button"
          onClick={onMakeAnother}
          className="rounded-sm bg-charcoal-900 px-6 py-3 text-sm font-medium text-smoke-50 hover:bg-charcoal-800 transition-all duration-500"
        >
          Fazer outra reserva
        </button>
      </div>
    </div>
  )
}
