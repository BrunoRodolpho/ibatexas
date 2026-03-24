'use client'

import { AdminAvaliacoesPage } from '@ibatexas/ui'
import { useAdminReviews } from '@/domains/admin/admin.hooks'

export default function AvaliacoesPage() {
  const { reviews, loading, ratingFilter, setRatingFilter } = useAdminReviews()

  return (
    <AdminAvaliacoesPage
      reviews={reviews}
      loading={loading}
      ratingFilter={ratingFilter}
      onRatingFilter={setRatingFilter}
    />
  )
}
