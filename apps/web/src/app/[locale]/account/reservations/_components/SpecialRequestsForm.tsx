"use client"

import type { SpecialRequest } from "@/stores/useReservationStore"

interface Props {
  value: SpecialRequest[]
  onChange: (requests: SpecialRequest[]) => void
}

const SPECIAL_REQUEST_OPTIONS = [
  { type: "birthday", label: "🎂 Aniversário", placeholder: "Nome e qual aniversário (ex: 50 anos)" },
  { type: "anniversary", label: "💑 Aniversário de Casamento", placeholder: "Quantos anos de casados?" },
  { type: "highchair", label: "🪑 Cadeirão para bebê" },
  { type: "window_seat", label: "🪟 Mesa perto da janela" },
  { type: "accessible", label: "♿ Acessibilidade" },
  { type: "allergy_warning", label: "⚠️ Aviso de alergia para a cozinha", placeholder: "Descreva a alergia" },
  { type: "other", label: "💬 Outra solicitação", placeholder: "Descreva sua solicitação" },
]

export function SpecialRequestsForm({ value, onChange }: Props) {
  const activeTypes = new Set(value.map((r) => r.type))

  const toggle = (type: string) => {
    if (activeTypes.has(type)) {
      onChange(value.filter((r) => r.type !== type))
    } else {
      onChange([...value, { type }])
    }
  }

  const updateNotes = (type: string, notes: string) => {
    onChange(value.map((r) => (r.type === type ? { ...r, notes } : r)))
  }

  const getRequest = (type: string) => value.find((r) => r.type === type)

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600 mb-4">
        Selecione as opções que se aplicam (opcional):
      </p>
      {SPECIAL_REQUEST_OPTIONS.map((option) => {
        const isActive = activeTypes.has(option.type)
        const request = getRequest(option.type)

        return (
          <div key={option.type}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 transition hover:bg-slate-50">
              <input
                type="checkbox"
                checked={isActive}
                onChange={() => toggle(option.type)}
                className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
              />
              <span className="text-sm font-medium text-slate-800">{option.label}</span>
            </label>

            {isActive && option.placeholder && (
              <div className="mt-2 pl-10">
                <textarea
                  value={request?.notes ?? ""}
                  onChange={(e) => updateNotes(option.type, e.target.value)}
                  placeholder={option.placeholder}
                  rows={2}
                  maxLength={200}
                  className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
