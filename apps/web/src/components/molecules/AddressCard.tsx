import React from 'react'
import { Card, Text } from '../atoms'
import { Image } from '../atoms/Image'

interface AddressCardProps {
  id: string
  street: string
  number: string
  neighborhood: string
  city: string
  state: string
  complement?: string
  isSelected?: boolean
  onSelect: (id: string) => void
  onEdit?: (id: string) => void
  onDelete?: (id: string) => void
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
  const address = `${street}, ${number}${complement ? ` - ${complement}` : ''}, ${neighborhood}, ${city} - ${state}`

  return (
    <Card
      className={`p-4 cursor-pointer transition-all ${
        isSelected
          ? 'ring-2 ring-amber-700 bg-amber-50'
          : 'hover:bg-slate-50'
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
            className="accent-amber-700"
          />
          <Text variant="body" className="mt-2 text-slate-900">
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
                className="text-sm text-amber-700 hover:underline"
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
                className="text-sm text-red-600 hover:underline"
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
