'use client'

import { useTranslations } from 'next-intl'
import { useProductDetail, useProducts, tagToBadgeVariant, getCrossSellCategory, CROSS_SELL_MAP } from '@/domains/product'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { Heading, Text, Button, Badge, LinkButton, Container } from '@/components/atoms'
import { SizeSelector, ShippingEstimate, QuantitySelector, DeliveryPromise } from '@/components/molecules'
import { StickyBottomBar } from '@/components/molecules/StickyBottomBar'
import { ProductGrid } from '@/components/organisms'
import { useState, useEffect, useRef, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { MediaGallery } from '@/components/molecules/MediaGallery'
import { WishlistButton } from '@/components/molecules/WishlistButton'
import { track, trackOnceVisible, trackScrollDepth } from '@/domains/analytics'
import { formatBRL, splitBRL } from '@/lib/format'
import { useAlsoAdded } from '@/domains/recommendations'
import { Skeleton } from '@/components/atoms/Skeleton'
import { AvailabilityWindow, type ProductDTO, type ProductVariant } from '@ibatexas/types'

interface PDPContentProps {
  readonly productId: string
}

// ── Skeleton Loading ─────────────────────────────────────────────────────
function PDPSkeleton() {
  return (
    <Container size="xl">
      {/* Breadcrumb skeleton */}
      <div className="mb-6 flex gap-2">
        <Skeleton variant="text" className="h-3 w-12" />
        <Skeleton variant="text" className="h-3 w-4" />
        <Skeleton variant="text" className="h-3 w-32" />
        <Skeleton variant="text" className="h-3 w-4" />
        <Skeleton variant="text" className="h-3 w-40" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
        {/* Image skeleton */}
        <div className="space-y-4">
          <Skeleton variant="square" className="aspect-square" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={`skel-thumb-${i}`} variant="square" className="w-16 h-16" />
            ))}
          </div>
        </div>

        {/* Details skeleton */}
        <div className="space-y-6">
          <div className="space-y-3">
            <Skeleton variant="text" className="h-8 w-3/4" />
            <Skeleton variant="text" className="h-4 w-1/3" />
            <div className="flex gap-2">
              <Skeleton variant="text" className="h-5 w-16" />
              <Skeleton variant="text" className="h-5 w-20" />
            </div>
          </div>
          <Skeleton variant="rect" className="h-6 w-1/4" />
          <Skeleton variant="rect" className="h-12 w-full" />
          <Skeleton variant="rect" className="h-12 w-full" />
          <div className="space-y-2 pt-6">
            <Skeleton variant="text" className="h-4 w-full" />
            <Skeleton variant="text" className="h-4 w-5/6" />
            <Skeleton variant="text" className="h-4 w-2/3" />
          </div>
        </div>
      </div>
    </Container>
  )
}

