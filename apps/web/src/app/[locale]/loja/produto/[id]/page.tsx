'use client'

import { useTranslations } from 'next-intl'
import { useProductDetail, useProducts } from '@/hooks/api'
import { useCartStore, useUIStore } from '@/stores'
import { Heading, Text, Button } from '@/components/atoms'
import { Badge } from '@/components/atoms/Badge'
import { SizeSelector, ShippingEstimate, QuantitySelector } from '@/components/molecules'
import { ProductGrid } from '@/components/organisms'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Star, Truck, Flame, ShieldCheck, ChevronRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { MediaGallery } from '@/components/molecules/MediaGallery'
import { track, trackOnceVisible, trackScrollDepth } from '@/lib/analytics'
import type { ProductDTO } from '@ibatexas/types'

// ── Cross-sell category pairing map ──────────────────────────────────────
const CROSS_SELL_MAP: Record<string, string[]> = {
  'carnes-defumadas': ['acompanhamentos', 'bebidas'],
  'sanduiches': ['acompanhamentos', 'sobremesas'],
  'acompanhamentos': ['carnes-defumadas', 'bebidas'],
  'sobremesas': ['bebidas'],
  'bebidas': ['carnes-defumadas', 'sanduiches'],
  'congelados': ['acompanhamentos'],
}

interface ProductPageProps {
  params: { id: string }
}

