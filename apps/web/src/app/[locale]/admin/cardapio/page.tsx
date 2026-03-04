'use client'

import { useState } from 'react'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { createColumnHelper } from '@tanstack/react-table'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { DataTable, Badge, Switch } from '@/components/atoms'
import { SearchInput, FilterChip } from '@/components/molecules'
import { MEDUSA_ADMIN_URL } from '@/lib/api'
import { useAdminProducts } from '@/hooks/admin'
import { apiFetch } from '@/lib/api'
import type { AdminProductRow } from '@ibatexas/types'

const col = createColumnHelper<AdminProductRow>()

function formatBRL(centavos: number) {
  return centavos
    ? (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : '—'
}

export default function MenuManagement() {
  const t = useTranslations()
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'food' | 'frozen' | ''>('')

  const { data, loading, error } = useAdminProducts({
    q: search || undefined,
    productType: typeFilter || undefined,
    limit: 100,
  })

  const handleToggleStatus = async (product: AdminProductRow) => {
    const newStatus = product.status === 'published' ? 'draft' : 'published'
    try {
      await apiFetch(`/api/admin/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
    } catch (e) {
      console.error('Failed to toggle status', e)
    }
  }

  const columns = [
    col.accessor('imageUrl', {
      header: '',
      enableSorting: false,
      cell: (i) => {
        const url = i.getValue() as string | null
        return url ? (
          <Image src={url} alt="" className="h-10 w-10 rounded-md object-cover" width={40} height={40} unoptimized />
        ) : (
          <div className="h-10 w-10 rounded-sm bg-smoke-100" />
        )
      },
    }),
    col.accessor('title', { header: t('admin.col_name') }),
    col.accessor('category', { header: t('admin.col_category') }),
    col.accessor('productType', {
      header: t('admin.col_type'),
      cell: (i) => {
        const type = i.getValue() as string
        const labels: Record<string, string> = { food: 'Comida', frozen: 'Congelado', merchandise: 'Loja' }
        return <span className="capitalize">{labels[type] ?? type}</span>
      },
    }),
    col.accessor('variantCount', { header: t('admin.col_variants') }),
    col.accessor('status', {
      header: t('admin.col_status'),
      cell: (i) => {
        const product = i.row.original
        return (
          <Switch
            checked={product.status === 'published'}
            onChange={() => handleToggleStatus(product)}
            size="sm"
          />
        )
      },
    }),
    col.display({
      id: 'actions',
      header: '',
      cell: (i) => (
        <a
          href={`${MEDUSA_ADMIN_URL}/app/products/${i.row.original.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-smoke-400 hover:text-charcoal-800"
          onClick={(e) => e.stopPropagation()}
        >
          Editar
          <ExternalLink className="h-3 w-3" />
        </a>
      ),
    }),
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal-900">{t('admin.menu')}</h1>
        <a
          href={`${MEDUSA_ADMIN_URL}/app/products/create`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          + {t('admin.add_product')}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          onSearch={(q) => setSearch(q)}
          placeholder={t('admin.search_products')}
        />
        <FilterChip
          id="food"
          label="Comida"
          selected={typeFilter === 'food'}
          onToggle={() => setTypeFilter(typeFilter === 'food' ? '' : 'food')}
        />
        <FilterChip
          id="frozen"
          label="Congelado"
          selected={typeFilter === 'frozen'}
          onToggle={() => setTypeFilter(typeFilter === 'frozen' ? '' : 'frozen')}
        />
        {typeFilter && (
          <button
            onClick={() => setTypeFilter('')}
            className="flex items-center gap-1 text-sm text-smoke-400 hover:text-charcoal-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('search.reset_filters')}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-accent-red/10 p-4 text-sm text-accent-red">
          {t('common.error')}: {error.message}
        </div>
      )}

      <DataTable
        data={data}
        columns={columns}
        isLoading={loading}
        emptyMessage={t('admin.no_products')}
        pageSize={25}
      />
    </div>
  )
}
