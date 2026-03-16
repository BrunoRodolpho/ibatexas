'use client'

import { useState } from 'react'
import Image from 'next/image'
import { createColumnHelper } from '@tanstack/react-table'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { DataTable, Switch } from '@/components/atoms'
import { SearchInput, FilterChip } from '@/components/molecules'
import { MEDUSA_ADMIN_URL, apiFetch } from '@/lib/api'
import { useAdminProducts } from '@/domains/admin'
import type { AdminProductRow } from '@ibatexas/types'

const col = createColumnHelper<AdminProductRow>()

function formatBRL(centavos: number) {
  return centavos
    ? (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : '—'
}

// ── Cell renderers (module-level to satisfy S6478) ──────────────────────────

function renderImage(url: string | null) {
  return url ? (
    <Image src={url} alt="" className="h-10 w-10 rounded-md object-cover" width={40} height={40} unoptimized />
  ) : (
    <div className="h-10 w-10 rounded-sm bg-smoke-100" />
  )
}

const TYPE_LABELS: Record<string, string> = { food: 'Comida', frozen: 'Congelado', merchandise: 'Loja' }

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

function renderEditAction(productId: string) {
  return (
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
  )
}

export default function MenuManagement() {
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
      cell: (i) => renderImage(i.getValue() as string | null),
    }),
    col.accessor('title', { header: 'Nome' }),
    col.accessor('category', { header: 'Categoria' }),
    col.accessor('productType', {
      header: 'Tipo',
      cell: (i) => renderProductType(i.getValue() as string),
    }),
    col.accessor('variantCount', { header: 'Variantes' }),
    col.accessor('status', {
      header: 'Status',
      cell: (i) => renderStatusSwitch(i.row.original, handleToggleStatus),
    }),
    col.display({
      id: 'actions',
      header: '',
      cell: (i) => renderEditAction(i.row.original.id),
    }),
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal-900">Cardápio</h1>
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
            Limpar filtros
          </button>
        )}
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
    </div>
  )
}
