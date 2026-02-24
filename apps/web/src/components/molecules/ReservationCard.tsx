import React from 'react'
import { Card, Heading, Text, Button } from '../atoms'

interface ReservationCardProps {
  id: string
  date: string
  time: string
  partySize: number
  customerName: string
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled'
  notes?: string
  onModify?: (id: string) => void
  onCancel?: (id: string) => void
  showActions?: boolean
}

const statusColors = {
  pending: 'bg-yellow-50 border-yellow-300 text-yellow-800',
  confirmed: 'bg-green-50 border-green-300 text-green-800',
  completed: 'bg-slate-50 border-slate-300 text-slate-800',
  cancelled: 'bg-red-50 border-red-300 text-red-800',
}

const statusLabels = {
  pending: 'Pendente',
  confirmed: 'Confirmada',
  completed: 'Realizada',
  cancelled: 'Cancelada',
}

export const ReservationCard: React.FC<ReservationCardProps> = ({
  id,
  date,
  time,
  partySize,
  customerName,
  status,
  notes,
  onModify,
  onCancel,
  showActions = true,
}) => {
  const formattedDate = new Date(date).toLocaleDateString('pt-BR')

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <Heading as="h3" variant="h5">
              {customerName}
            </Heading>
            <span className={`px-2 py-1 rounded-full text-xs font-semibold border ${statusColors[status]}`}>
              {statusLabels[status]}
            </span>
          </div>
          
          <div className="space-y-1">
            <Text variant="body" textColor="secondary">
              📅 {formattedDate} às {time}
            </Text>
            <Text variant="body" textColor="secondary">
              👥 {partySize} {partySize === 1 ? 'pessoa' : 'pessoas'}
            </Text>
            {notes && (
              <Text variant="small" textColor="muted">
                📝 {notes}
              </Text>
            )}
          </div>
        </div>
        
        {showActions && (status === 'pending' || status === 'confirmed') && (
          <div className="flex gap-2 flex-shrink-0">
            {onModify && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onModify(id)}
              >
                Modificar
              </Button>
            )}
            {onCancel && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => onCancel(id)}
              >
                Cancelar
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
