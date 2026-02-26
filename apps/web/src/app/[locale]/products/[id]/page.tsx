"use client"

import { useState } from "react"
import { Link } from '@/i18n/navigation'
import { useTranslations } from "next-intl"
import { useProductDetail } from "@/hooks/api"
import { useCartStore, useUIStore } from "@/stores"
import { MediaGallery } from "@/components/molecules/MediaGallery"

export default function ProductPage({ params }: { params: { id: string } }) {
  const t = useTranslations()
  const [quantity, setQuantity] = useState(1)
  const [specialInstructions, setSpecialInstructions] = useState("")
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null)

  const { data: product, loading, error } = useProductDetail(params.id)
  const addItem = useCartStore((s) => s.addItem)
  const { addToast } = useUIStore()

  const handleAddToCart = () => {
    if (!product) return

    addItem(product, quantity, specialInstructions || undefined)

    // Reset form
    setQuantity(1)
    setSpecialInstructions("")
    setSelectedVariant(null)

    addToast(t("product.added"), "success")
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-2">
          <div className="aspect-square rounded-2xl skeleton" />
          <div className="space-y-6 py-4">
            <div className="h-8 w-3/4 rounded-lg skeleton" />
            <div className="h-4 w-full rounded skeleton" />
            <div className="h-4 w-2/3 rounded skeleton" />
            <div className="h-10 w-40 rounded-lg skeleton mt-4" />
            <div className="h-14 w-full rounded-xl skeleton mt-8" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !product) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 text-center sm:px-6 lg:px-8">
        <p className="text-red-600">{t("common.error")}</p>
        <Link href={"/search"} className="mt-4 inline-block text-brand-500">
          {t("common.back")} →
        </Link>
      </div>
    )
  }

  const price = (product.price / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  })

  const variants = product.variants || []

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Breadcrumb */}
      <div className="mb-8 flex gap-2 text-sm text-smoke-400">
        <Link href={"/"} className="hover:text-charcoal-900">
          Home
        </Link>
        <span>/</span>
        <Link href={"/search"} className="hover:text-charcoal-900">
          {t("search.title")}
        </Link>
        <span>/</span>
        <span className="text-charcoal-900">{product.title}</span>
      </div>

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
          <h1 className="text-2xl font-semibold tracking-tight text-charcoal-900">{product.title}</h1>

          {product.description && (
            <p className="mt-4 text-smoke-400 leading-relaxed">{product.description}</p>
          )}

          {/* Price */}
          <div className="mt-6 flex items-baseline gap-2">
            <span className="text-4xl font-bold text-brand-500">{price}</span>
          </div>

          {/* Stock */}
          <div className="mt-4">
            {product.inStock ? (
              <span className="inline-flex rounded-full bg-green-100 px-3 py-1 text-sm font-semibold text-green-800">
                {t("product.in_stock")}
              </span>
            ) : (
              <span className="inline-flex rounded-full bg-red-100 px-3 py-1 text-sm font-semibold text-red-800">
                {t("product.out_of_stock")}
              </span>
            )}
          </div>

          {/* Variants */}
          {variants.length > 0 && (
            <div className="mt-6 border-t border-smoke-200 pt-6">
              <h3 className="text-sm font-medium text-charcoal-900">
                {t("product.variants")}
              </h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {variants.map((variant: any) => {
                  const variantPrice = (variant.price / 100).toLocaleString(
                    "pt-BR",
                    { style: "currency", currency: "BRL" }
                  )
                  return (
                    <button
                      key={variant.id}
                      onClick={() => setSelectedVariant(variant.id)}
                      className={`rounded-xl border-2 px-4 py-2.5 text-sm font-medium transition-all duration-200 ${
                        selectedVariant === variant.id
                          ? "border-brand-500 bg-brand-50 text-brand-800"
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

          {/* Quantity & Special Instructions */}
          <div className="mt-6 border-t border-smoke-200 pt-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-charcoal-900">
                  {t("product.quantity")}
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    className="rounded-sm border border-smoke-200 px-3 py-2 text-charcoal-700 hover:bg-smoke-100 transition-all duration-500"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* Special Instructions */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-charcoal-900">
                {t("product.special_instructions")}
              </label>
              <textarea
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                placeholder={t("product.special_instructions_placeholder")}
                className="mt-2 block w-full border-0 border-b border-smoke-200 px-0 py-2.5 text-sm focus:border-charcoal-900 focus:outline-none transition-colors duration-500"
                rows={3}
              />
            </div>
          </div>

          {/* Add to Cart Button */}
          <button
            onClick={handleAddToCart}
            disabled={!product.inStock}
            className="mt-8 w-full rounded-sm bg-charcoal-900 px-6 py-3 text-sm font-medium text-smoke-50 hover:bg-charcoal-800 transition-all duration-500 disabled:bg-smoke-200 disabled:text-smoke-400 disabled:cursor-not-allowed"
          >
            {product.inStock ? t("product.add_to_cart") : t("product.out_of_stock")}
          </button>

          {/* Back to Search */}
          <Link
            href={"/search"}
            className="mt-4 block text-center text-brand-500 hover:text-brand-600 font-medium transition-colors"
          >
            ← {t("common.back")}
          </Link>
        </div>
      </div>

      {/* Nutritional Info & Allergens */}
      {(product.allergens?.length) && (
        <div className="mt-12 border-t border-smoke-200 pt-8">
          <h2 className="text-lg font-semibold text-charcoal-900">
            {t("product.nutritional_info")}
          </h2>

          {product.allergens?.length > 0 && (
            <div className="mt-6">
              <h3 className="font-semibold text-charcoal-900">
                {t("product.allergens")}
              </h3>
              <p className="mt-2 text-smoke-400">
                {t("product.contains")} {product.allergens.join(", ")}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
