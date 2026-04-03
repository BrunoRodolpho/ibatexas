'use client'

import { AdminAvaliacoesPage, useToast } from '@ibatexas/ui'
import { useAdminReviews } from '@/domains/admin/admin.hooks'

export default function AvaliacoesPage(): React.JSX.Element {
  const { addToast } = useToast()
  const { reviews, loading, ratingFilter, setRatingFilter } = useAdminReviews()

  return (
    <AdminAvaliacoesPage
      reviews={reviews}
      loading={loading}
      ratingFilter={ratingFilter}
      onRatingFilter={setRatingFilter}
      onSuccess={(msg) => addToast({ type: 'success', message: msg })}
      onError={(msg) => addToast({ type: 'error', message: msg })}
    />
  )
}
