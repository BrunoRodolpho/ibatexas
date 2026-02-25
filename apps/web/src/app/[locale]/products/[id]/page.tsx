"use client"

import { useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { useTranslations, useLocale } from "next-intl"
import { useProductDetail } from "@/hooks/api"
import { useCartStore, useUIStore } from "@/stores"

export default function ProductPage({ params }: { params: { id: string } }) {
  const t = useTranslations()
  const locale = useLocale()
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
        <div className="animate-pulse space-y-6">
          <div className="aspect-square rounded-lg bg-gray-200" />
          <div className="h-8 w-64 rounded bg-gray-200" />
          <div className="h-4 w-full rounded bg-gray-200" />
        </div>
      </div>
    )
  }

  if (error || !product) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 text-center sm:px-6 lg:px-8">
        <p className="text-red-600">{t("common.error")}</p>
        <Link href={`/${locale}/search`} className="mt-4 inline-block text-orange-600">
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
      <div className="mb-8 flex gap-2 text-sm text-gray-600">
        <Link href={`/${locale}`} className="hover:text-gray-900">
          Home
        </Link>
        <span>/</span>
        <Link href={`/${locale}/search`} className="hover:text-gray-900">
          {t("search.title")}
        </Link>
        <span>/</span>
        <span className="text-gray-900">{product.title}</span>
      </div>

      <div className="grid gap-12 lg:grid-cols-2">
        {/* Images */}
        <div>
          {product.imageUrl && (
            <div className="relative mb-4 overflow-hidden rounded-lg bg-gray-100">
              <Image
                src={product.imageUrl}
                alt={product.title}
                className="aspect-square h-full w-full object-cover"
                width={400}
                height={400}
                unoptimized
              />
            </div>
          )}
          {/* Related Images Placeholder */}
          {product.imageUrl && (
            <div className="grid grid-cols-4 gap-2">
              <div
                className="cursor-pointer overflow-hidden rounded border-2 border-orange-600"
              >
                <Image
                  src={product.imageUrl}
                  alt={`${product.title} 1`}
                  className="aspect-square h-20 w-20 object-cover transition hover:scale-105"
                  width={80}
                  height={80}
                  unoptimized
                />
              </div>
            </div>
          )}
        </div>

        {/* Details */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{product.title}</h1>

          {product.description && (
            <p className="mt-4 text-gray-600">{product.description}</p>
          )}

          {/* Price */}
          <div className="mt-6 flex items-baseline gap-2">
            <span className="text-4xl font-bold text-orange-600">{price}</span>
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
            <div className="mt-6 border-t border-gray-200 pt-6">
              <h3 className="text-sm font-medium text-gray-900">
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
                      className={`rounded-lg border-2 px-4 py-2 text-sm font-medium transition ${
                        selectedVariant === variant.id
                          ? "border-orange-600 bg-orange-50 text-orange-900"
                          : "border-gray-200 text-gray-700 hover:border-gray-300"
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
          <div className="mt-6 border-t border-gray-200 pt-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-900">
                  {t("product.quantity")}
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-gray-600 hover:bg-gray-100"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min="1"
                    value={quantity}
                    onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-16 rounded-lg border border-gray-300 px-3 py-2 text-center"
                  />
                  <button
                    onClick={() => setQuantity(quantity + 1)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-gray-600 hover:bg-gray-100"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* Special Instructions */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-900">
                {t("product.special_instructions")}
              </label>
              <textarea
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                placeholder={t("product.special_instructions_placeholder")}
                className="mt-2 block w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-orange-600 focus:outline-none"
                rows={3}
              />
            </div>
          </div>

          {/* Add to Cart Button */}
          <button
            onClick={handleAddToCart}
            disabled={!product.inStock}
            className="mt-8 w-full rounded-lg bg-orange-600 px-6 py-3 font-medium text-white hover:bg-orange-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {product.inStock ? t("product.add_to_cart") : t("product.out_of_stock")}
          </button>

          {/* Back to Search */}
          <Link
            href={`/${locale}/search`}
            className="mt-4 block text-center text-orange-600 hover:text-orange-700"
          >
            ← {t("common.back")}
          </Link>
        </div>
      </div>

      {/* Nutritional Info & Allergens */}
      {(product.allergens?.length) && (
        <div className="mt-12 border-t pt-8">
          <h2 className="text-2xl font-bold text-gray-900">
            {t("product.nutritional_info")}
          </h2>

          {product.allergens?.length > 0 && (
            <div className="mt-6">
              <h3 className="font-semibold text-gray-900">
                {t("product.allergens")}
              </h3>
              <p className="mt-2 text-gray-600">
                {t("product.contains")} {product.allergens.join(", ")}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
