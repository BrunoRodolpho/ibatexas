"use client"

interface Props {
  value: string  // YYYY-MM-DD
  onChange: (date: string) => void
  minDate?: string
  maxDate?: string
}

function toInputMin(): string {
  return new Date().toISOString().split("T")[0]!
}

function toInputMax(): string {
  const d = new Date()
  d.setDate(d.getDate() + 60)
  return d.toISOString().split("T")[0]!
}

export function DatePicker({ value, onChange, minDate, maxDate }: Props) {
  return (
    <div>
      <label htmlFor="reservation-date" className="block text-sm font-medium text-gray-700 mb-2">
        Data da reserva
      </label>
      <input
        id="reservation-date"
        type="date"
        value={value}
        min={minDate ?? toInputMin()}
        max={maxDate ?? toInputMax()}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
      />
    </div>
  )
}
