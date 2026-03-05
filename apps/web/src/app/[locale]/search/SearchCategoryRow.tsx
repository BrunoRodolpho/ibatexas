'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import { track } from '@/lib/analytics'

interface CategoryOption {
  id: string
  label: string
}

interface SearchCategoryRowProps {
  categories: CategoryOption[]
  selectedCategory: string | undefined
  onCategoryChange: (categoryId: string) => void
  onClearCategory: () => void
}

/**
 * Horizontal scrollable typographic category row with "Todos" reset.
 */
export function SearchCategoryRow({
  categories,
  selectedCategory,
  onCategoryChange,
  onClearCategory,
}: SearchCategoryRowProps) {
  const t = useTranslations()

  return (
    <div className="surface-card rounded-card p-1.5 flex items-center gap-1 mb-8 overflow-x-auto scrollbar-hide mt-2">
      {/* "Todos" reset option */}
      <button
        onClick={() => {
          onClearCategory()
          track('filter_applied', { filterType: 'category', value: 'all' })
        }}
        className={`flex-shrink-0 text-sm font-medium tracking-wide px-4 py-2 rounded-sm transition-all duration-500 ease-luxury focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
          !selectedCategory
            ? 'bg-charcoal-900 text-smoke-50 font-semibold'
            : 'text-smoke-500 hover:text-charcoal-900'
        }`}
      >
        {t('common.all')}
      </button>
      {categories.map((cat) => (
        <button
          key={cat.id}
          onClick={() => onCategoryChange(cat.id)}
          className={`flex-shrink-0 text-sm font-medium tracking-wide px-4 py-2 rounded-sm transition-all duration-500 ease-luxury focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
            selectedCategory === cat.id
              ? 'bg-charcoal-900 text-smoke-50 font-semibold'
              : 'text-smoke-500 hover:text-charcoal-900'
          }`}
        >
          {cat.label}
        </button>
      ))}
    </div>
  )
}
