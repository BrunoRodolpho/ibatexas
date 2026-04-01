'use client'

import type { ComponentType } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { DataTable } from '../atoms/DataTable'
import { Switch } from '../atoms/Switch'
import { FilterChip } from '../molecules/FilterChip'
import type { AdminProductRow } from '@ibatexas/types'
import {
  PRODUCT_TYPE_LABELS,
  PRODUCT_COLUMN_HEADERS,
  PAGE_TITLES,
  ACTION_LABELS,
  SEARCH_PLACEHOLDERS,
  EMPTY_STATES,
  MISC_LABELS,
} from '../constants/admin-labels'

const col = createColumnHelper<AdminProductRow>()

function formatBRL(centavos: number) {
  return centavos
    ? (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : '\u2014'
}

function renderImage(
  url: string | null,
  ImageComponent?: // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ComponentType<any>,
) {
  if (!url) return <div className="h-10 w-10 rounded-sm bg-smoke-100" />
  if (ImageComponent) {
    return <ImageComponent src={url} alt="" className="h-10 w-10 rounded-md object-cover" width={40} height={40} unoptimized />
  }
  return <img src={url} alt="" className="h-10 w-10 rounded-md object-cover" width={40} height={40} />
}

const TYPE_LABELS = PRODUCT_TYPE_LABELS

function renderProductType(type: string) {
  return <span className="capitalize">{TYPE_LABELS[type] ?? type}</span>
}

function renderStatusSwitch(product: AdminProductRow, onToggle: (p: AdminProductRow) => void) {
  return (
    <Switch
      checked={product.status === 'published'}
      onChange={() => onToggle(product)}
      size="sm"
    />
  )
}

function renderEditAction(productId: string, medusaAdminUrl: string) {
  return (
    <a
      href={`${medusaAdminUrl}/app/products/${productId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-charcoal-800"
      onClick={(e) => e.stopPropagation()}
    >
      {ACTION_LABELS.edit}
      <ExternalLink className="h-3 w-3" />
    </a>
  )
}

export interface AdminCardapioPageProps {
  data: AdminProductRow[]
  loading: boolean
  error: Error | null
  medusaAdminUrl: string
  onSearch: (q: string) => void
  onTypeFilter: (type: 'food' | 'frozen' | '') => void
  typeFilter: 'food' | 'frozen' | ''
  onToggleStatus: (product: AdminProductRow) => void
  SearchInputComponent: ComponentType<{ onSearch: (q: string) => void; placeholder?: string }>
  ImageComponent?: // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ComponentType<any>
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

export function AdminCardapioPage({
  data,
  loading,
  error,
  medusaAdminUrl,
  onSearch,
  onTypeFilter,
  typeFilter,
  onToggleStatus,
  SearchInputComponent,
  ImageComponent,
}: Readonly<AdminCardapioPageProps>) {
  const columns = [
    col.accessor('imageUrl', {
      header: '',
      enableSorting: false,
      cell: (i) => renderImage(i.getValue() as string | null, ImageComponent),
    }),
    col.accessor('title', { header: PRODUCT_COLUMN_HEADERS.name }),
    col.accessor('category', { header: PRODUCT_COLUMN_HEADERS.category }),
    col.accessor('productType', {
      header: PRODUCT_COLUMN_HEADERS.type,
      cell: (i) => renderProductType(i.getValue() as string),
    }),
    col.accessor('variantCount', { header: PRODUCT_COLUMN_HEADERS.variants }),
    col.accessor('status', {
      header: PRODUCT_COLUMN_HEADERS.status,
      cell: (i) => renderStatusSwitch(i.row.original, onToggleStatus),
    }),
    col.display({
      id: 'actions',
      header: '',
      cell: (i) => renderEditAction(i.row.original.id, medusaAdminUrl),
    }),
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal-900">{PAGE_TITLES.menu}</h1>
        <a
          href={`${medusaAdminUrl}/app/products/create`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {ACTION_LABELS.addProduct}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInputComponent
          onSearch={onSearch}
          placeholder={SEARCH_PLACEHOLDERS.products}
        />
        <FilterChip
          id="food"
          label={PRODUCT_TYPE_LABELS.food}
          selected={typeFilter === 'food'}
          onToggle={() => onTypeFilter(typeFilter === 'food' ? '' : 'food')}
        />
        <FilterChip
          id="frozen"
          label={PRODUCT_TYPE_LABELS.frozen}
          selected={typeFilter === 'frozen'}
          onToggle={() => onTypeFilter(typeFilter === 'frozen' ? '' : 'frozen')}
        />
        {typeFilter && (
          <button
            onClick={() => onTypeFilter('')}
            className="flex items-center gap-1 text-sm text-[var(--color-text-secondary)] hover:text-charcoal-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {ACTION_LABELS.clearFilters}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-accent-red/10 p-4 text-sm text-accent-red">
          {MISC_LABELS.errorPrefix} {error.message}
        </div>
      )}

      <DataTable
        data={data}
        columns={columns}
        isLoading={loading}
        emptyMessage={EMPTY_STATES.products}
        pageSize={25}
      />
    </div>
  )
}
