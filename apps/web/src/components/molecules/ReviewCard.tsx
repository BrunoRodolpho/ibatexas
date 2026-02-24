import React from 'react'
import { Card, Heading, Text, Badge } from '../atoms'

interface ReviewCardProps {
  id: string
  customerName: string
  rating: number
  comment: string
  date: string
  productName?: string
  status?: 'new' | 'acknowledged' | 'resolved'
  escalated?: boolean
  onRespond?: (id: string) => void
}

export const ReviewCard: React.FC<ReviewCardProps> = ({
  id,
  customerName,
  rating,
  comment,
  date,
  productName,
  status = 'new',
  escalated = false,
  onRespond,
}) => {
  const formattedDate = new Date(date).toLocaleDateString('pt-BR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const stars = '⭐'.repeat(rating)
  const statusColors = {
    new: 'bg-blue-100 text-blue-800',
    acknowledged: 'bg-yellow-100 text-yellow-800',
    resolved: 'bg-green-100 text-green-800',
  }
  const statusLabels = { new: 'Nova', acknowledged: 'Reconhecida', resolved: 'Resolvida' }

  return (
    <Card className={`p-4 ${escalated ? 'ring-2 ring-red-300 bg-red-50' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <Heading as="h4" variant="h5">
              {customerName}
            </Heading>
            {escalated && <Badge variant="danger">Escalada!</Badge>}
          </div>

          <div className="mb-2">
            <Text variant="small" textColor="secondary">
              {stars} • {rating.toFixed(1)}
            </Text>
          </div>

          {productName && (
            <Text variant="small" textColor="muted" className="mb-2">
              Produto: {productName}
            </Text>
          )}

          <Text variant="body" className="mb-3 text-slate-700">
            {comment}
          </Text>

          <div className="flex items-center justify-between">
            <Text variant="small" textColor="muted">
              {formattedDate}
            </Text>
            <div className="flex items-center gap-2">
              <Badge variant="info">{statusLabels[status]}</Badge>
              {onRespond && (
                <button
                  onClick={() => onRespond(id)}
                  className="ml-2 text-sm font-medium text-amber-700 hover:text-amber-800 hover:underline"
                >
                  Responder
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}
