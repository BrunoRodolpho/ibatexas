import React from 'react'
import { Card, Text } from '../atoms'

interface AddressCardProps {
  readonly id: string
  readonly street: string
  readonly number: string
  readonly neighborhood: string
  readonly city: string
  readonly state: string
  readonly complement?: string
  readonly isSelected?: boolean
  readonly onSelect: (id: string) => void
  readonly onEdit?: (id: string) => void
  readonly onDelete?: (id: string) => void
}

export const AddressCard: React.FC<AddressCardProps> = ({
  id,
  street,
  number,
  neighborhood,
  city,
  state,
  complement,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
}) => {
  const complementSuffix = complement ? ` - ${complement}` : ''
  const address = `${street}, ${number}${complementSuffix}, ${neighborhood}, ${city} - ${state}`

  return (
    <Card
      className={`p-4 cursor-pointer transition-all ${
        isSelected
          ? 'ring-2 ring-brand-600 bg-brand-50'
          : 'hover:bg-smoke-100'
      }`}
      onClick={() => onSelect(id)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <input
            type="radio"
            name="address"
            value={id}
            checked={isSelected}
            onChange={() => onSelect(id)}
            className="accent-brand-600"
          />
          <Text variant="body" className="mt-2 text-charcoal-900">
            {address}
          </Text>
        </div>
        
        {(onEdit || onDelete) && (
          <div className="flex gap-2 flex-shrink-0">
            {onEdit && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(id)
                }}
                className="text-sm text-brand-600 hover:underline"
              >
                Editar
              </button>
            )}
            {onDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(id)
                }}
                className="text-sm text-accent-red hover:underline"
              >
                Remover
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