export default function PDPContent({ productId }: PDPContentProps) {
  const t = useTranslations()
  const { data: product, loading, error } = useProductDetail(productId)
  const addToCart = useCartStore(s => s.addItem)
  const cartItems = useCartStore(s => s.items)
  const { addToast } = useUIStore()
  const openCartDrawer = useUIStore(s => s.openCartDrawer)
  const [selectedVariantId, setSelectedVariantId] = useState<string>('')
  const [quantity, setQuantity] = useState(1)
  const [isAdding, setIsAdding] = useState(false)
  const [showStickyCTA, setShowStickyCTA] = useState(false)
  const [stickyShown, setStickyShown] = useState(false)
  const [variantShake, setVariantShake] = useState(false)
  const mainCTARef = useRef<HTMLButtonElement>(null)
  const storyRef = useRef<HTMLDivElement>(null)
  const crossSellRef = useRef<HTMLDivElement>(null)
  const variantPickerRef = useRef<HTMLDivElement>(null)

  // ── Track PDP view ──────────────────────────────────────────────────
  useEffect(() => {
    if (product?.id) {
      track('pdp_viewed', { productId: product.id })
    }
  }, [product?.id])

  // ── Track PDP scroll depth ──────────────────────────────────────────
  useEffect(() => {
    if (!product?.id) return
    return trackScrollDepth(product.id)
  }, [product?.id])

  // ── Sticky CTA: IntersectionObserver ────────────────────────────────
  useEffect(() => {
    if (!mainCTARef.current) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && !stickyShown) {
          setShowStickyCTA(true)
          setStickyShown(true)
        }
      },
      { threshold: 0 },
    )

    observer.observe(mainCTARef.current)
    return () => observer.disconnect()
  }, [stickyShown, loading])

  // ── Track storytelling section visibility ───────────────────────────
  useEffect(() => {
    if (!storyRef.current || !product?.id) return
    return trackOnceVisible(storyRef.current, 'storytelling_section_viewed', {
      productId: product.id,
    })
  }, [product?.id, loading])

  // ── Cross-sell data sources — fed into a single unified section ────
  // Three inputs, one surface: (1) collaborative "also added" signal,
  // (2) category-based cross-sell, (3) cart-aware complementary picks
  // from a broader pool. Merged and deduped in `unifiedSuggestions`.
  const { data: alsoAddedProducts } = useAlsoAdded(product?.id)

  const productCategory = product?.tags?.[0] || product?.categoryHandle || ''
  const crossSellCategory = getCrossSellCategory(productCategory)

  const { data: crossSellData } = useProducts({
    categoryHandle: crossSellCategory,
    limit: 6,
  })

  const crossSellProducts = useMemo(
    () => (crossSellData?.items ?? []).filter((p) => p.id !== productId),
    [crossSellData?.items, productId],
  )

  // Broader product pool for cart-aware complementary picks
  const { data: allProductsData } = useProducts({ limit: 50 })
  const allProductsPool = useMemo(() => allProductsData?.items ?? [], [allProductsData?.items])

  type SuggestionSource = 'also_added' | 'cross_sell' | 'people_also_ordered'
  interface UnifiedSuggestion {
    readonly id: string
    readonly title: string
    readonly price: number
    readonly imageUrl: string | null
    readonly source: SuggestionSource
  }

  const unifiedSuggestions = useMemo<UnifiedSuggestion[]>(() => {
    const seen = new Set<string>([productId])
    const merged: UnifiedSuggestion[] = []

    // 1. Collaborative "also added" — highest signal, goes first
    for (const p of alsoAddedProducts) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      merged.push({ id: p.id, title: p.title, price: p.price, imageUrl: p.imageUrl ?? null, source: 'also_added' })
    }

    // 2. Category cross-sell
    for (const p of crossSellProducts) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      merged.push({ id: p.id, title: p.title, price: p.price, imageUrl: p.imageUrl ?? null, source: 'cross_sell' })
    }

    // 3. Cart-aware complementary — only when cart has items
    if (cartItems.length > 0 && allProductsPool.length > 0) {
      const cartProductIds = new Set(cartItems.map((i) => i.productId))
      const crossCategories = new Set<string>()
      for (const item of cartItems) {
        const p = allProductsPool.find((pp) => pp.id === item.productId)
        if (p?.categoryHandle) {
          CROSS_SELL_MAP[p.categoryHandle]?.forEach((c) => crossCategories.add(c))
        }
      }
      for (const p of allProductsPool) {
        if (seen.has(p.id) || cartProductIds.has(p.id)) continue
        if (p.categoryHandle && crossCategories.has(p.categoryHandle)) {
          seen.add(p.id)
          merged.push({ id: p.id, title: p.title, price: p.price, imageUrl: p.imageUrl ?? null, source: 'people_also_ordered' })
        }
      }
    }

    return merged.slice(0, 8)
  }, [productId, alsoAddedProducts, crossSellProducts, allProductsPool, cartItems])

  // ── Track unified cross-sell visibility ─────────────────────────────
  useEffect(() => {
    if (!crossSellRef.current || !product?.id || unifiedSuggestions.length === 0) return
    return trackOnceVisible(crossSellRef.current, 'pdp_cross_sell_viewed', {
      productId: product.id,
      count: unifiedSuggestions.length,
      suggestedIds: unifiedSuggestions.map((p) => p.id),
    })
  }, [product?.id, unifiedSuggestions])

  if (loading) {
    return <PDPSkeleton />
  }

  if (error || !product) {
    return (
      <div className="text-center py-12">
        <Text variant="body" className="text-accent-red">
          {t('shop.errors.product_not_found')}
        </Text>
        <LinkButton href="/loja" variant="tertiary" className="mt-4">
          {t('shop.back_to_shop')}
        </LinkButton>
      </div>
    )
  }

  const selectedVariant: ProductVariant | undefined = selectedVariantId
    ? product.variants.find((v: ProductVariant) => v.id === selectedVariantId)
    : product.variants[0]

  const hasVariants = product.variants.length > 1
  const currentPrice = selectedVariant?.price || product.price
  const priceFormatted = formatBRL(currentPrice)
  const { prefix: pricePrefix, value: priceValue } = splitBRL(currentPrice)

  const handleAddToCart = async () => {
    // Guard: when variants exist but none selected, scroll the picker into
    // view and shake it instead of silently no-op'ing a disabled button
    // (audit P0-2). Button is kept enabled precisely so mobile users get
    // this feedback on tap.
    if (!selectedVariant) {
      if (hasVariants) {
        variantPickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setVariantShake(true)
        setTimeout(() => setVariantShake(false), 500)
      }
      return
    }

    const isFirstItem = cartItems.length === 0
    setIsAdding(true)
    try {
      addToCart(product, quantity, undefined, selectedVariant)
      track('add_to_cart', {
        productId: product.id,
        variantId: selectedVariant.id,
        quantity,
        source: 'pdp',
      })
      if (isFirstItem) {
        addToast(t('toast.first_item_added'), 'success')
      } else {
        addToast(t('toast.added_to_cart'), 'cart')
      }
      openCartDrawer?.()
    } catch (err) {
      console.error('Failed to add to cart:', err)
      addToast(t('toast.add_to_cart_error'), 'error')
    } finally {
      setIsAdding(false)
    }
  }

  const handleUnifiedCrossSellAdd = (suggestedId: string) => {
    const suggestion = unifiedSuggestions.find((s) => s.id === suggestedId)
    if (!suggestion) return
    // Look up the full product (with variants) from whichever pool it came from
    const full =
      crossSellProducts.find((p) => p.id === suggestedId) ??
      allProductsPool.find((p) => p.id === suggestedId)
    if (full) {
      const defaultVariant = full.variants?.[0]
      addToCart(full, 1, undefined, defaultVariant)
    } else {
      // Also-added entries only ship a minimal shape; build a stub for the cart
      const stub = {
        id: suggestion.id,
        title: suggestion.title,
        price: suggestion.price,
        imageUrl: suggestion.imageUrl,
        variants: [],
      } as unknown as ProductDTO
      addToCart(stub, 1)
    }
    track('pdp_cross_sell_added', {
      productId: product.id,
      suggestedId,
      source: suggestion.source,
    })
    addToast(t('toast.added_to_cart'), 'cart')
  }

  return (
    <div>
      {/* Canonical `default` rhythm so the PDP top breathes the same as
          /loja and the homepage sections. Was relying on the breadcrumb's
          `mb-6` for top space, which felt abrupt after the loja list. */}
      <Container size="xl" className="py-8 lg:py-12">
        {/* ── Breadcrumb ───────────────────────────────────────────────── */}
        <nav className="mb-6 flex items-center gap-1.5 text-xs text-smoke-400" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-charcoal-900 transition-colors duration-300">{t('common.home')}</Link>
          <ChevronRight className="w-3 h-3 text-smoke-300" />
          <Link href="/loja" className="hover:text-charcoal-900 transition-colors duration-300">{t('nav.loja')}</Link>
          {product.categoryHandle && (
            <>
              <ChevronRight className="w-3 h-3 text-smoke-300" />
              <Link
                href={`/search?category=${product.categoryHandle}`}
                className="hover:text-charcoal-900 transition-colors duration-300 capitalize"
              >
                {product.categoryHandle.replaceAll("-", " ")}
              </Link>
            </>
          )}
          <ChevronRight className="w-3 h-3 text-smoke-300" />
          <span className="text-charcoal-900 font-medium truncate max-w-[200px]">{product.title}</span>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          {/* ── Product Images ──────────────────────────────────────── */}
          {/* Wishlist heart sits on top of the gallery (top-right) so it
              doesn't compete with the primary "Adicionar ao Carrinho" CTA
              below. Matches the placement on every product card.

              `lg:sticky lg:top-24 lg:self-start` pins the gallery while the
              right column scrolls — without `self-start` the grid would
              stretch the cell to match the right column's height and break
              sticky. Classic Amazon/Shopify PDP pattern. */}
          <div className="relative space-y-4 lg:sticky lg:top-24 lg:self-start">
            <div className="absolute top-3 right-3 z-10">
              <WishlistButton productId={productId} />
            </div>
            <MediaGallery
              images={product.images ?? []}
              thumbnail={product.imageUrl}
              title={product.title}
            />
          </div>

          {/* ── Product Details ─────────────────────────────────────── */}
          <div className="space-y-6">
            {/* Header */}
            <div>
              <Heading variant="h1" className="text-charcoal-900">
                {product.title}
              </Heading>

              {/* Single priority badge */}
              {product.tags && product.tags.length > 0 && (
                <div className="mt-3">
                  <Badge variant={tagToBadgeVariant(product.tags[0])}>
                    {product.tags[0]}
                  </Badge>
                </div>
              )}
            </div>

            {/* ── Price ─────────────────────────────────────────── */}
            <div>
              <div className="flex items-baseline">
                <span className="text-base text-smoke-400">{pricePrefix}</span>
                <span className="text-3xl font-semibold text-charcoal-900 tabular-nums ml-0.5">
                  {priceValue}
                </span>
              </div>

              {/* Scarcity */}
              {product.stockCount != null && product.stockCount > 0 && product.stockCount <= 5 && (
                <p className="mt-2 text-sm text-accent-red font-medium">
                  {t('scarcity', { count: product.stockCount })}
                </p>
              )}

              {/* Availability window */}
              {(product.availabilityWindow === AvailabilityWindow.ALMOCO || product.availabilityWindow === AvailabilityWindow.JANTAR) && (
                <p className="mt-1 text-xs text-amber-600 font-medium">
                  {product.availabilityWindow === AvailabilityWindow.ALMOCO ? t('product.available_almoco') : t('product.available_jantar')}
                </p>
              )}

              {/* Per-person price + serving info */}
              {product.servings && product.servings > 1 && (
                <div className="mt-3 flex items-center gap-3 text-sm text-smoke-400 border border-smoke-200 rounded-sm px-3 py-2">
                  <span className="font-medium text-charcoal-700">
                    {t('product.per_person_price', { price: formatBRL(Math.round(currentPrice / product.servings)) })}
                  </span>
                  <span>·</span>
                  <span>{t('product.serves', { count: product.servings })}</span>
                  {product.weight && (
                    <>
                      <span>·</span>
                      <span>{product.weight}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Size Selection */}
            {hasVariants && (
              <div
                ref={variantPickerRef}
                className={variantShake ? 'animate-shake' : undefined}
              >
                <SizeSelector
                  variants={product.variants}
                  selectedVariant={selectedVariantId}
                  onVariantChange={setSelectedVariantId}
                />
              </div>
            )}

            {/* ── Quantity + Add to Cart ──────────────────────────────── */}
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <Text className="font-medium text-charcoal-900">{t('product.quantity_label')}</Text>
                <QuantitySelector
                  quantity={quantity}
                  onQuantityChange={setQuantity}
                  min={1}
                  max={99}
                />
              </div>

              {/* Hint sits ABOVE the CTA so users see WHY the action won't
                  proceed before tapping (audit P0-2). */}
              {!selectedVariant && hasVariants && (
                <Text variant="small" className="text-brand-500">
                  {t('product.select_size')}
                </Text>
              )}

              <div className="flex items-center gap-3">
                <Button
                  ref={mainCTARef}
                  onClick={handleAddToCart}
                  disabled={isAdding}
                  isLoading={isAdding}
                  className="flex-1"
                  size="lg"
                >
                  {isAdding ? t('product.adding') : t('product.add_to_cart')}
                </Button>
              </div>
            </div>

            {/* Product Description */}
            {product.description && (
              <div className="space-y-3 pt-6">
                <Heading variant="h3">{t('shop.product_details')}</Heading>
                <Text className="text-smoke-400 leading-relaxed">
                  {product.description}
                </Text>
              </div>
            )}

            {/* Shipping Estimate */}
            <ShippingEstimate />

            {/* Delivery Promise */}
            <DeliveryPromise availabilityWindow={product.availabilityWindow} />

            {/* Reviews section */}
            {product.reviewCount != null && product.reviewCount > 0 && (
              <div className="space-y-3 pt-2">
                <h3 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">
                  {t('product.reviews')} ({product.reviewCount})
                </h3>
                <div className="space-y-3">
                  {[
                    { name: 'Carlos M.', stars: 5, comment: 'Melhor costela que já comi. Carne desfiando no garfo!' },
                    { name: 'Ana P.', stars: 5, comment: 'Embalagem impecável, chegou quentinha. Sabor incrível.' },
                    { name: 'Roberto S.', stars: 4, comment: 'Muito bom, porção generosa. Recomendo!' },
                  ].map((review) => (
                    <div key={review.name} className="shadow-card border border-smoke-200/40 rounded-sm p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="flex">
                          <span className="text-brand-500 text-xs">{'★'.repeat(review.stars)}</span>
                        </div>
                        <span className="text-xs font-medium text-charcoal-900">{review.name}</span>
                      </div>
                      <p className="text-xs text-smoke-400">{review.comment}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Container>

      {/* ── Storytelling Section (full-bleed) — Dynamic content ──────────── */}
      {/* Background shift (smoke-100) is the visual section break — no margin
          needed between this and the main grid. Snaps to `loose` rhythm
          since this is the emphasized story moment for the product. */}
      <div ref={storyRef} className="bg-smoke-100 grain-overlay">
        <Container size="xl" className="py-24 lg:py-32">
          {/* Brand accent divider */}
          <div className="h-px w-16 bg-brand-500 mb-8" />

          {/* Dynamic smoke narrative heading */}
          {product.smokeHours ? (
            <div className="mb-10">
              <Heading as="h2" variant="h2" className="font-display text-display-sm text-charcoal-900">
                {product.woodType
                  ? t('product.smoke_narrative', { hours: product.smokeHours, wood: product.woodType })
                  : t('product.smoke_narrative_no_wood', { hours: product.smokeHours })}
              </Heading>
              <p className="mt-2 text-sm text-smoke-400 italic">{t('product.smoke_subtitle')}</p>
              {/* Smoke timeline bar */}
              <div className="mt-4 flex items-center gap-2">
                <div className="h-1.5 flex-1 bg-smoke-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-brand-500 to-brand-300 rounded-full"
                    style={{ width: `${Math.min((product.smokeHours / 24) * 100, 100)}%` }}
                  />
                </div>
                <span className="text-xs text-smoke-400 tabular-nums">{product.smokeHours}h</span>
              </div>
            </div>
          ) : (
            <Heading as="h2" variant="h2" className="font-display text-display-sm text-charcoal-900 mb-10">
              {t('product.about_cut')}
            </Heading>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
            {/* Processo */}
            <div className="space-y-4">
              <Heading as="h3" variant="h4" className="text-charcoal-900">
                {t('product.process')}
              </Heading>
              <Text className="text-smoke-400 leading-relaxed">
                {product.description || t('product.process_default')}
              </Text>
            </div>

            {/* Pitmaster Quote — enhanced with avatar */}
            <div className="space-y-4">
              <Heading as="h3" variant="h4" className="text-charcoal-900">
                {t('product.pitmaster')}
              </Heading>
              <blockquote className="pl-6 border-l-2 border-brand-500 italic font-display text-lg text-charcoal-700 leading-relaxed">
                &ldquo;{product.pitmasterNote || t('product.pitmaster_default_quote')}&rdquo;
              </blockquote>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-brand-500 flex items-center justify-center text-white text-xs font-bold">
                  L
                </div>
                <span className="text-sm font-medium text-charcoal-900">{t('product.pitmaster_name')}</span>
              </div>
              <Text variant="small" className="text-smoke-400">
                {t('product.pitmaster_default_bio')}
              </Text>
            </div>

            {/* Origem */}
            <div className="space-y-4">
              <Heading as="h3" variant="h4" className="text-charcoal-900">
                {t('product.origin')}
              </Heading>
              <Text className="text-smoke-400 leading-relaxed">
                {product.origin || t('product.origin_default')}
              </Text>
            </div>

            {/* Harmonização */}
            <div className="space-y-4">
              <Heading as="h3" variant="h4" className="text-charcoal-900">
                {t('product.pairing')}
              </Heading>
              <Text className="text-smoke-400 leading-relaxed">
                {product.pairingTip || t('product.pairing_default')}
              </Text>
            </div>
          </div>
        </Container>
      </div>

      {/* ── Unified "You might also like" cross-sell section ─────────────
          Merges three upstream signals (also-added, category cross-sell,
          cart-aware pool) into a single deduped grid. Previously three
          stacked sections pushed reviews + hydration way below the fold. */}
      {unifiedSuggestions.length > 0 && (
        <div ref={crossSellRef}>
          <Container size="xl" className="py-8 lg:py-12">
            <div className="mb-8">
              <div className="h-px w-16 bg-brand-500 mb-6" />
              <Heading as="h2" variant="h2" className="font-display text-display-sm text-charcoal-900">
                {t('product.cross_sell_title')}
              </Heading>
            </div>

            <ProductGrid
              products={unifiedSuggestions.map(({ id, title, price, imageUrl }) => ({
                id,
                title,
                price,
                imageUrl,
              }))}
              columns={4}
              onAddToCart={handleUnifiedCrossSellAdd}
              getProductHref={(p) => `/loja/produto/${p.id}`}
            />
          </Container>
        </div>
      )}

      {/* ── Sticky Mobile CTA ─────────────────────────────────────────────── */}
      {showStickyCTA && (
        <StickyBottomBar
          price={priceFormatted}
          quantity={quantity}
          onQuantityChange={setQuantity}
          onAction={() => {
            track('sticky_cta_used', { productId: product.id, quantity, source: 'pdp_sticky' })
            handleAddToCart()
          }}
          actionLabel={t('common.add')}
          disabled={isAdding}
          isLoading={isAdding}
        />
      )}
    </div>
  )
}
