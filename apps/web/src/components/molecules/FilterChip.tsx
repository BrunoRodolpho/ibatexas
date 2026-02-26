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
      className={`inline-flex items-center gap-1.5 text-xs font-medium transition-colors duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        selected
          ? 'text-charcoal-900 border-b border-charcoal-900/30 pb-0.5'
          : 'text-smoke-400 hover:text-charcoal-900'
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
          className="text-sm leading-none hover:opacity-70"
          aria-label={`Remover filtro ${label}`}
        >
          ×
        </button>
      )}
    </button>
  )
}
