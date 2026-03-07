'use client'

interface FilterChipProps {
  id: string
  label: string
  selected: boolean
  onToggle: (id: string) => void
}

export function FilterChip({ id, label, selected, onToggle }: FilterChipProps) {
  return (
    <button
      onClick={() => onToggle(id)}
      className={`inline-flex items-center gap-1.5 text-xs font-medium transition-colors duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        selected
          ? 'text-charcoal-900 border-b border-charcoal-900/30 pb-0.5'
          : 'text-smoke-400 hover:text-charcoal-900'
      }`}
      aria-pressed={selected}
    >
      {label}
    </button>
  )
}
