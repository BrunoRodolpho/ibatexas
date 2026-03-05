'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import { Select } from '@/components/atoms'

interface TagOption {
  id: string
  label: string
}

interface SortOption {
  value: string
  label: string
}

interface SearchFilterPanelProps {
  tags: TagOption[]
  sortOptions: SortOption[]
  selectedTags: string[]
  selectedSort: string
  isFilterOpen: boolean
  onToggleFilter: () => void
  onTagToggle: (tagId: string) => void
  onSortChange: (value: string) => void
  onResetFilters: () => void
  hasActiveFilters: boolean
}

/**
 * Collapsible filter panel with desktop sort control, tag grid, and active-filter pills.
 */
export function SearchFilterPanel({
  tags,
  sortOptions,
  selectedTags,
  selectedSort,
  isFilterOpen,
  onToggleFilter,
  onTagToggle,
  onSortChange,
  onResetFilters,
  hasActiveFilters,
}: SearchFilterPanelProps) {
  const t = useTranslations()

  return (
    <>
      {/* Desktop sort & filter controls */}
      <div className="hidden sm:flex items-center gap-4">
        <Select
          variant="minimal"
          value={selectedSort}
          onChange={(e) => onSortChange(e.target.value)}
          options={sortOptions}
          className="font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900"
        />
        <button
          onClick={onToggleFilter}
          aria-expanded={isFilterOpen}
          className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 transition-colors duration-500 ease-luxury"
        >
          {isFilterOpen ? '✕ Fechar' : t('search.filter')}
          {!isFilterOpen && selectedTags.length > 0 && (
            <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded-full bg-charcoal-900 text-smoke-50 text-[9px] font-semibold">
              {selectedTags.length}
            </span>
          )}
        </button>
      </div>

      {/* Collapsible filter overlay (desktop) */}
      {isFilterOpen && (
        <div className="mb-12 animate-reveal">
          <div className="surface-card rounded-card p-8">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {tags.map((tag) => {
                const isActive = selectedTags.includes(tag.id)
                return (
                  <button
                    key={tag.id}
                    onClick={() => onTagToggle(tag.id)}
                    className={`px-3 py-2 rounded-sm text-sm transition-all duration-500 ease-luxury ${
                      isActive
                        ? 'bg-charcoal-900 text-smoke-50'
                        : 'bg-smoke-100 text-smoke-500 hover:bg-smoke-200'
                    }`}
                  >
                    {tag.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Active filters: tactile removable pills */}
      {hasActiveFilters && !isFilterOpen && (
        <div className="mb-8 flex flex-wrap items-center gap-2">
          {selectedTags.map((tagId) => {
            const tag = tags.find((t) => t.id === tagId)
            return (
              <button
                key={tagId}
                onClick={() => onTagToggle(tagId)}
                className="bg-smoke-100 rounded-sm px-3 py-1.5 text-xs font-medium text-charcoal-900 hover:bg-smoke-200 transition-colors duration-500 ease-luxury"
              >
                {tag?.label || tagId} ✕
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
