'use client'

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Button } from '@/components/atoms'
import { SearchInput } from '@/components/molecules'
import { ProductGrid } from '@/components/organisms'
import { useUIStore, useCartStore } from '@/stores'
import { useProducts } from '@/hooks/api'
import { track } from '@/lib/analytics'
import { SlidersHorizontal } from 'lucide-react'
import { Sheet } from '@/components/molecules/Modal'
import { SearchFilterPanel } from './SearchFilterPanel'
import { SearchCategoryRow } from './SearchCategoryRow'
import { SearchEmptyState } from './SearchEmptyState'
import type { ProductDTO } from '@ibatexas/types'

const TAG_IDS = ['novo', 'popular', 'chef_choice', 'vegetariano', 'vegan', 'sem_gluten'] as const
const CATEGORY_IDS = ['carnes-defumadas', 'acompanhamentos', 'sanduiches', 'sobremesas', 'bebidas', 'congelados'] as const
const SORT_VALUES = ['relevance', 'price_asc', 'price_desc', 'rating', 'popular'] as const

const PAGE_SIZE = 20

export default function SearchContent() {
  const t = useTranslations()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [searchQuery, setSearchQuery] = useState('')
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const initializedRef = useRef(false)
  const loadMoreRef = useRef<HTMLDivElement>(null)

  const { selectedFilters, setFilters, resetFilters, addToast } = useUIStore()
  const addItem = useCartStore((s) => s.addItem)

  // ── Sync URL params → store on mount ──────────────────────────────────
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const urlCategory = searchParams.get('category')
    const urlTags = searchParams.get('tags')
    const urlQuery = searchParams.get('q')
    const urlSort = searchParams.get('sort')

    const hasUrlFilters = urlCategory || urlTags || urlQuery || urlSort
    if (!hasUrlFilters) return

    const newFilters: typeof selectedFilters = {
      tags: urlTags ? urlTags.split(',').filter(Boolean) : [],
      category: urlCategory || undefined,
      sort: urlSort || undefined,
    }

    setFilters(newFilters)
    if (urlQuery) setSearchQuery(urlQuery)
  }, [searchParams, setFilters])

  // ── Sync store → URL when filters change ──────────────────────────────
  const updateURL = useCallback(
    (filters: typeof selectedFilters, query?: string) => {
      const params = new URLSearchParams()
      if (filters.category) params.set('category', filters.category)
      if (filters.tags.length > 0) params.set('tags', filters.tags.join(','))
      if (filters.sort && filters.sort !== 'relevance') params.set('sort', filters.sort)
      if (query) params.set('q', query)

      const qs = params.toString()
      const newUrl = qs ? `${pathname}?${qs}` : pathname
      router.replace(newUrl, { scroll: false })
    },
    [pathname, router]
  )

  const activeTags = useMemo(
    () => (selectedFilters.tags.length > 0 ? selectedFilters.tags : undefined),
    [selectedFilters.tags]
  )

  const TAGS = TAG_IDS.map((id) => ({ id, label: t(`search.tags_list.${id}`) }))
  const CATEGORIES = CATEGORY_IDS.map((id) => ({ id, label: t(`search.categories_list.${id}`) }))
  const SORT_OPTIONS = SORT_VALUES.map((value) => ({ value, label: t(`search.sort.${value}`) }))

  const { data: productsData, loading: isLoading } = useProducts({
    query: searchQuery || undefined,
    tags: activeTags,
    limit: 100,
    categoryHandle: selectedFilters.category || undefined,
    sort: selectedFilters.sort,
  })

  const allProducts = productsData?.items ?? []
  const totalFound = productsData?.total ?? 0
  const products = allProducts.slice(0, visibleCount)
  const hasMore = visibleCount < allProducts.length

  // Reset visible count when filters/search change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [searchQuery, selectedFilters.tags, selectedFilters.category, selectedFilters.sort])

  // ── IntersectionObserver for infinite scroll ──────────────────────────
  useEffect(() => {
    if (!loadMoreRef.current || !hasMore) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, allProducts.length))
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(loadMoreRef.current)
    return () => observer.disconnect()
  }, [hasMore, allProducts.length])

  const handleSearch = (query: string) => {
    setSearchQuery(query)
    updateURL(selectedFilters, query)
  }

  // Fire search_performed once results settle
  useEffect(() => {
    if (isLoading || !searchQuery) return
    track('search_performed', { query: searchQuery, resultCount: totalFound })
  }, [isLoading, searchQuery, totalFound])

  const handleTagToggle = (tagId: string) => {
    const newTags = selectedFilters.tags.includes(tagId)
      ? selectedFilters.tags.filter((t) => t !== tagId)
      : [...selectedFilters.tags, tagId]
    const newFilters = { ...selectedFilters, tags: newTags }
    setFilters(newFilters)
    updateURL(newFilters, searchQuery)
    track('filter_applied', { filterType: 'tag', value: tagId })
  }

  const handleCategoryChange = (categoryId: string) => {
    const newCategory = categoryId === selectedFilters.category ? undefined : categoryId
    const newFilters = { ...selectedFilters, category: newCategory }
    setFilters(newFilters)
    updateURL(newFilters, searchQuery)
    track('filter_applied', { filterType: 'category', value: categoryId ?? 'all' })
  }

  const handleClearCategory = () => {
    const newFilters = { ...selectedFilters, category: undefined }
    setFilters(newFilters)
    updateURL(newFilters, searchQuery)
  }

  const handleSortChange = (sortValue: string) => {
    const newFilters = { ...selectedFilters, sort: sortValue }
    setFilters(newFilters)
    updateURL(newFilters, searchQuery)
    track('filter_applied', { filterType: 'sort', value: sortValue })
  }

  const handleResetFilters = () => {
    resetFilters()
    setSearchQuery('')
    router.replace(pathname, { scroll: false })
  }

  const hasActiveFilters = selectedFilters.tags.length > 0 || !!selectedFilters.category

  return (
    <div className="min-h-screen bg-smoke-50">
      {/* ── Search bar ──────────────────────────────────────────── */}
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
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-4">
          <div>
            <h1 className="font-display text-display-sm font-semibold text-charcoal-900 tracking-display inline-flex items-baseline gap-3">
              {t('search.title')}
              {!isLoading && totalFound > 0 && (
                <span className="text-sm font-sans font-medium text-smoke-400">· {totalFound}</span>
              )}
            </h1>
            {hasActiveFilters && (
              <button
                onClick={handleResetFilters}
                className="mt-2 text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 transition-colors duration-500 ease-luxury"
              >
                {t('search.reset_filters')}
              </button>
            )}
          </div>

          <SearchFilterPanel
            tags={TAGS}
            sortOptions={SORT_OPTIONS}
            selectedTags={selectedFilters.tags}
            selectedSort={selectedFilters.sort || 'relevance'}
            isFilterOpen={isFilterOpen}
            onToggleFilter={() => setIsFilterOpen(!isFilterOpen)}
            onTagToggle={handleTagToggle}
            onSortChange={handleSortChange}
            onResetFilters={handleResetFilters}
            hasActiveFilters={hasActiveFilters}
          />

          {/* Mobile filter trigger — opens bottom sheet */}
          <button
            onClick={() => setIsMobileFilterOpen(true)}
            className="sm:hidden inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 transition-colors duration-500 ease-luxury"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {t('search.filter')}
            {selectedFilters.tags.length > 0 && (
              <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded-full bg-charcoal-900 text-smoke-50 text-[9px] font-semibold">
                {selectedFilters.tags.length}
              </span>
            )}
          </button>
        </div>

        {/* ── Typographic category row ────────────────────────────── */}
        <SearchCategoryRow
          categories={CATEGORIES}
          selectedCategory={selectedFilters.category}
          onCategoryChange={handleCategoryChange}
          onClearCategory={handleClearCategory}
        />

        {/* ── Active filter chips (category) ──────────────────────── */}
        {selectedFilters.category && !isFilterOpen && (
          <div className="mb-8 flex flex-wrap items-center gap-3">
            <button
              onClick={() => handleCategoryChange(selectedFilters.category!)}
              className="text-xs font-medium text-charcoal-900 border-b border-charcoal-900/30 pb-0.5 hover:border-charcoal-900 transition-colors duration-500 ease-luxury"
            >
              {CATEGORIES.find((c) => c.id === selectedFilters.category)?.label} ✕
            </button>
          </div>
        )}

        {/* ── Category intro banner (editorial strip) ──────────── */}
        {selectedFilters.category && (
          <div className="mb-2">
            <p className="font-display italic text-sm text-smoke-400 leading-relaxed">
              {t(`search.category_descriptions.${selectedFilters.category}`)}
            </p>
          </div>
        )}

        {/* ── Product grid + Load More ────────────────────────────── */}
        <div className="pt-6">
          {!isLoading && products.length === 0 ? (
            <SearchEmptyState
              searchQuery={searchQuery}
              categories={CATEGORIES}
              onCategoryChange={handleCategoryChange}
            />
          ) : (
            <>
              <ProductGrid
                products={products}
                columns={4}
                isLoading={isLoading}
                onAddToCart={(productId) => {
                  const product = allProducts.find((p) => p.id === productId)
                  if (product) {
                    const defaultVariant = product.variants?.[0]
                    addItem(product as ProductDTO, 1, undefined, defaultVariant)
                    track('add_to_cart', { productId, source: 'listing' })
                    addToast(t('product.added'), 'success')
                  }
                }}
              />

              {/* Load More sentinel + button fallback */}
              {hasMore && (
                <div ref={loadMoreRef} className="flex justify-center pt-12 pb-4">
                  <Button
                    variant="tertiary"
                    size="md"
                    onClick={() => setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, allProducts.length))}
                  >
                    {t('search.load_more')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Mobile bottom sheet: sort & filter ────────────────────── */}
      <Sheet
        isOpen={isMobileFilterOpen}
        onClose={() => setIsMobileFilterOpen(false)}
        title={t('search.filter')}
        position="bottom"
        footer={
          <button
            onClick={() => setIsMobileFilterOpen(false)}
            className="w-full rounded-sm bg-charcoal-900 px-4 py-3 text-sm font-medium text-smoke-50 active:scale-[0.97] transition-transform"
          >
            {t('search.show_results', { count: totalFound })}
          </button>
        }
      >
        {/* Sort */}
        <div className="mb-6">
          <h3 className="text-xs font-medium uppercase tracking-editorial text-smoke-400 mb-3">
            {t('search.sort_label')}
          </h3>
          <div className="flex flex-wrap gap-2">
            {SORT_OPTIONS.map((opt) => {
              const isActive = (selectedFilters.sort || 'relevance') === opt.value
              return (
                <button
                  key={opt.value}
                  onClick={() => handleSortChange(opt.value)}
                  className={`rounded-sm border px-3 py-2.5 text-sm transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
                    isActive
                      ? 'border-charcoal-900 bg-charcoal-900 text-smoke-50'
                      : 'border-smoke-200 text-charcoal-700 hover:border-smoke-300'
                  }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Categories */}
        <div className="mb-6">
          <h3 className="text-xs font-medium uppercase tracking-editorial text-smoke-400 mb-3">
            {t('search.categories')}
          </h3>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => {
              const isActive = selectedFilters.category === cat.id
              return (
                <button
                  key={cat.id}
                  onClick={() => handleCategoryChange(cat.id)}
                  className={`rounded-sm border px-3 py-2.5 text-sm transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
                    isActive
                      ? 'border-charcoal-900 bg-charcoal-900 text-smoke-50'
                      : 'border-smoke-200 text-charcoal-700 hover:border-smoke-300'
                  }`}
                >
                  {cat.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Tags */}
        <div>
          <h3 className="text-xs font-medium uppercase tracking-editorial text-smoke-400 mb-3">
            {t('search.tags')}
          </h3>
          <div className="flex flex-wrap gap-2">
            {TAGS.map((tag) => {
              const isActive = selectedFilters.tags.includes(tag.id)
              return (
                <button
                  key={tag.id}
                  onClick={() => handleTagToggle(tag.id)}
                  className={`rounded-sm border px-3 py-2.5 text-sm transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
                    isActive
                      ? 'border-charcoal-900 bg-charcoal-900 text-smoke-50'
                      : 'border-smoke-200 text-charcoal-700 hover:border-smoke-300'
                  }`}
                >
                  {tag.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Reset link */}
        {hasActiveFilters && (
          <button
            onClick={() => {
              handleResetFilters()
              setIsMobileFilterOpen(false)
            }}
            className="mt-6 text-xs font-medium uppercase tracking-editorial text-smoke-400 hover:text-charcoal-900 transition-colors"
          >
            {t('search.reset_filters')}
          </button>
        )}
      </Sheet>
    </div>
  )
}
