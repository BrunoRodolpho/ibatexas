'use client'

import { useState } from 'react'
import Image from 'next/image'
import { MEDUSA_ADMIN_URL, apiFetch } from '@/lib/api'
import { useAdminProducts, useAdminProduct } from '@/domains/admin'
import { SearchInput, Sheet } from '@/components/molecules'
import { AdminLojaPage, useToast } from '@ibatexas/ui'
import type { AdminProductRow } from '@ibatexas/types'

export default function ShopManagement() {
  const { addToast } = useToast()
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
      addToast({ type: 'success', message: 'Status do produto atualizado' })
    } catch (e) {
      console.error('Failed to toggle status', e)
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'Erro ao atualizar status' })
    }
  }

  const handleToggleStock = async (product: AdminProductRow) => {
    try {
      await apiFetch(`/api/admin/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ metadata: { inStock: !product.inStock } }),
      })
      addToast({ type: 'success', message: 'Estoque atualizado' })
    } catch (e) {
      console.error('Failed to toggle stock', e)
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'Erro ao atualizar estoque' })
    }
  }

  return (
    <AdminLojaPage
      data={data}
      loading={loading}
      error={error}
      selectedId={selectedId}
      onSelectId={setSelectedId}
      productDetail={productDetail}
      detailLoading={detailLoading}
      medusaAdminUrl={MEDUSA_ADMIN_URL}
      onSearch={setSearch}
      onToggleStatus={handleToggleStatus}
      onToggleStock={handleToggleStock}
      SearchInputComponent={SearchInput}
      SheetComponent={Sheet}
      ImageComponent={Image}
      onSuccess={(msg) => addToast({ type: 'success', message: msg })}
      onError={(msg) => addToast({ type: 'error', message: msg })}
    />
  )
}
