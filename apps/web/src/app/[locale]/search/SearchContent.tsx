'use client'

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { ProductGrid } from '@/components/organisms'
import { Container } from '@/components/atoms'
import { useUIStore } from '@/domains/ui'
import { useCartStore } from '@/domains/cart'
import { useProducts } from '@/domains/product'
import { track } from '@/domains/analytics'
import { SlidersHorizontal, X } from 'lucide-react'
import { SearchCategoryRow } from './SearchCategoryRow'
import { SearchEmptyState } from './SearchEmptyState'
import { PitmasterPick } from '@/components/molecules/PitmasterPick'
import { GuidedSection } from '@/components/molecules/GuidedSection'
import { MostOrderedSection } from '@/components/molecules/MostOrderedSection'

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

  // Disable browser scroll restoration on reload — always start at top
  useEffect(() => {
    if ('scrollRestoration' in globalThis.history) {
      globalThis.history.scrollRestoration = 'manual'
    }
    globalThis.scrollTo(0, 0)
  }, [])

  // Close filter dropdown on Escape key
  useEffect(() => {
    if (!isMobileFilterOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMobileFilterOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isMobileFilterOpen])

  const { selectedFilters, setFilters, resetFilters } = useUIStore()
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
    if (urlQuery) setSearchQuery(urlQuery) // eslint-disable-line react-hooks/set-state-in-effect -- sync URL params to state on mount
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

  const allProducts = useMemo(() => productsData?.items ?? [], [productsData])
  const totalFound = productsData?.total ?? 0

  const products = allProducts.slice(0, visibleCount)
  const hasMore = visibleCount < allProducts.length

  // Reset visible count when filters/search change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE) // eslint-disable-line react-hooks/set-state-in-effect -- reset pagination on filter change
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
      { rootMargin: '100px' }
    )
    observer.observe(loadMoreRef.current)
    return () => observer.disconnect()
  }, [hasMore, allProducts.length])

  // Fire search_performed once results settle
  useEffect(() => {
    if (isLoading || !searchQuery) return
    track('search_performed', { query: searchQuery, resultCount: totalFound })
  }, [isLoading, searchQuery, totalFound])

  // Fire impression event every time a result set settles (including
  // category/tag-only browses where `searchQuery` is empty). Pairs with
  // product_card_clicked / add_to_cart for CTR and add-rate dashboards.
  useEffect(() => {
    if (isLoading) return
    const filtersApplied = {
      hasQuery: !!searchQuery,
      tagCount: selectedFilters.tags.length,
      category: selectedFilters.category || null,
      sort: selectedFilters.sort,
    }
    track('search_results_viewed', {
      query: searchQuery || null,
      resultCount: totalFound,
      filtersApplied,
    })
  }, [isLoading, searchQuery, totalFound, selectedFilters.tags, selectedFilters.category, selectedFilters.sort])

  const handleTagToggle = (tagId: string) => {
    const newTags = selectedFilters.tags.includes(tagId)
      ? selectedFilters.tags.filter((t) => t !== tagId)
      : [...selectedFilters.tags, tagId]
    const newFilters = { ...selectedFilters, tags: newTags }
    setFilters(newFilters)
    updateURL(newFilters, searchQuery)
    track('filter_applied', { filterType: 'tag', value: tagId })
  }

  const scrollToProductGrid = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById('product-grid')
        if (el) {
          const y = el.getBoundingClientRect().top + globalThis.scrollY - globalThis.innerHeight * 0.2
          globalThis.scrollTo({ top: y, behavior: 'smooth' })
        }
      })
    })
  }

  const handleCategoryChange = (categoryId: string) => {
    const newCategory = categoryId === selectedFilters.category ? undefined : categoryId
    const newFilters = { ...selectedFilters, category: newCategory }
    setFilters(newFilters)
    updateURL(newFilters, searchQuery)
    track('filter_applied', { filterType: 'category', value: categoryId ?? 'all' })

    // Scroll after React re-renders
    if (newCategory) {
      // Selecting or switching category → scroll to top
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          globalThis.scrollTo({ top: 0, behavior: 'smooth' })
        })
      })
    } else {
      // Toggling OFF → back to zero state, scroll to grid
      scrollToProductGrid()
    }
  }

  const handleClearCategory = () => {
    const newFilters = { ...selectedFilters, category: undefined }
    setFilters(newFilters)
    updateURL(newFilters, searchQuery)
    track('filter_applied', { filterType: 'category', value: 'all' })
    scrollToProductGrid()
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

  /** Clear only tags + category, keep sort intact */
  const handleClearFiltersOnly = () => {
    const newFilters = { ...selectedFilters, tags: [] as string[], category: undefined }
    setFilters(newFilters)
    setSearchQuery('')
    updateURL(newFilters)
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
        addItem(product, 1, undefined, defaultVariant)
        track('add_to_cart', { productId, source: 'listing' })
        if (product.categoryHandle) {
          triggerUpsell(product.categoryHandle)
        }
      }
    },
    [allProducts, addItem, triggerUpsell]
  )

  // Zero-state: no active search or category filter
  const isZeroState = !searchQuery && !selectedFilters.category

  return (
    <div className="min-h-[60vh] bg-smoke-50">
      {/* ── Category row + filter trigger — sticky below header ── */}
      <div className="sticky top-[56px] z-20 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200">
        <Container padding="none" className="relative">
          <div className="flex items-center gap-1 px-5 sm:px-6 lg:px-8 py-2">
            <div className="flex-1 overflow-hidden">
              <SearchCategoryRow
                categories={CATEGORIES}
                selectedCategory={selectedFilters.category}
                onCategoryChange={handleCategoryChange}
                onClearCategory={handleClearCategory}
              />
            </div>
            <button
              onClick={() => setIsMobileFilterOpen((prev) => !prev)}
              className={`relative flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full border transition-colors ${
                hasNonCategoryFilters || isMobileFilterOpen
                  ? 'border-charcoal-900 text-charcoal-900'
                  : 'border-smoke-200 text-smoke-400 hover:text-charcoal-900 hover:border-smoke-300'
              }`}
              aria-label={t('search.filter')}
            >
              {isMobileFilterOpen ? (
                <X className="w-3.5 h-3.5" strokeWidth={2} />
              ) : (
                <SlidersHorizontal className="w-3.5 h-3.5" />
              )}
              {hasNonCategoryFilters && !isMobileFilterOpen && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-brand-500" />
              )}
            </button>
          </div>

          {/* ── Floating filter panel — continuous with sticky bar ──── */}
          {isMobileFilterOpen && (
            <>
              {/* Backdrop to close on outside click */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setIsMobileFilterOpen(false)}
                aria-hidden="true"
              />
              {/* Unified single-row filter panel */}
              <div className="absolute top-full left-0 right-0 z-20 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200 px-5 sm:px-6 lg:px-8 py-2.5 animate-fade-up">
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* Tags label + pills */}
                  <span className="text-[10px] font-medium uppercase tracking-editorial text-smoke-400 mr-0.5">
                    {t('search.tags')}
                  </span>
                  {TAGS.map((tag) => {
                    const isActive = selectedFilters.tags.includes(tag.id)
                    return (
                      <button
                        key={tag.id}
                        onClick={() => handleTagToggle(tag.id)}
                        className={`rounded-full border px-3 py-1.5 text-xs min-h-[36px] transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-1 ${
                          isActive
                            ? 'border-charcoal-900 bg-charcoal-900 text-smoke-50'
                            : 'border-smoke-200 bg-smoke-100 text-charcoal-700 hover:border-smoke-300'
                        }`}
                      >
                        {tag.label}
                      </button>
                    )
                  })}

                  {/* Subtle vertical divider */}
                  <div className="w-px h-4 bg-smoke-300 mx-1 hidden sm:block" />

                  {/* Sort label + pills */}
                  <span className="text-[10px] font-medium uppercase tracking-editorial text-smoke-400 mr-0.5">
                    {t('search.sort_label')}
                  </span>
                  {SORT_OPTIONS.map((opt) => {
                    const isActive = (selectedFilters.sort || 'relevance') === opt.value
                    return (
                      <button
                        key={opt.value}
                        onClick={() => handleSortChange(opt.value)}
                        className={`rounded-full border px-3 py-1.5 text-xs min-h-[36px] transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-1 ${
                          isActive
                            ? 'border-charcoal-900 bg-charcoal-900 text-smoke-50'
                            : 'border-smoke-200 bg-smoke-100 text-charcoal-700 hover:border-smoke-300'
                        }`}
                      >
                        {opt.label}
                      </button>
                    )
                  })}

                  {/* Clear filters — inline, branded, visible (preserves sort) */}
                  {hasActiveFilters && (
                    <>
                      <div className="w-px h-4 bg-smoke-300 mx-1 hidden sm:block" />
                      <button
                        onClick={handleClearFiltersOnly}
                        className="flex items-center gap-0.5 rounded-full border border-brand-200 text-brand-500 px-2 py-0.5 text-[11px] font-medium hover:bg-brand-50 transition-colors"
                      >
                        <X className="w-3 h-3" />
                        Limpar Filtros
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </Container>
      </div>

      <Container className="py-16 lg:py-24">
        {/* ══════════════════════════════════════════════════════════
            BROWSE MODE — discovery-first layout
            ══════════════════════════════════════════════════════════ */}
        {isZeroState && !isLoading && (
          <>
            {/* 1. Pitmaster Recomenda — card variant, decent size */}
            {pitmasterProduct && (
              <div className="mb-6">
                <PitmasterPick
                  product={pitmasterProduct}
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
                  products={popularProducts}
                  onAddToCart={handleAddToCart}
                />
              )}
              {allProducts.length > 0 && (
                <MostOrderedSection
                  products={allProducts}
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
          <div className="flex items-center justify-between mt-2 mb-8">
            <p className="text-base font-medium text-smoke-500">
              {allProducts.length} {allProducts.length === 1 ? 'produto' : 'produtos'}
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

              {/* Load More sentinel + skeleton */}
              {hasMore && (
                <div ref={loadMoreRef} className="pt-6 pb-4">
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 sm:gap-x-6 md:gap-x-5 lg:gap-x-8 gap-y-6">
                    {['skel-a', 'skel-b', 'skel-c', 'skel-d'].map((id) => (
                      <div key={id} className="overflow-hidden rounded-card animate-pulse">
                        <div className="aspect-[4/3] rounded-card bg-smoke-200" />
                        <div className="pt-3 space-y-2.5">
                          <div className="h-4 w-3/4 rounded bg-smoke-200" />
                          <div className="h-3 w-1/3 rounded bg-smoke-200" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* End of results indicator */}
              {!hasMore && products.length > 0 && !isLoading && (
                <div className="flex items-center justify-center gap-3 py-8">
                  <div className="h-px w-12 bg-smoke-200" />
                  <span className="text-xs text-smoke-400 uppercase tracking-editorial">
                    {t('search.end_of_results')}
                  </span>
                  <div className="h-px w-12 bg-smoke-200" />
                </div>
              )}
            </>
          )}
        </div>
      </Container>

      {/* Filter dropdown is now inline above (inside the sticky bar) */}
    </div>
  )
}
