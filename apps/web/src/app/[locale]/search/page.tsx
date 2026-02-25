'use client'

import React, { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Heading, Text, Button, Select, Checkbox, RadioGroup } from '@/components/atoms'
import { SearchInput, FilterChip } from '@/components/molecules'
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
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState(false)

  const { selectedFilters, setFilters, resetFilters, addToast } = useUIStore()
  const addItem = useCartStore((s) => s.addItem)

  // Merge selected tags from UI store
  const activeTags = useMemo(
    () => (selectedFilters.tags.length > 0 ? selectedFilters.tags : undefined),
    [selectedFilters.tags]
  )

  const TAGS = TAG_IDS.map((id) => ({ id, label: t(`search.tags_list.${id}`) }))
  const CATEGORIES = CATEGORY_IDS.map((id) => ({ id, label: t(`search.categories_list.${id}`) }))
  const SORT_OPTIONS = SORT_VALUES.map((value) => ({ value, label: t(`search.sort.${value}`) }))

  // Call real API via useProducts hook
  const { data: productsData, loading: isLoading } = useProducts(
    searchQuery || undefined,
    activeTags,
    20
  )

  const products = productsData?.products ?? []
  const totalFound = productsData?.totalFound ?? 0

  const handleSearch = (query: string) => {
    setSearchQuery(query)
  }

  const handleTagToggle = (tagId: string) => {
    const newTags = selectedFilters.tags.includes(tagId)
      ? selectedFilters.tags.filter((t) => t !== tagId)
      : [...selectedFilters.tags, tagId]
    setFilters({ ...selectedFilters, tags: newTags })
  }

  const handleCategoryChange = (categoryId: string) => {
    setFilters({ ...selectedFilters, category: categoryId })
  }

  const handleSortChange = (sortValue: string) => {
    setFilters({ ...selectedFilters, sort: sortValue })
  }

  const handlePriceChange = (minPrice: number, maxPrice: number) => {
    setFilters({ ...selectedFilters, priceRange: [minPrice, maxPrice] })
  }

  const hasActiveFilters = selectedFilters.tags.length > 0 || selectedFilters.category || selectedFilters.priceRange

  return (
    <div className="min-h-screen bg-white">
      {/* Search Header */}
      <div className="sticky top-[65px] z-20 bg-white/90 backdrop-blur-md border-b border-slate-200 px-4 py-4">
        <div className="max-w-6xl mx-auto">
          <SearchInput
            placeholder={t('search.placeholder')}
            onSearch={handleSearch}
            isLoading={isLoading}
            debounceMs={300}
          />
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Results Info */}
        <div className="flex items-center justify-between mb-6">
          <Heading as="h1" variant="h3">
            {isLoading
              ? t('search.searching')
              : totalFound > 0
                ? `${totalFound} ${t('search.results')}`
                : t('search.title')}
          </Heading>
          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="text-sm text-brand-600 hover:underline font-medium"
            >
              {t('search.reset_filters')}
            </button>
          )}
        </div>

        <div className="flex gap-6">
          {/* Sidebar Filters (Desktop) */}
          <aside className="hidden lg:block w-64 flex-shrink-0">
            <div className="space-y-6 sticky top-24">
              {/* Category */}
              <div>
                <h3 className="font-bold text-slate-900 mb-3">{t('search.category')}</h3>
                <RadioGroup
                  name="category"
                  options={CATEGORIES.map((cat) => ({
                    value: cat.id,
                    label: cat.label,
                  }))}
                  value={selectedFilters.category}
                  onChange={(value) => handleCategoryChange(value as string)}
                  layout="vertical"
                />
              </div>

              {/* Tags */}
              <div>
                <h3 className="font-bold text-slate-900 mb-3">{t('search.characteristics')}</h3>
                <div className="space-y-2">
                  {TAGS.map((tag) => (
                    <Checkbox
                      key={tag.id}
                      label={tag.label}
                      checked={selectedFilters.tags.includes(tag.id)}
                      onChange={() => handleTagToggle(tag.id)}
                    />
                  ))}
                </div>
              </div>

              {/* Price Range */}
              <div>
                <h3 className="font-bold text-slate-900 mb-3">{t('search.price')}</h3>
                <div className="space-y-3">
                  <input
                    type="range"
                    min="0"
                    max="50000"
                    step="500"
                    value={selectedFilters.priceRange?.[0] || 0}
                    onChange={(e) =>
                      handlePriceChange(
                        parseInt(e.target.value, 10),
                        selectedFilters.priceRange?.[1] || 50000
                      )
                    }
                    className="w-full accent-amber-700"
                  />
                  <div className="flex gap-2">
                    <input
                      type="number"
                      placeholder="Min"
                      value={selectedFilters.priceRange?.[0] || 0}
                      onChange={(e) =>
                        handlePriceChange(
                          parseInt(e.target.value, 10),
                          selectedFilters.priceRange?.[1] || 50000
                        )
                      }
                      className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm"
                    />
                    <span className="text-slate-500 py-2">—</span>
                    <input
                      type="number"
                      placeholder="Max"
                      value={selectedFilters.priceRange?.[1] || 50000}
                      onChange={(e) =>
                        handlePriceChange(
                          selectedFilters.priceRange?.[0] || 0,
                          parseInt(e.target.value, 10)
                        )
                      }
                      className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>
          </aside>

          {/* Main Content */}
          <main className="flex-1">
            {/* Sort & Mobile Filter Toggle */}
            <div className="flex gap-3 mb-6">
              <Select
                options={SORT_OPTIONS}
                value={selectedFilters.sort || 'relevance'}
                onChange={(e) => handleSortChange(e.target.value)}
                placeholder={t('search.sort.label')}
                className="flex-1 lg:w-auto"
              />
              <Button
                variant="secondary"
                onClick={() => setIsMobileFilterOpen(!isMobileFilterOpen)}
                className="lg:hidden"
              >
                {t('search.filter')}
              </Button>
            </div>

            {/* Mobile Filters */}
            {isMobileFilterOpen && (
              <div className="lg:hidden bg-slate-50 p-4 rounded-lg mb-6 space-y-4">
                <div>
                  <h3 className="font-bold text-slate-900 mb-2">{t('search.category')}</h3>
                  <RadioGroup
                    name="category"
                    options={CATEGORIES.map((cat) => ({
                      value: cat.id,
                      label: cat.label,
                    }))}
                    value={selectedFilters.category}
                    onChange={(value) => handleCategoryChange(value as string)}
                    layout="vertical"
                  />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 mb-2">{t('search.characteristics')}</h3>
                  <div className="space-y-2">
                    {TAGS.map((tag) => (
                      <Checkbox
                        key={tag.id}
                        label={tag.label}
                        checked={selectedFilters.tags.includes(tag.id)}
                        onChange={() => handleTagToggle(tag.id)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Active Filters Display */}
            {hasActiveFilters && (
              <div className="mb-6 flex flex-wrap gap-2">
                {selectedFilters.tags.map((tagId) => {
                  const tag = TAGS.find((t) => t.id === tagId)
                  return (
                    <FilterChip
                      key={tagId}
                      id={tagId}
                      label={tag?.label || tagId}
                      selected={true}
                      onToggle={() => handleTagToggle(tagId)}
                      removable
                      onRemove={() => handleTagToggle(tagId)}
                    />
                  )
                })}
                {selectedFilters.category && (
                  <FilterChip
                    id={selectedFilters.category}
                    label={CATEGORIES.find((c) => c.id === selectedFilters.category)?.label || ''}
                    selected={true}
                    onToggle={() => handleCategoryChange('')}
                    removable
                    onRemove={() => handleCategoryChange('')}
                  />
                )}
              </div>
            )}

            {/* Product Grid */}
            <ProductGrid
              products={products}
              isLoading={isLoading}
              isEmpty={!isLoading && products.length === 0}
              emptyMessage={
                searchQuery
                  ? `Nenhum produto encontrado para "${searchQuery}"`
                  : 'Digite algo para começar a buscar ou selecione uma categoria'
              }
              onAddToCart={(productId) => {
                const product = products.find((p) => p.id === productId)
                if (product) {
                  addItem(product as ProductDTO, 1)
                  addToast(t('product.added'), 'success')
                }
              }}
            />
          </main>
        </div>
      </div>
    </div>
  )
}
