'use client'

import { createColumnHelper } from '@tanstack/react-table'
import { Star } from 'lucide-react'
import { DataTable } from '../atoms/DataTable'
import { FilterChip } from '../molecules/FilterChip'
import {
  RATING_FILTERS as RATING_FILTER_OPTIONS,
  REVIEW_COLUMN_HEADERS,
  PAGE_TITLES,
  EMPTY_STATES,
} from '../constants/admin-labels'

export interface AdminReview {
  id: string
  rating: number
  comment: string | null
  productId: string | null
  customerPhone: string | null
  createdAt: string
}

const col = createColumnHelper<AdminReview>()

const RATING_FILTERS = RATING_FILTER_OPTIONS

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
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

export function AdminAvaliacoesPage({
  reviews,
  loading,
  ratingFilter,
  onRatingFilter,
}: Readonly<AdminAvaliacoesPageProps>) {
  const columns = [
    col.accessor('rating', {
      header: REVIEW_COLUMN_HEADERS.stars,
      cell: (i) => renderStars(i.getValue()),
    }),
    col.accessor('comment', {
      header: REVIEW_COLUMN_HEADERS.comment,
      cell: (i) => i.getValue() ?? '—',
    }),
    col.accessor('productId', {
      header: REVIEW_COLUMN_HEADERS.product,
      cell: (i) => {
        const id = i.getValue()
        return id ? <span className="font-mono text-xs text-[var(--color-text-secondary)]">{id.slice(0, 8)}…</span> : '—'
      },
    }),
    col.accessor('customerPhone', {
      header: REVIEW_COLUMN_HEADERS.customer,
      cell: (i) => i.getValue() ?? '—',
    }),
    col.accessor('createdAt', {
      header: REVIEW_COLUMN_HEADERS.date,
      cell: (i) => formatDate(i.getValue()),
    }),
  ]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-charcoal-900">{PAGE_TITLES.reviews}</h1>

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
        emptyMessage={EMPTY_STATES.reviews}
        pageSize={20}
        rowClassName={(r) => r.rating <= 2 ? 'bg-red-50' : undefined}
      />
    </div>
  )
}
