'use client'

import React, { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Heading, Text, Button } from '@/components/atoms'
import { SearchInput } from '@/components/molecules'
import { ProductGrid } from '@/components/organisms'
import { useUIStore, useCartStore } from '@/stores'
import { useProducts } from '@/hooks/api'
import type { ProductDTO } from '@ibatexas/types'

const TAG_IDS = ['novo', 'popular', 'chef_choice', 'vegetariano', 'vegan', 'sem_gluten'] as const
const CATEGORY_IDS = ['almoco', 'jantar', 'congelados', 'sobremesas', 'bebidas'] as const
const SORT_VALUES = ['relevance', 'price_asc', 'price_desc', 'rating', 'popular'] as const

export default function SearchPage() {
  const t = useTranslations()
  const [searchQuery, setSearchQuery] = useState('')
  const [isFilterOpen, setIsFilterOpen] = useState(false)

  const { selectedFilters, setFilters, resetFilters, addToast } = useUIStore()
  const addItem = useCartStore((s) => s.addItem)

  const activeTags = useMemo(
    () => (selectedFilters.tags.length > 0 ? selectedFilters.tags : undefined),
    [selectedFilters.tags]
  )

  const TAGS = TAG_IDS.map((id) => ({ id, label: t(`search.tags_list.${id}`) }))
  const CATEGORIES = CATEGORY_IDS.map((id) => ({ id, label: t(`search.categories_list.${id}`) }))
  const SORT_OPTIONS = SORT_VALUES.map((value) => ({ value, label: t(`search.sort.${value}`) }))

  const { data: productsData, loading: isLoading } = useProducts(
    searchQuery || undefined,
    activeTags,
    20
  )

  const products = productsData?.products ?? []
  const totalFound = productsData?.totalFound ?? 0

  const handleSearch = (query: string) => setSearchQuery(query)

  const handleTagToggle = (tagId: string) => {
    const newTags = selectedFilters.tags.includes(tagId)
      ? selectedFilters.tags.filter((t) => t !== tagId)
      : [...selectedFilters.tags, tagId]
    setFilters({ ...selectedFilters, tags: newTags })
  }

  const handleCategoryChange = (categoryId: string) => {
    setFilters({ ...selectedFilters, category: categoryId === selectedFilters.category ? undefined : categoryId })
  }

  const handleSortChange = (sortValue: string) => {
    setFilters({ ...selectedFilters, sort: sortValue })
  }

  const hasActiveFilters = selectedFilters.tags.length > 0 || selectedFilters.category || selectedFilters.priceRange

  return (
    <div className="min-h-screen bg-smoke-50">
      {/* ── Search bar: minimal, borderless feel ──────────────────── */}
      <div className="sticky top-[56px] z-20 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200 px-4 py-3">
        <div className="max-w-[1200px] mx-auto">
          <SearchInput
            placeholder={t('search.placeholder')}
            onSearch={handleSearch}
            isLoading={isLoading}
            debounceMs={300}
          />
        </div>
      </div>

      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16 lg:py-20">
        {/* ── Page header with inline controls ──────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-12">
          <div>
            <h1 className="font-display text-display-sm font-semibold text-charcoal-900 tracking-display">
              {isLoading
                ? t('search.searching')
                : totalFound > 0
                  ? `${totalFound} ${t('search.results')}`
                  : t('search.title')}
            </h1>
            {hasActiveFilters && (
              <button
                onClick={resetFilters}
                className="mt-2 text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 transition-colors duration-500 ease-luxury"
              >
                {t('search.reset_filters')}
              </button>
            )}
          </div>

          <div className="flex items-center gap-4">
            {/* Inline sort — borderless dropdown */}
            <select
              value={selectedFilters.sort || 'relevance'}
              onChange={(e) => handleSortChange(e.target.value)}
              className="appearance-none bg-transparent text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 cursor-pointer focus:outline-none transition-colors duration-500 ease-luxury pr-4"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e%3cpath fill='none' stroke='%23999' stroke-linecap='round' stroke-width='1.5' d='M4 6l4 4 4-4'/%3e%3c/svg%3e")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right center',
                backgroundSize: '1em 1em',
              }}
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            {/* Filter toggle */}
            <button
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              className="text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 transition-colors duration-500 ease-luxury"
            >
              {isFilterOpen ? '✕ Fechar' : t('search.filter')}
            </button>
          </div>
        </div>

        {/* ── Typographic category row ────────────────────────────── */}
        <div className="flex items-center gap-6 mb-8 overflow-x-auto scrollbar-hide pb-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => handleCategoryChange(cat.id)}
              className={`flex-shrink-0 text-xs font-medium uppercase tracking-editorial transition-colors duration-500 ease-luxury ${
                selectedFilters.category === cat.id
                  ? 'text-charcoal-900 border-b border-charcoal-900 pb-0.5'
                  : 'text-smoke-400 hover:text-charcoal-900'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* ── Collapsible filter overlay ──────────────────────────── */}
        {isFilterOpen && (
          <div className="mb-12 animate-reveal">
            <div className="border-t border-b border-smoke-200 py-8">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-6">
                {/* Tag filters as minimal typographic list */}
                {TAGS.map((tag) => {
                  const isActive = selectedFilters.tags.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      onClick={() => handleTagToggle(tag.id)}
                      className={`text-left text-sm transition-colors duration-500 ease-luxury ${
                        isActive
                          ? 'text-charcoal-900 font-medium'
                          : 'text-smoke-400 hover:text-charcoal-900'
                      }`}
                    >
                      {isActive && <span className="mr-1.5">·</span>}
                      {tag.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── Active filters: minimal inline text ─────────────────── */}
        {hasActiveFilters && !isFilterOpen && (
          <div className="mb-8 flex flex-wrap items-center gap-3">
            {selectedFilters.tags.map((tagId) => {
              const tag = TAGS.find((t) => t.id === tagId)
              return (
                <button
                  key={tagId}
                  onClick={() => handleTagToggle(tagId)}
                  className="text-xs font-medium text-charcoal-900 border-b border-charcoal-900/30 pb-0.5 hover:border-charcoal-900 transition-colors duration-500 ease-luxury"
                >
                  {tag?.label || tagId} ✕
                </button>
              )
            })}
            {selectedFilters.category && (
              <button
                onClick={() => handleCategoryChange('')}
                className="text-xs font-medium text-charcoal-900 border-b border-charcoal-900/30 pb-0.5 hover:border-charcoal-900 transition-colors duration-500 ease-luxury"
              >
                {CATEGORIES.find((c) => c.id === selectedFilters.category)?.label} ✕
              </button>
            )}
          </div>
        )}

        {/* ── Product grid ────────────────────────────────────────── */}
        <ProductGrid
          products={products}
          columns={4}
          isLoading={isLoading}
          isEmpty={!isLoading && products.length === 0}
          emptyMessage={
            searchQuery
              ? `Nenhum resultado para "${searchQuery}"`
              : 'Explore nosso cardápio ou busque por nome'
          }
          onAddToCart={(productId) => {
            const product = products.find((p) => p.id === productId)
            if (product) {
              addItem(product as ProductDTO, 1)
              addToast(t('product.added'), 'success')
            }
          }}
        />
      </div>
    </div>
  )
}
