"use client"

import { useTranslations } from "next-intl"

const MIN_PARTY = 1
const MAX_PARTY = 20

interface Props {
  readonly value: number
  readonly onChange: (size: number) => void
}

export function PartySizeSelector({ value, onChange }: Props) {
  const t = useTranslations()

  return (
    <fieldset>
      <legend className="block text-sm font-medium text-charcoal-700 mb-2">
        {t("reservations.party_size")}
      </legend>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => onChange(Math.max(MIN_PARTY, value - 1))}
          disabled={value <= MIN_PARTY}
          className="flex h-10 w-10 items-center justify-center rounded-sm border border-smoke-200 text-lg font-bold text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40"
          aria-label="Diminuir"
        >
          −
        </button>
        <span className="w-20 text-center text-2xl font-bold text-charcoal-900">
          {value}
          <span className="ml-1 text-sm font-normal text-smoke-400">
            {value === 1 ? "pessoa" : "pessoas"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => onChange(Math.min(MAX_PARTY, value + 1))}
          disabled={value >= MAX_PARTY}
          className="flex h-10 w-10 items-center justify-center rounded-sm border border-smoke-200 text-lg font-bold text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40"
          aria-label="Aumentar"
        >
          +
        </button>
      </div>
      {value > 8 && (
        <p className="mt-2 text-xs text-brand-600">
          Para grupos grandes, podemos combinar mesas. Nossa equipe entrará em contato para confirmar.
        </p>
      )}
    </fieldset>
  )
}
