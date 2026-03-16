'use client'

import { useState } from 'react'
import Image from 'next/image'
import { createColumnHelper } from '@tanstack/react-table'
import { ExternalLink, Package, Layers } from 'lucide-react'
import { DataTable, Switch } from '@/components/atoms'
import { SearchInput, Sheet } from '@/components/molecules'
import { MEDUSA_ADMIN_URL, apiFetch } from '@/lib/api'
import { useAdminProducts, useAdminProduct } from '@/domains/admin'
import type { AdminProductRow } from '@ibatexas/types'

const col = createColumnHelper<AdminProductRow>()

function formatBRL(centavos: number) {
  if (!centavos) return '—'
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// ── Cell renderers (module-level to satisfy S6478) ──────────────────────────

function renderShopImage(url: string | null) {
  return url ? (
    <Image src={url} alt="" className="h-10 w-10 rounded-md object-cover" width={40} height={40} unoptimized />
  ) : (
    <div className="h-10 w-10 rounded-sm bg-smoke-100" />
  )
}

function renderStockSwitch(product: AdminProductRow, onToggle: (p: AdminProductRow) => void) {
  return (
    <Switch
      checked={product.inStock}
      onChange={() => onToggle(product)}
      size="sm"
      label={product.inStock ? 'Em estoque' : 'Sem estoque'}
    />
  )
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

function renderShopActions(productId: string, onSelect: (id: string) => void) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={(e) => { e.stopPropagation(); onSelect(productId) }}
        className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-800 font-medium"
      >
        <Layers className="h-3 w-3" />
        Variantes
      </button>
      <a
        href={`${MEDUSA_ADMIN_URL}/app/products/${productId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-smoke-400 hover:text-charcoal-800"
        onClick={(e) => e.stopPropagation()}
      >
        Editar
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  )
}

export default function ShopManagement() {
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

  const columns = [
    col.accessor('imageUrl', {
      header: '',
      enableSorting: false,
      cell: (i) => renderShopImage(i.getValue() as string | null),
    }),
    col.accessor('title', { header: 'Nome' }),
    col.accessor('category', { header: 'Categoria' }),
    col.accessor('variantCount', {
      header: 'Variantes',
      cell: (i) => `${i.getValue()} tamanho(s)`,
    }),
    col.accessor('inStock', {
      header: 'Estoque',
      cell: (i) => renderStockSwitch(i.row.original, handleToggleStock),
    }),
    col.accessor('status', {
      header: 'Status',
      cell: (i) => renderStatusSwitch(i.row.original, handleToggleStatus),
    }),
    col.display({
      id: 'actions',
      header: '',
      cell: (i) => renderShopActions(i.row.original.id, setSelectedId),
    }),
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal-900">Loja</h1>
        <a
          href={`${MEDUSA_ADMIN_URL}/app/products/create`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          + Adicionar produto
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          onSearch={(q) => setSearch(q)}
          placeholder="Buscar produtos..."
        />
      </div>

      {error && (
        <div className="rounded-lg bg-accent-red/10 p-4 text-sm text-accent-red">
          Erro: {error.message}
        </div>
      )}

      <DataTable
        data={data}
        columns={columns}
        isLoading={loading}
        emptyMessage="Nenhum produto encontrado"
        pageSize={25}
      />

      <Sheet
        isOpen={!!selectedId}
        title={productDetail?.title ?? 'Variantes'}
        onClose={() => setSelectedId(null)}
        footer={
          selectedId ? (
            <a
              href={`${MEDUSA_ADMIN_URL}/app/products/${selectedId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 w-full rounded-sm border border-smoke-200 px-4 py-2 text-sm font-medium text-charcoal-700 hover:bg-smoke-100"
            >
              Editar no Medusa
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : undefined
        }
      >
        {detailLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-14 animate-pulse rounded-sm bg-smoke-100" />
            ))}
          </div>
        )}
        {!detailLoading && productDetail && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              {productDetail.imageUrl ? (
                <Image
                  src={productDetail.imageUrl}
                  alt={productDetail.title}
                  className="h-14 w-14 shrink-0 rounded-lg object-cover"
                  width={56}
                  height={56}
                  unoptimized
                />
              ) : (
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-sm bg-smoke-100">
                  <Package className="h-6 w-6 text-smoke-300" />
                </div>
              )}
              <div className="min-w-0">
                <p className="font-semibold text-charcoal-900">{productDetail.title}</p>
                <p className="text-xs text-smoke-400">{productDetail.category}</p>
                {productDetail.description && (
                  <p className="mt-1 text-xs text-smoke-300 line-clamp-2">{productDetail.description}</p>
                )}
              </div>
            </div>

            <div className="overflow-hidden rounded-sm border border-smoke-200">
              <table className="w-full text-sm">
                <thead className="bg-smoke-100">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-charcoal-700">Tamanho</th>
                    <th scope="col" className="px-3 py-2 text-left font-medium text-charcoal-700">SKU</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium text-charcoal-700">Preço</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium text-charcoal-700">Estoque</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-smoke-100">
                  {productDetail.variants.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-center text-smoke-300">
                        Nenhuma variante cadastrada
                      </td>
                    </tr>
                  ) : (
                    productDetail.variants.map((v) => (
                      <tr key={v.id} className="hover:bg-smoke-100">
                        <td className="px-3 py-2.5 font-medium text-charcoal-800">{v.title}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-smoke-300">{v.sku ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right text-charcoal-700">{formatBRL(v.price)}</td>
                        <td className="px-3 py-2.5 text-right">
                          {v.manageInventory ? (
                            <span className={v.inventoryQuantity > 0 ? 'text-green-700' : 'text-red-600'}>
                              {v.inventoryQuantity}
                            </span>
                          ) : (
                            <span className="text-smoke-300">∞</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {productDetail.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {productDetail.tags.map((tag) => (
                  <span key={tag} className="rounded-sm bg-smoke-100 px-2.5 py-0.5 text-xs text-charcoal-700">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Sheet>
    </div>
  )
}
