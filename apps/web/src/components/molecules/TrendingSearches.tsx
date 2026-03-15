'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { TrendingUp } from 'lucide-react'
import { track } from '@/domains/analytics'
import type { ProductDTO } from '@ibatexas/types'

interface TrendingSearchesProps {
  products: ProductDTO[]
  onSearch: (query: string) => void
}

/**
 * Trending search pills — derived from popular products in the catalog.
 * Shown when the search input is empty to guide discovery.
 */
export function TrendingSearches({ products, onSearch }: TrendingSearchesProps) {
  const t = useTranslations()

  const trendingTerms = useMemo(() => {
    if (products.length === 0) return []

    // Derive trending from popular-tagged products (unique titles, capped at 6)
    const popular = products
      .filter((p) => p.tags?.includes('popular'))
      .slice(0, 6)
      .map((p) => p.title)

    // Deduplicate
    return [...new Set(popular)]
  }, [products])

  if (trendingTerms.length === 0) return null

  const handleClick = (term: string) => {
    track('trending_search_clicked', { term })
    onSearch(term)
  }

  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 mb-3">
        <TrendingUp className="w-3.5 h-3.5 text-brand-500" strokeWidth={2} />
        <span className="text-xs font-medium uppercase tracking-editorial text-smoke-400">
          {t('search.trending')}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {trendingTerms.map((term) => (
          <button
            key={term}
            onClick={() => handleClick(term)}
            className="rounded-full border border-smoke-200 bg-smoke-50 px-3 py-1.5 text-xs font-medium text-charcoal-700 hover:border-smoke-300 hover:bg-smoke-100 transition-all duration-300 ease-luxury"
          >
            {term}
          </button>
        ))}
      </div>
    </div>
  )
}
