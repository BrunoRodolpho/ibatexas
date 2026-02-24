'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { type ColumnDef, createColumnHelper } from '@tanstack/react-table'
import { ExternalLink, Package, Layers } from 'lucide-react'
import { DataTable, Switch } from '@/components/atoms'
import { SearchInput, Sheet } from '@/components/molecules'
import { useAdminProducts, useAdminProduct } from '@/hooks/admin'
import { apiFetch } from '@/lib/api'
import type { AdminProductRow } from '@ibatexas/types'

const col = createColumnHelper<AdminProductRow>()

function formatBRL(centavos: number) {
  if (!centavos) return '—'
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export default function ShopManagement() {
  const t = useTranslations()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { data: productDetail, loading: detailLoading } = useAdminProduct(selectedId)

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
        <div className="flex items-center gap-3">
          <button
            onClick={(e) => { e.stopPropagation(); setSelectedId(i.row.original.id) }}
            className="flex items-center gap-1 text-xs text-amber-700 hover:text-amber-900 font-medium"
          >
            <Layers className="h-3 w-3" />
            Variantes
          </button>
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
        </div>
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

      {/* Variant detail Sheet */}
      <Sheet
        isOpen={!!selectedId}
        title={productDetail?.title ?? t('admin.col_variants')}
        onClose={() => setSelectedId(null)}
        footer={
          selectedId ? (
            <a
              href={`http://localhost:9000/app/products/${selectedId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 w-full rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Editar no Medusa
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : undefined
        }
      >
        {detailLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-14 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : productDetail ? (
          <div className="space-y-4">
            {/* Product header */}
            <div className="flex items-start gap-3">
              {productDetail.imageUrl ? (
                <img
                  src={productDetail.imageUrl}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                  <Package className="h-6 w-6 text-slate-300" />
                </div>
              )}
              <div className="min-w-0">
                <p className="font-semibold text-slate-900">{productDetail.title}</p>
                <p className="text-xs text-slate-500">{productDetail.category}</p>
                {productDetail.description && (
                  <p className="mt-1 text-xs text-slate-400 line-clamp-2">{productDetail.description}</p>
                )}
              </div>
            </div>

            {/* Variants table */}
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">Tamanho</th>
                    <th className="px-3 py-2 text-left font-medium text-slate-600">SKU</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600">Preço</th>
                    <th className="px-3 py-2 text-right font-medium text-slate-600">Estoque</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {productDetail.variants.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-center text-slate-400">
                        Nenhuma variante cadastrada
                      </td>
                    </tr>
                  ) : (
                    productDetail.variants.map((v) => (
                      <tr key={v.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2.5 font-medium text-slate-800">{v.title}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-400">{v.sku ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right text-slate-700">{formatBRL(v.price)}</td>
                        <td className="px-3 py-2.5 text-right">
                          {v.manageInventory ? (
                            <span className={v.inventoryQuantity > 0 ? 'text-green-700' : 'text-red-600'}>
                              {v.inventoryQuantity}
                            </span>
                          ) : (
                            <span className="text-slate-400">∞</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Tags */}
            {productDetail.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {productDetail.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </Sheet>
    </div>
  )
}
