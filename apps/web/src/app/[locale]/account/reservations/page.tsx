"use client"

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useSessionStore } from "@/stores"

export default function ReservationsPage() {
  const t = useTranslations()
  const { customerId } = useSessionStore()
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({
    date: "",
    time: "",
    partySize: "2",
    specialRequests: "",
    occasion: "" as "birthday" | "anniversary" | "regular",
    specialRequirements: [] as string[],
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // TODO: Submit reservation via API
    alert("Reserva enviada com sucesso!")
    setShowForm(false)
  }

  const handleRequirementToggle = (requirement: string) => {
    setFormData((prev) => ({
      ...prev,
      specialRequirements: prev.specialRequirements.includes(requirement)
        ? prev.specialRequirements.filter((r) => r !== requirement)
        : [...prev.specialRequirements, requirement],
    }))
  }

  if (!customerId) {
    return (
      <div className="mx-auto max-w-md px-4 py-12 text-center sm:px-6">
        <h1 className="text-3xl font-bold text-gray-900">
          {t("reservations.title")}
        </h1>
        <p className="mt-4 text-gray-600">
          {t("reservations.login_required")}
        </p>

        <button className="mt-8 w-full rounded-lg bg-orange-600 px-6 py-3 font-medium text-white hover:bg-orange-700">
          {t("checkout.login_button")}
        </button>

        <p className="mt-6">
          <Link
            href="/search"
            className="text-orange-600 hover:text-orange-700"
          >
            {t("cart.continue_shopping")} →
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">
          {t("reservations.title")}
        </h1>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-orange-600 px-6 py-2 font-medium text-white hover:bg-orange-700"
          >
            {t("reservations.make_reservation")}
          </button>
        )}
      </div>

      {showForm && (
        <div className="rounded-lg border border-gray-200 p-6 sm:p-8">
          <h2 className="text-lg font-bold text-gray-900">
            {t("reservations.make_reservation")}
          </h2>

          <form onSubmit={handleSubmit} className="mt-6 space-y-6">
            {/* Date */}
            <div>
              <label className="block text-sm font-medium text-gray-900">
                {t("reservations.date")} *
              </label>
              <input
                type="date"
                required
                value={formData.date}
                onChange={(e) =>
                  setFormData({ ...formData, date: e.target.value })
                }
                className="mt-2 block w-full rounded-lg border border-gray-300 px-4 py-2"
              />
            </div>

            {/* Time */}
            <div>
              <label className="block text-sm font-medium text-gray-900">
                {t("reservations.time")} *
              </label>
              <input
                type="time"
                required
                value={formData.time}
                onChange={(e) =>
                  setFormData({ ...formData, time: e.target.value })
                }
                className="mt-2 block w-full rounded-lg border border-gray-300 px-4 py-2"
              />
            </div>

            {/* Party Size */}
            <div>
              <label className="block text-sm font-medium text-gray-900">
                {t("reservations.party_size")} *
              </label>
              <select
                required
                value={formData.partySize}
                onChange={(e) =>
                  setFormData({ ...formData, partySize: e.target.value })
                }
                className="mt-2 block w-full rounded-lg border border-gray-300 px-4 py-2"
              >
                {[...Array(10)].map((_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1} {i === 0 ? "pessoa" : "pessoas"}
                  </option>
                ))}
              </select>
            </div>

            {/* Occasion */}
            <div>
              <label className="block text-sm font-medium text-gray-900">
                {t("reservations.special_requests")}
              </label>
              <div className="mt-3 space-y-3">
                {[
                  { value: "birthday", label: "birthday" },
                  { value: "anniversary", label: "anniversary" },
                ].map(({ value, label }) => (
                  <label key={value} className="flex items-center">
                    <input
                      type="radio"
                      name="occasion"
                      value={value}
                      checked={formData.occasion === value}
                      onChange={() =>
                        setFormData({ ...formData, occasion: value as any })
                      }
                      className="h-4 w-4"
                    />
                    <span className="ml-3 text-sm text-gray-600">
                      {t(`reservations.${label}`)}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Special Requirements */}
            <div>
              <label className="block text-sm font-medium text-gray-900">
                {t("reservations.special_requests")}
              </label>
              <div className="mt-3 space-y-2">
                {[
                  { value: "highchair", label: "highchair" },
                  { value: "accessible", label: "accessible" },
                  { value: "window_seat", label: "window_seat" },
                ].map(({ value, label }) => (
                  <label key={value} className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.specialRequirements.includes(value)}
                      onChange={() => handleRequirementToggle(value)}
                      className="h-4 w-4 rounded"
                    />
                    <span className="ml-3 text-sm text-gray-600">
                      {t(`reservations.${label}`)}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium text-gray-900">
                {t("reservations.special_requests")}
              </label>
              <textarea
                value={formData.specialRequests}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    specialRequests: e.target.value,
                  })
                }
                placeholder="Alguma informação adicional..."
                className="mt-2 block w-full rounded-lg border border-gray-300 px-4 py-2"
                rows={3}
              />
            </div>

            {/* Buttons */}
            <div className="flex gap-4 pt-4">
              <button
                type="submit"
                className="flex-1 rounded-lg bg-orange-600 px-6 py-2 font-medium text-white hover:bg-orange-700"
              >
                {t("reservations.confirm_reservation")}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50"
              >
                {t("common.cancel")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Existing Reservations */}
      <div className="mt-12">
        <h2 className="text-xl font-bold text-gray-900">
          {t("reservations.my_reservations")}
        </h2>

        <div className="mt-6 rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-gray-600">
            Nenhuma reserva agendada no momento
          </p>
        </div>
      </div>
    </div>
  )
}
