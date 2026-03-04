'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import { UtensilsCrossed } from 'lucide-react'

interface CategoryOption {
  id: string
  label: string
}

interface SearchEmptyStateProps {
  searchQuery: string
  categories: CategoryOption[]
  onCategoryChange: (categoryId: string) => void
}

/**
 * Empty-result state with query feedback and suggested categories.
 */
export function SearchEmptyState({
  searchQuery,
  categories,
  onCategoryChange,
}: SearchEmptyStateProps) {
  const t = useTranslations()

  return (
    <div className="flex flex-col items-center justify-center py-24 gap-6">
      <div className="w-16 h-16 rounded-full bg-smoke-100 flex items-center justify-center">
        <UtensilsCrossed className="w-7 h-7 text-smoke-300" strokeWidth={1.5} />
      </div>
      <div className="text-center">
        <p className="font-display text-xl text-charcoal-900 tracking-display mb-2">
          {searchQuery
            ? t('search.no_results_for', { query: searchQuery })
            : t('search.no_results')}
        </p>
        <p className="text-sm text-smoke-400 max-w-md">
          {searchQuery
            ? t('search.no_results_hint_search')
            : t('search.no_results_hint')}
        </p>
      </div>
      <div className="h-px w-16 bg-smoke-200" />
      {/* Suggested categories */}
      <div className="flex flex-wrap justify-center gap-3">
        {categories.slice(0, 4).map((cat) => (
          <button
            key={cat.id}
            onClick={() => onCategoryChange(cat.id)}
            className="px-4 py-3 rounded-sm border border-smoke-200 text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 hover:border-charcoal-900 transition-all duration-500 ease-luxury"
          >
            {cat.label}
          </button>
        ))}
      </div>
    </div>
  )
}
