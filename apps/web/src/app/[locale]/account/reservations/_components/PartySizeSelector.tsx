"use client"

import { useTranslations } from "next-intl"

const MIN_PARTY = 1
const MAX_PARTY = 20

interface Props {
  value: number
  onChange: (size: number) => void
}

export function PartySizeSelector({ value, onChange }: Props) {
  const t = useTranslations()

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        {t("reservations.party_size")}
      </label>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => onChange(Math.max(MIN_PARTY, value - 1))}
          disabled={value <= MIN_PARTY}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-gray-300 text-lg font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          aria-label="Diminuir"
        >
          −
        </button>
        <span className="w-20 text-center text-2xl font-bold text-gray-900">
          {value}
          <span className="ml-1 text-sm font-normal text-gray-500">
            {value === 1 ? "pessoa" : "pessoas"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => onChange(Math.min(MAX_PARTY, value + 1))}
          disabled={value >= MAX_PARTY}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-gray-300 text-lg font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          aria-label="Aumentar"
        >
          +
        </button>
      </div>
      {value > 8 && (
        <p className="mt-2 text-xs text-amber-700">
          Para grupos grandes, podemos combinar mesas. Nossa equipe entrará em contato para confirmar.
        </p>
      )}
    </div>
  )
}
