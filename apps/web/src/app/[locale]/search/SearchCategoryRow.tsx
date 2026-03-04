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
    <div className="flex items-center gap-6 mb-8 overflow-x-auto scrollbar-hide marquee-mask pb-1 mt-2">
      {/* "Todos" reset option */}
      <button
        onClick={() => {
          onClearCategory()
          track('filter_applied', { filterType: 'category', value: 'all' })
        }}
        className={`flex-shrink-0 text-xs font-medium uppercase tracking-editorial py-3 transition-colors duration-500 ease-luxury focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
          !selectedCategory
            ? 'text-charcoal-900 font-semibold border-b-2 border-charcoal-900'
            : 'text-smoke-400 hover:text-charcoal-900'
        }`}
      >
        {t('common.all')}
      </button>
      {categories.map((cat) => (
        <button
          key={cat.id}
          onClick={() => onCategoryChange(cat.id)}
          className={`flex-shrink-0 text-xs font-medium uppercase tracking-editorial py-3 transition-colors duration-500 ease-luxury focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
            selectedCategory === cat.id
              ? 'text-charcoal-900 font-semibold border-b-2 border-charcoal-900'
              : 'text-smoke-400 hover:text-charcoal-900'
          }`}
        >
          {cat.label}
        </button>
      ))}
    </div>
  )
}
