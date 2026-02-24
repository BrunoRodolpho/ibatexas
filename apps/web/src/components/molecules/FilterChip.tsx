import React from 'react'
import { Badge } from '../atoms'

interface FilterChipProps {
  id: string
  label: string
  selected: boolean
  onToggle: (id: string) => void
  removable?: boolean
  onRemove?: (id: string) => void
}

export const FilterChip: React.FC<FilterChipProps> = ({
  id,
  label,
  selected,
  onToggle,
  removable = false,
  onRemove,
}) => {
  return (
    <button
      onClick={() => onToggle(id)}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${
        selected
          ? 'bg-amber-700 text-white'
          : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
      }`}
      aria-pressed={selected}
    >
      {label}
      {removable && selected && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove?.(id)
          }}
          className="ml-1 text-lg leading-none hover:opacity-70"
          aria-label={`Remover filtro ${label}`}
        >
          ×
        </button>
      )}
    </button>
  )
}
