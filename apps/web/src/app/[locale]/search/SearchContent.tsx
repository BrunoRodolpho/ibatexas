'use client'

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Button } from '@/components/atoms'
import { ProductGrid } from '@/components/organisms'
import { useUIStore } from '@/domains/ui'
import { useCartStore } from '@/domains/cart'
import { useProducts } from '@/domains/product'
import { track } from '@/domains/analytics'
import { SlidersHorizontal } from 'lucide-react'
import { Sheet } from '@/components/molecules/Modal'
import { SearchCategoryRow } from './SearchCategoryRow'
import { SearchEmptyState } from './SearchEmptyState'
import { PitmasterPick } from '@/components/molecules/PitmasterPick'
import { GuidedSection } from '@/components/molecules/GuidedSection'
import { MostOrderedSection } from '@/components/molecules/MostOrderedSection'
import { resolveCanonical } from '@/domains/search'
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
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const initializedRef = useRef(false)
  const loadMoreRef = useRef<HTMLDivElement>(null)

  const { selectedFilters, setFilters, resetFilters, addToast } = useUIStore()
  const addItem = useCartStore((s) => s.addItem)
  const cartItems = useCartStore((s) => s.items)
  const updateItem = useCartStore((s) => s.updateItem)
  const removeItem = useCartStore((s) => s.removeItem)

  const getCartQuantity = useCallback(
    (productId: string) =>
      cartItems.filter((item) => item.productId === productId).reduce((sum, item) => sum + item.quantity, 0),
    [cartItems],
  )
  const getCartItemId = useCallback(
    (productId: string) => cartItems.find((item) => item.productId === productId)?.id,
    [cartItems],
  )

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
    const canonical = resolveCanonical(query)
    const effectiveQuery = canonical ?? query
    setSearchQuery(effectiveQuery)
    updateURL(selectedFilters, effectiveQuery)
    if (canonical) {
      track('search_synonym_resolved', { original: query, canonical })
    }
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
  const hasNonCategoryFilters = selectedFilters.tags.length > 0 || (!!selectedFilters.sort && selectedFilters.sort !== 'relevance')

  // ── Derived: pitmaster pick (chef_choice tag, first match) ──
  const pitmasterProduct = useMemo(() => {
    return allProducts.find((p) => p.tags?.includes('chef_choice')) ?? null
  }, [allProducts])

  // ── Derived: popular products for "Em Alta" carousel ──
  const popularProducts = useMemo(() => {
    return allProducts.filter((p) => p.tags?.includes('popular')).slice(0, 8)
  }, [allProducts])

  // ── Shared add-to-cart handler ──
  const triggerUpsell = useUIStore((s) => s.triggerUpsell)

  const handleAddToCart = useCallback(
    (productId: string) => {
      const product = allProducts.find((p) => p.id === productId)
      if (product) {
        const defaultVariant = product.variants?.[0]
        addItem(product as ProductDTO, 1, undefined, defaultVariant)
        track('add_to_cart', { productId, source: 'listing' })
        addToast(t('product.added'), 'cart')
        if (product.categoryHandle) {
          triggerUpsell(product.categoryHandle)
        }
      }
    },
    [allProducts, addItem, addToast, t, triggerUpsell]
  )

  // Zero-state: no active search or category filter
  const isZeroState = !searchQuery && !selectedFilters.category

  return (
    <div className="min-h-screen bg-smoke-50">
      {/* ── Category row + filter trigger — sticky below header ── */}
      <div className="sticky top-[56px] z-20 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200">
      <div className="max-w-[1200px] mx-auto flex items-center gap-1 px-4 sm:px-6 py-2">
        <div className="flex-1 overflow-hidden">
          <SearchCategoryRow
            categories={CATEGORIES}
            selectedCategory={selectedFilters.category}
            onCategoryChange={handleCategoryChange}
            onClearCategory={handleClearCategory}
            productCount={allProducts.length}
          />
        </div>
        <button
          onClick={() => setIsMobileFilterOpen(true)}
          className={`relative flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full border transition-colors ${
            hasNonCategoryFilters
              ? 'border-charcoal-900 text-charcoal-900'
              : 'border-smoke-200 text-smoke-400 hover:text-charcoal-900 hover:border-smoke-300'
          }`}
          aria-label={t('search.filter')}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          {hasNonCategoryFilters && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-brand-500" />
          )}
        </button>
      </div>
      </div>

      <div className="max-w-[1200px] mx-auto px-4 sm:px-6">
        {/* ══════════════════════════════════════════════════════════
            BROWSE MODE — discovery-first layout
            ══════════════════════════════════════════════════════════ */}
        {isZeroState && !isLoading && (
          <>
            {/* 1. Pitmaster Recomenda — card variant, decent size */}
            {pitmasterProduct && (
              <div className="mt-8 mb-6">
                <PitmasterPick
                  product={pitmasterProduct as ProductDTO}
                  onAddToCart={handleAddToCart}
                  variant="card"
                  cartQuantity={getCartQuantity(pitmasterProduct.id)}
                  onUpdateQuantity={(qty) => {
                    const itemId = getCartItemId(pitmasterProduct.id)
                    if (itemId) updateItem(itemId, { quantity: qty })
                  }}
                  onRemoveFromCart={() => {
                    const itemId = getCartItemId(pitmasterProduct.id)
                    if (itemId) removeItem(itemId)
                  }}
                />
              </div>
            )}

            {/* 2 + 3. Em Alta & Mais Pedidos — side by side on desktop, stacked on mobile */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-6 lg:gap-8 mb-6">
              {popularProducts.length > 0 && (
                <GuidedSection
                  title={t('search.trending')}
                  subtitle={t('search.trending_subtitle')}
                  products={popularProducts as ProductDTO[]}
                  onAddToCart={handleAddToCart}
                />
              )}
              {allProducts.length > 0 && (
                <MostOrderedSection
                  products={allProducts as ProductDTO[]}
                  onAddToCart={handleAddToCart}
                />
              )}
            </div>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════
            FILTERED / SEARCH MODE — category description + count
            ══════════════════════════════════════════════════════════ */}
        {!isZeroState && selectedFilters.category && (
          <div className="mt-3 mb-4">
            <p className="font-display italic text-sm text-smoke-400 leading-relaxed">
              {t(`search.category_descriptions.${selectedFilters.category}`)}
            </p>
          </div>
        )}
        {!isZeroState && !isLoading && (
          <div className="flex items-center justify-between mt-2 mb-3">
            <p className="text-sm text-smoke-400">
              {totalFound} {totalFound === 1 ? 'produto' : 'produtos'}
              {searchQuery && ` para "${searchQuery}"`}
            </p>
            {hasActiveFilters && (
              <button
                onClick={handleResetFilters}
                className="text-xs font-medium text-smoke-400 hover:text-charcoal-900 transition-colors"
              >
                {t('search.reset_filters')}
              </button>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            PRODUCT GRID — always shown
            ══════════════════════════════════════════════════════════ */}
        <div id="product-grid">
          {/* Section divider for browse mode */}
          {isZeroState && !isLoading && allProducts.length > 0 && (
            <div className="flex items-center gap-3 mb-6">
              <div className="h-px flex-1 bg-smoke-200" />
              <span className="text-xs uppercase tracking-editorial text-smoke-400 font-medium">
                {t('common.all')}
              </span>
              <div className="h-px flex-1 bg-smoke-200" />
            </div>
          )}

          {!isLoading && products.length === 0 ? (
            <SearchEmptyState
              searchQuery={searchQuery}
              categories={CATEGORIES}
              onCategoryChange={handleCategoryChange}
              showCategories={!!searchQuery || !!selectedFilters.category}
            />
          ) : (
            <>
              <ProductGrid
                products={products}
                columns={4}
                isLoading={isLoading}
                onAddToCart={handleAddToCart}
              />

              {/* Load More sentinel + button fallback */}
              {hasMore && (
                <div ref={loadMoreRef} className="flex justify-center pt-8 pb-4">
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

      {/* ── Filter sheet — sort, categories, tags ────────────────── */}
      <Sheet
        isOpen={isMobileFilterOpen}
        onClose={() => setIsMobileFilterOpen(false)}
        title={t('search.filters')}
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
