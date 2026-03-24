'use client'

import { createColumnHelper } from '@tanstack/react-table'
import { Star } from 'lucide-react'
import { DataTable } from '../atoms/DataTable'
import { FilterChip } from '../molecules/FilterChip'

export interface AdminReview {
  id: string
  rating: number
  comment: string | null
  productId: string | null
  customerPhone: string | null
  createdAt: string
}

const col = createColumnHelper<AdminReview>()

const RATING_FILTERS = [
  { id: '', label: 'Todos' },
  { id: '5', label: '5' },
  { id: '4', label: '4' },
  { id: '3', label: '3' },
  { id: '2', label: '2' },
  { id: '1', label: '1' },
] as const

function renderStars(rating: number) {
  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className={`h-3.5 w-3.5 ${i < rating ? 'fill-brand-500 text-brand-500' : 'text-smoke-200'}`}
        />
      ))}
    </span>
  )
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    })
  } catch {
    return iso
  }
}

export interface AdminAvaliacoesPageProps {
  reviews: AdminReview[]
  loading: boolean
  ratingFilter: string
  onRatingFilter: (rating: string) => void
}

export function AdminAvaliacoesPage({
  reviews,
  loading,
  ratingFilter,
  onRatingFilter,
}: Readonly<AdminAvaliacoesPageProps>) {
  const columns = [
    col.accessor('rating', {
      header: 'Estrelas',
      cell: (i) => renderStars(i.getValue()),
    }),
    col.accessor('comment', {
      header: 'Comentário',
      cell: (i) => i.getValue() ?? '—',
    }),
    col.accessor('productId', {
      header: 'Produto',
      cell: (i) => {
        const id = i.getValue()
        return id ? <span className="font-mono text-xs text-smoke-400">{id.slice(0, 8)}…</span> : '—'
      },
    }),
    col.accessor('customerPhone', {
      header: 'Cliente',
      cell: (i) => i.getValue() ?? '—',
    }),
    col.accessor('createdAt', {
      header: 'Data',
      cell: (i) => formatDate(i.getValue()),
    }),
  ]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-charcoal-900">Avaliações</h1>

      <div className="flex flex-wrap items-center gap-3">
        {RATING_FILTERS.map((f) => (
          <FilterChip
            key={f.id}
            id={f.id}
            label={f.id ? `${f.label} ★` : f.label}
            selected={ratingFilter === f.id}
            onToggle={() => onRatingFilter(ratingFilter === f.id ? '' : f.id)}
          />
        ))}
      </div>

      <DataTable
        data={reviews}
        columns={columns}
        isLoading={loading}
        emptyMessage="Nenhuma avaliação encontrada"
        pageSize={20}
        rowClassName={(r) => r.rating <= 2 ? 'bg-red-50' : undefined}
      />
    </div>
  )
}