// ── Skeleton Loading ─────────────────────────────────────────────────────
function PDPSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6">
      {/* Breadcrumb skeleton */}
      <div className="mb-6 flex gap-2">
        <div className="h-3 w-12 rounded-sm skeleton" />
        <div className="h-3 w-4 rounded-sm skeleton" />
        <div className="h-3 w-32 rounded-sm skeleton" />
        <div className="h-3 w-4 rounded-sm skeleton" />
        <div className="h-3 w-40 rounded-sm skeleton" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
        {/* Image skeleton */}
        <div className="space-y-4">
          <div className="aspect-square rounded-sm skeleton" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="w-16 h-16 rounded-sm skeleton" />
            ))}
          </div>
        </div>

        {/* Details skeleton */}
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="h-8 w-3/4 rounded-sm skeleton" />
            <div className="h-4 w-1/3 rounded-sm skeleton" />
            <div className="flex gap-2">
              <div className="h-5 w-16 rounded-sm skeleton" />
              <div className="h-5 w-20 rounded-sm skeleton" />
            </div>
          </div>
          <div className="h-6 w-1/4 rounded-sm skeleton" />
          <div className="h-12 w-full rounded-sm skeleton" />
          <div className="h-12 w-full rounded-sm skeleton" />
          <div className="space-y-2 pt-6">
            <div className="h-4 w-full rounded-sm skeleton" />
            <div className="h-4 w-5/6 rounded-sm skeleton" />
            <div className="h-4 w-2/3 rounded-sm skeleton" />
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ProductPage({ params }: ProductPageProps) {
  const t = useTranslations()
  const { data: product, loading, error } = useProductDetail(params.id)
  const addToCart = useCartStore(s => s.addItem)
  const { addToast } = useUIStore()
  const openCartDrawer = useUIStore(s => s.openCartDrawer)
  const [selectedVariantId, setSelectedVariantId] = useState<string>('')
  const [quantity, setQuantity] = useState(1)
  const [isAdding, setIsAdding] = useState(false)
  const [showStickyCTA, setShowStickyCTA] = useState(false)
  const [stickyShown, setStickyShown] = useState(false)
  const mainCTARef = useRef<HTMLButtonElement>(null)
  const storyRef = useRef<HTMLDivElement>(null)
  const crossSellRef = useRef<HTMLDivElement>(null)

  // ── Track PDP view ──────────────────────────────────────────────────
  useEffect(() => {
    if (product?.id) {
      track('pdp_viewed', { productId: product.id })
    }
  }, [product?.id])

  // ── Track PDP scroll depth (scroll-position-based, no container ref) ──
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

  // ── Cross-sell data ─────────────────────────────────────────────────
  const productCategory = product?.tags?.[0] || product?.categoryHandle || ''
  const pairedCategories = CROSS_SELL_MAP[productCategory] ?? []
  const crossSellCategory = pairedCategories[0]

  const { data: crossSellData } = useProducts({
    categoryHandle: crossSellCategory,
    limit: 6,
  })

  const crossSellProducts = (crossSellData?.items ?? []).filter(
    (p) => p.id !== params.id,
  )

  // ── Track cross-sell visibility ─────────────────────────────────────
  useEffect(() => {
    if (!crossSellRef.current || !product?.id || crossSellProducts.length === 0) return
    return trackOnceVisible(crossSellRef.current, 'cross_sell_viewed', {
      productId: product.id,
      suggestedIds: crossSellProducts.map((p) => p.id),
    })
  }, [product?.id, crossSellProducts.length])

  if (loading) {
    return <PDPSkeleton />
  }

  if (error || !product) {
    return (
      <div className="text-center py-12">
        <Text variant="body" className="text-red-600">
          {t('shop.errors.product_not_found')}
        </Text>
        <Button variant="tertiary" className="mt-4" asChild>
          <Link href={"/loja"}>{t('shop.back_to_shop')}</Link>
        </Button>
      </div>
    )
  }

  const selectedVariant = selectedVariantId
    ? product.variants.find((v) => v.id === selectedVariantId)
    : product.variants[0]

  const hasVariants = product.variants.length > 1
  const currentPrice = selectedVariant?.price || product.price
  const priceFormatted = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(currentPrice / 100)

  const handleAddToCart = async () => {
    if (!selectedVariant) return

    setIsAdding(true)
    try {
      addToCart(product, quantity, undefined, selectedVariant)
      track('add_to_cart', {
        productId: product.id,
        variantId: selectedVariant.id,
        quantity,
        source: 'pdp',
      })
      addToast('Adicionado ao carrinho', 'success')
      openCartDrawer?.()
    } catch (err) {
      console.error('Failed to add to cart:', err)
      addToast('Erro ao adicionar ao carrinho', 'error')
    } finally {
      setIsAdding(false)
    }
  }

  const handleCrossSellAdd = (productId: string) => {
    const p = crossSellProducts.find((cp) => cp.id === productId)
    if (!p) return
    const defaultVariant = p.variants?.[0]
    addToCart(p as ProductDTO, 1, undefined, defaultVariant)
    track('cross_sell_added', { productId: product.id, suggestedId: productId })
    addToast('Adicionado ao carrinho', 'success')
  }

  // Per-person pricing
  const servings = product.servings ?? null
  const perPersonPrice = servings
    ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
        currentPrice / 100 / servings,
      )
    : null

  return (
    <div>
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        {/* ── Breadcrumb ───────────────────────────────────────────────── */}
        <nav className="mb-6 flex items-center gap-1.5 text-xs text-smoke-400" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-charcoal-900 transition-colors duration-300">Início</Link>
          <ChevronRight className="w-3 h-3 text-smoke-300" />
          <Link href="/loja" className="hover:text-charcoal-900 transition-colors duration-300">Loja</Link>
          {product.categoryHandle && (
            <>
              <ChevronRight className="w-3 h-3 text-smoke-300" />
              <Link
                href={`/search?category=${product.categoryHandle}`}
                className="hover:text-charcoal-900 transition-colors duration-300 capitalize"
              >
                {product.categoryHandle.replace(/-/g, ' ')}
              </Link>
            </>
          )}
          <ChevronRight className="w-3 h-3 text-smoke-300" />
          <span className="text-charcoal-900 font-medium truncate max-w-[200px]">{product.title}</span>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          {/* ── Product Images ──────────────────────────────────────── */}
          <div className="space-y-4">
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

              {/* Social Proof — rating + review count */}
              {product.rating && product.rating > 0 && (
                <div className="flex items-center gap-1.5 mt-2">
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        className={`w-3.5 h-3.5 ${
                          star <= Math.round(product.rating!)
                            ? 'fill-brand-500 text-brand-500'
                            : 'fill-smoke-200 text-smoke-200'
                        }`}
                      />
                    ))}
                  </div>
                  {product.reviewCount ? (
                    <button
                      className="text-xs text-smoke-400 hover:text-charcoal-900 hover:underline transition-colors duration-300"
                      onClick={() => track('review_link_clicked', { productId: product.id })}
                    >
                      ({product.reviewCount} avaliações)
                    </button>
                  ) : null}
                </div>
              )}

              {/* Categories & Tags */}
              {product.tags && product.tags.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {product.tags.map((tag) => (
                    <Badge key={tag} variant={(tag as any) || 'default'}>
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* ── Enhanced Price Display ─────────────────────────────── */}
            <div className="space-y-1">
              <div className="flex items-baseline gap-2">
                {product.compareAtPrice && product.compareAtPrice > currentPrice && (
                  <span className="text-base text-smoke-300 line-through tabular-nums">
                    {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
                      product.compareAtPrice / 100,
                    )}
                  </span>
                )}
                <div className="flex items-baseline">
                  <span className="text-base text-smoke-400">R$</span>
                  <span className="text-2xl font-semibold text-charcoal-900 tabular-nums ml-0.5">
                    {(currentPrice / 100).toFixed(2).replace('.', ',')}
                  </span>
                </div>
              </div>
              {perPersonPrice && (
                <p className="text-xs text-smoke-400">
                  {perPersonPrice} por pessoa · Serve {servings}
                </p>
              )}
            </div>

            {/* ── Trust Signal Bar ──────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row gap-4 sm:gap-6 py-4 border-y border-smoke-200">
              <div className="flex items-center gap-2">
                <Truck className="w-4 h-4 text-smoke-400 flex-shrink-0" />
                <span className="text-xs text-smoke-400">Entrega refrigerada em até 24h</span>
              </div>
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-smoke-400 flex-shrink-0" />
                <span className="text-xs text-smoke-400">Defumado por 12h em lenha de nogueira</span>
              </div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-smoke-400 flex-shrink-0" />
                <span className="text-xs text-smoke-400">100% carne Angus selecionada</span>
              </div>
            </div>

            {/* Size Selection */}
            {hasVariants && (
              <SizeSelector
                variants={product.variants}
                selectedVariant={selectedVariantId}
                onVariantChange={setSelectedVariantId}
              />
            )}

            {/* ── Quantity + Add to Cart ──────────────────────────────── */}
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <Text className="font-medium text-charcoal-900">Quantidade:</Text>
                <QuantitySelector
                  quantity={quantity}
                  onQuantityChange={setQuantity}
                  min={1}
                  max={99}
                />
              </div>

              <Button
                ref={mainCTARef}
                onClick={handleAddToCart}
                disabled={!selectedVariant || isAdding}
                isLoading={isAdding}
                className="w-full"
                size="lg"
              >
                {isAdding ? 'Adicionando...' : 'Adicionar ao Carrinho'}
              </Button>

              {!selectedVariant && hasVariants && (
                <Text variant="small" className="text-brand-500 text-center">
                  Selecione um tamanho
                </Text>
              )}
            </div>

            {/* Shipping Estimate */}
            <ShippingEstimate />

            {/* Product Description */}
            {product.description && (
              <div className="space-y-3 pt-6 border-t border-smoke-200">
                <Heading variant="h3">{t('shop.product_details')}</Heading>
                <Text className="text-smoke-400 leading-relaxed">
                  {product.description}
                </Text>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Storytelling Section (full-bleed) ─────────────────────────────── */}
      <div ref={storyRef} className="mt-16 bg-smoke-100 grain-overlay">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
          {/* Brand accent divider */}
          <div className="h-px w-16 bg-brand-500 mb-8" />

          <Heading as="h2" variant="h2" className="font-display text-display-sm text-charcoal-900 mb-10">
            Sobre este corte
          </Heading>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
            {/* Processo */}
            <div className="space-y-4">
              <Heading as="h3" variant="h4" className="text-charcoal-900">
                Processo
              </Heading>
              <Text className="text-smoke-400 leading-relaxed">
                {product.description ||
                  'Cada peça é preparada artesanalmente em nosso defumador a lenha, com temperatura controlada por até 12 horas. Utilizamos lenha de nogueira selecionada para atingir o equilíbrio perfeito de sabor e maciez.'}
              </Text>
            </div>

            {/* Pitmaster Quote */}
            <div className="space-y-4">
              <Heading as="h3" variant="h4" className="text-charcoal-900">
                Pitmaster
              </Heading>
              <blockquote className="pl-6 border-l-2 border-brand-500 italic font-display text-lg text-charcoal-700 leading-relaxed">
                &ldquo;Cada corte conta uma história. O segredo está na paciência — deixar o tempo e a fumaça fazerem o trabalho.&rdquo;
              </blockquote>
              <Text variant="small" className="text-smoke-400">
                Pitmaster com 15 anos de experiência — Produção semanal limitada
              </Text>
            </div>

            {/* Origem */}
            <div className="space-y-4">
              <Heading as="h3" variant="h4" className="text-charcoal-900">
                Origem
              </Heading>
              <Text className="text-smoke-400 leading-relaxed">
                Carne Angus selecionada de produtores parceiros do Texas. Cada peça passa por rigoroso controle de qualidade antes de entrar no defumador.
              </Text>
            </div>

            {/* Harmonização */}
            <div className="space-y-4">
              <Heading as="h3" variant="h4" className="text-charcoal-900">
                Harmonização
              </Heading>
              <Text className="text-smoke-400 leading-relaxed">
                Sirva com coleslaw cremoso, cornbread artesanal e uma cerveja IPA bem gelada. Para uma experiência completa, acompanhe com nosso molho barbecue da casa.
              </Text>
            </div>
          </div>
        </div>
      </div>

      {/* ── Cross-Sell Section ─────────────────────────────────────────────── */}
      {crossSellProducts.length > 0 && (
        <div ref={crossSellRef} className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
          <div className="mb-8">
            <div className="h-px w-16 bg-brand-500 mb-6" />
            <Heading as="h2" variant="h2" className="font-display text-display-sm text-charcoal-900">
              Para uma experiência completa
            </Heading>
          </div>

          <ProductGrid
            products={crossSellProducts}
            columns={4}
            onAddToCart={handleCrossSellAdd}
            getProductHref={(p) => `/loja/produto/${p.id}`}
          />
        </div>
      )}

      {/* ── Sticky Mobile CTA ─────────────────────────────────────────────── */}
      {showStickyCTA && (
        <div className="fixed bottom-14 inset-x-0 bg-smoke-50/95 backdrop-blur-sm border-t border-smoke-200 p-4 z-20 lg:hidden pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="flex items-center gap-3 max-w-lg mx-auto">
            <QuantitySelector
              quantity={quantity}
              onQuantityChange={setQuantity}
              min={1}
              max={99}
              size="sm"
            />
            <span className="text-sm font-semibold text-charcoal-900 tabular-nums whitespace-nowrap">
              {priceFormatted}
            </span>
            <Button
              onClick={() => {
                track('sticky_cta_used', { productId: product.id, quantity })
                handleAddToCart()
              }}
              disabled={!selectedVariant || isAdding}
              isLoading={isAdding}
              className="flex-1"
              size="md"
            >
              Adicionar
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}