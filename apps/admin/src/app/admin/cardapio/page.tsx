'use client'

import { useState } from 'react'
import Image from 'next/image'
import { MEDUSA_ADMIN_URL, apiFetch } from '@/lib/api'
import { useAdminProducts } from '@/domains/admin'
import { SearchInput } from '@/components/molecules'
import { AdminCardapioPage, useToast } from '@ibatexas/ui'
import type { AdminProductRow } from '@ibatexas/types'

export default function MenuManagement(): React.JSX.Element {
  const { addToast } = useToast()
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
      addToast({ type: 'success', message: 'Status do produto atualizado' })
    } catch (e) {
      console.error('Failed to toggle status', e)
      addToast({ type: 'error', message: e instanceof Error ? e.message : 'Erro ao atualizar status' })
    }
  }

  return (
    <AdminCardapioPage
      data={data}
      loading={loading}
      error={error}
      medusaAdminUrl={MEDUSA_ADMIN_URL}
      onSearch={setSearch}
      onTypeFilter={setTypeFilter}
      typeFilter={typeFilter}
      onToggleStatus={handleToggleStatus}
      SearchInputComponent={SearchInput}
      ImageComponent={Image}
      onSuccess={(msg) => addToast({ type: 'success', message: msg })}
      onError={(msg) => addToast({ type: 'error', message: msg })}
    />
  )
}
