"use client"

import { useState, useMemo, useCallback, useRef } from "react"
import { Link } from '@/i18n/navigation'
import { useTranslations } from "next-intl"
import { useParams } from "next/navigation"
import { useProductDetail, useProducts } from '@/domains/product'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { MediaGallery } from "@/components/molecules/MediaGallery"
import { QuantitySelector } from "@/components/molecules/QuantitySelector"
import { ProductCard } from "@/components/molecules/ProductCard"
import { Check } from "lucide-react"
import { track } from '@/domains/analytics'
import type { ProductVariant } from "@ibatexas/types"

export default function ProductPage() {
  const { id } = useParams<{ id: string }>()
  const t = useTranslations()
  const [quantity, setQuantity] = useState(1)
  const [specialInstructions, setSpecialInstructions] = useState("")
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null)
  const [justAdded, setJustAdded] = useState(false)
  const addTimerRef = useRef<NodeJS.Timeout | null>(null)

  const { data: product, loading, error } = useProductDetail(id)
  const addItem = useCartStore((s) => s.addItem)
  const { addToast } = useUIStore()

  // Fetch related products (same category, exclude self)
  const { data: relatedData } = useProducts({
    categoryHandle: product?.categoryHandle,
    limit: 5,
  })
  const relatedProducts = useMemo(
    () => (relatedData?.items ?? []).filter((p) => p.id !== id).slice(0, 4),
    [relatedData?.items, id]
  )

  const variants = useMemo(() => product?.variants || [], [product?.variants])

  // Resolve the selected variant object (auto-select first if none selected)
  const activeVariant: ProductVariant | undefined = useMemo(() => {
    if (selectedVariant) return variants.find((v: ProductVariant) => v.id === selectedVariant)
    return variants[0]
  }, [selectedVariant, variants])

  // Display the active variant's price, falling back to product base price
  const displayPrice = activeVariant?.price ?? product?.price ?? 0
  const price = (displayPrice / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  })

  const handleAddToCart = useCallback(() => {
    if (!product) return

    addItem(product, quantity, specialInstructions || undefined, activeVariant)
    track('add_to_cart', {
      productId: product.id,
      variantId: activeVariant?.id,
      quantity,
      price: displayPrice,
      source: 'pdp',
    })

    // Reset form
    setQuantity(1)
    setSpecialInstructions("")
    setSelectedVariant(null)

    // Checkmark animation: show ✓ for 1.5s then revert
    setJustAdded(true)
    if (addTimerRef.current) clearTimeout(addTimerRef.current)
    addTimerRef.current = setTimeout(() => setJustAdded(false), 1500)

    addToast(t("product.added"), "success")
  }, [product, quantity, specialInstructions, activeVariant, displayPrice, addItem, addToast, t])

  if (loading) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-2">
          <div className="aspect-[4/5] rounded-card skeleton" />
          <div className="space-y-6 py-4">
            <div className="h-8 w-3/4 rounded-sm skeleton" />
            <div className="h-4 w-full rounded-sm skeleton" />
            <div className="h-4 w-2/3 rounded-sm skeleton" />
            <div className="h-10 w-40 rounded-sm skeleton mt-4" />
            <div className="h-14 w-full rounded-sm skeleton mt-8" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !product) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-8 text-center sm:px-6 lg:px-8">
        <p className="text-accent-red">{t("common.error")}</p>
        <Link href={"/search"} className="mt-4 inline-block text-sm font-medium tracking-wide text-smoke-400 hover:text-charcoal-900 transition-colors duration-500 ease-luxury">
          {t("common.back")} →
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 lg:px-8">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-8">
        <ol className="flex gap-2 text-xs tracking-wide text-smoke-400">
          <li>
            <Link href={"/"} className="hover:text-charcoal-900 transition-colors duration-300">
              {t("common.home")}
            </Link>
          </li>
          <li aria-hidden="true" className="text-smoke-300">&middot;</li>
          <li>
            <Link href={"/search"} className="hover:text-charcoal-900 transition-colors duration-300">
              {t("search.title")}
            </Link>
          </li>
          <li aria-hidden="true" className="text-smoke-300">&middot;</li>
          <li aria-current="page" className="text-charcoal-900 font-medium">{product.title}</li>
        </ol>
      </nav>

      <div className="grid gap-12 lg:grid-cols-2">
        {/* Images */}
        <div>
          <MediaGallery
            images={product.images ?? []}
            thumbnail={product.imageUrl}
            title={product.title}
          />
        </div>

        {/* Details */}
        <div>
          <h1 className="font-display text-display-sm font-semibold tracking-display text-charcoal-900">{product.title}</h1>

          {product.description && (
            <p className="mt-4 text-smoke-400 leading-relaxed">{product.description}</p>
          )}

          {/* Price */}
          <div className="mt-8">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-display-xs font-semibold text-charcoal-900">{price}</span>
            </div>
          </div>

          {/* Variants */}
          {variants.length > 0 && (
            <div className="mt-6">
              <h3 id="variant-group-label" className="text-sm font-medium text-charcoal-900">
                {t("product.variants")}
              </h3>
              <div
                role="radiogroup"
                aria-labelledby="variant-group-label"
                className="mt-3 flex flex-wrap gap-2"
              >
                {variants.map((variant: ProductVariant) => {
                  const isSelected = (selectedVariant ?? variants[0]?.id) === variant.id
                  const variantPrice = (variant.price / 100).toLocaleString(
                    "pt-BR",
                    { style: "currency", currency: "BRL" }
                  )
                  return (
                    <button
                      key={variant.id}
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => setSelectedVariant(variant.id)}
                      className={`rounded-sm border px-4 py-3 text-sm font-medium transition-all duration-500 ease-luxury focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
                        isSelected
                          ? "border-charcoal-900 bg-charcoal-900 text-smoke-50"
                          : "border-smoke-200 text-charcoal-700 hover:border-smoke-300"
                      }`}
                    >
                      {variant.title} - {variantPrice}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Quantity */}
          <div className="mt-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-charcoal-900">
                  {t("product.quantity")}
                </label>
                <div className="mt-2">
                  <QuantitySelector
                    quantity={quantity}
                    onQuantityChange={setQuantity}
                    min={1}
                    max={99}
                    size="md"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Add to Cart Button */}
          {(() => {
            const stockLabel = product.inStock ? t("product.add_to_cart") : t("product.out_of_stock")
            return (
              <button
                onClick={handleAddToCart}
                disabled={!product.inStock || justAdded}
                className={`mt-8 w-full rounded-sm px-6 py-3.5 text-sm font-medium tracking-wide shadow-md transition-all duration-500 ease-luxury active:scale-[0.97] active:shadow-xs disabled:cursor-not-allowed disabled:shadow-none ${
                  justAdded
                    ? "bg-accent-green text-smoke-50"
                    : "bg-charcoal-900 text-smoke-50 hover:bg-charcoal-700 hover:shadow-lg disabled:bg-smoke-200 disabled:text-smoke-400"
                }`}
              >
                {justAdded ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Check className="w-4 h-4" strokeWidth={2.5} />
                    {t("product.added")}
                  </span>
                ) : (
                  stockLabel
                )}
              </button>
            )
          })()}

          {/* Below-fold details */}
          {/* Per-serving price + servings info */}
          {product.servings && product.servings > 0 && (
            <div className="mt-8">
              <p className="text-xs text-smoke-400">
                {(displayPrice / product.servings / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} {t("product.per_serving")} · Serve {product.servings} pessoas
              </p>
            </div>
          )}

          {/* Special Instructions */}
          <div className="mt-8">
            <label htmlFor="special-instructions" className="block text-sm font-medium text-charcoal-900">
              {t("product.special_instructions")}
            </label>
            <textarea
              id="special-instructions"
              value={specialInstructions}
              onChange={(e) => setSpecialInstructions(e.target.value)}
              placeholder={t("product.special_instructions_placeholder")}
              className="mt-2 block w-full border-0 border-b border-smoke-200 px-0 py-2.5 text-sm focus:border-charcoal-900 focus:outline-none transition-colors duration-500"
              rows={3}
            />
          </div>
        </div>
      </div>

      {/* Sticky mobile CTA bar */}
      <div className="fixed bottom-14 left-0 right-0 z-30 bg-smoke-50/95 backdrop-blur-sm border-t border-smoke-200 px-4 py-3 sm:hidden">
        <div className="flex items-center justify-between gap-4">
          <span className="text-lg font-bold text-charcoal-900">{price}</span>
          <button
            onClick={() => {
              handleAddToCart()
              track('sticky_cta_used', { productId: product.id })
            }}
            disabled={!product.inStock}
            className="flex-1 max-w-[200px] rounded-sm bg-charcoal-900 px-4 py-3 text-sm font-medium text-smoke-50 active:scale-[0.97] transition-transform disabled:bg-smoke-200 disabled:text-smoke-400 disabled:cursor-not-allowed"
          >
            {product.inStock ? t("product.add_to_cart") : t("product.out_of_stock")}
          </button>
        </div>
      </div>

      {/* Nutritional Info & Allergens */}
      {product.allergens && product.allergens.length > 0 && (
        <div className="mt-16">
          <h2 className="font-display text-lg font-semibold text-charcoal-900">
            {t("product.nutritional_info")}
          </h2>

          {product.allergens?.length > 0 && (
            <div className="mt-6">
              <h3 className="font-display font-semibold text-charcoal-900">
                {t("product.allergens")}
              </h3>
              <p className="mt-2 text-smoke-400">
                {t("product.contains")} {product.allergens.join(", ")}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Cross-sell: related products */}
      {relatedProducts.length > 0 && (
        <div className="mt-16">
          <h2 className="font-display text-lg font-semibold text-charcoal-900 mb-6">
            {t("product.related_products")}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 sm:gap-6">
            {relatedProducts.map((p, i) => (
              <div
                key={p.id}
                className="opacity-0 animate-reveal"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <ProductCard
                  id={p.id}
                  title={p.title}
                  imageUrl={p.imageUrl}
                  images={p.images}
                  price={p.price}
                  tags={p.tags}
                  weight={p.weight}
                  servings={p.servings}
                  rating={p.rating}
                  reviewCount={p.reviewCount}
                  priority={i < 2}
                  onAddToCart={() => {
                    const variant = p.variants?.[0]
                    addItem(p, 1, undefined, variant)
                    addToast(t("product.added"), "success")
                    track("add_to_cart", { productId: p.id, source: "cross_sell" })
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
