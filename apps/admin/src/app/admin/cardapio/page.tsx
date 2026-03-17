'use client'

import { useState } from 'react'
import Image from 'next/image'
import { MEDUSA_ADMIN_URL, apiFetch } from '@/lib/api'
import { useAdminProducts } from '@/domains/admin'
import { SearchInput } from '@/components/molecules'
import { AdminCardapioPage } from '@ibatexas/ui'
import type { AdminProductRow } from '@ibatexas/types'

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
    />
  )
}
