'use client'

import { AdminAnalisesPage } from '@ibatexas/ui'
import { useAdminAnalytics } from '@/domains/admin/admin.hooks'

export default function AnalisesPage() {
  const { metrics, loading } = useAdminAnalytics()

  return (
    <AdminAnalisesPage
      metrics={metrics}
      loading={loading}
    />
  )
}
