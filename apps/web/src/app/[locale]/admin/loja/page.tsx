'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { type ColumnDef, createColumnHelper } from '@tanstack/react-table'
import { ExternalLink } from 'lucide-react'
import { DataTable, Badge, Switch } from '@/components/atoms'
import { SearchInput } from '@/components/molecules'
import { useAdminProducts } from '@/hooks/admin'
import { apiFetch } from '@/lib/api'
import type { AdminProductRow } from '@ibatexas/types'

const col = createColumnHelper<AdminProductRow>()

export default function ShopManagement() {
  const t = useTranslations()
  const [search, setSearch] = useState('')

  const { data, loading, error } = useAdminProducts({
    q: search || undefined,
    productType: 'merchandise',
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

  const handleToggleStock = async (product: AdminProductRow) => {
    try {
      await apiFetch(`/api/admin/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ metadata: { inStock: !product.inStock } }),
      })
    } catch (e) {
      console.error('Failed to toggle stock', e)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columns: ColumnDef<AdminProductRow, any>[] = [
    col.accessor('imageUrl', {
      header: '',
      enableSorting: false,
      cell: (i) => {
        const url = i.getValue() as string | null
        return url ? (
          <img src={url} alt="" className="h-10 w-10 rounded-md object-cover" />
        ) : (
          <div className="h-10 w-10 rounded-md bg-slate-100" />
        )
      },
    }),
    col.accessor('title', { header: t('admin.col_name') }),
    col.accessor('category', { header: t('admin.col_category') }),
    col.accessor('variantCount', {
      header: t('admin.col_variants'),
      cell: (i) => `${i.getValue()} tamanho(s)`,
    }),
    col.accessor('inStock', {
      header: t('admin.col_stock'),
      cell: (i) => {
        const product = i.row.original
        return (
          <Switch
            checked={product.inStock}
            onChange={() => handleToggleStock(product)}
            size="sm"
            label={product.inStock ? 'Em estoque' : 'Sem estoque'}
          />
        )
      },
    }),
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
          href={`http://localhost:9000/app/products/${i.row.original.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
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
        <h1 className="text-2xl font-bold text-slate-900">{t('admin.shop')}</h1>
        <a
          href="http://localhost:9000/app/products/create"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800"
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

      </div>

      {error && (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
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
