'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, TextField } from '@ibatexas/ui/atoms'
import { formatBRL } from '@/lib/format'
import { useProducts } from '@/domains/product'
import {
  resolveAddVariant,
  computeAddPriceDelta,
  isValidAddQuantity,
  MAX_ADD_QUANTITY,
} from '@/domains/cart'
import type { ProductDTO } from '@ibatexas/types'

interface AddItemPickerProps {
  /** Called with the chosen variant + quantity when the customer confirms the add. */
  readonly onAdd: (variantId: string, quantity: number) => void
  /** Return to the edit step without adding. */
  readonly onBack: () => void
  /** Parent-owned submit flag — disables the controls while the add is in flight. */
  readonly isSubmitting: boolean
}

/**
 * Post-order add-item picker (CUS-039). Reuses the catalog `useProducts` fetch
 * used by the loja/cart pages, then emits the chosen variant + quantity to the
 * parent, which posts the SINGLE, kernel-governed amend route. All change math
 * lives in the `domains/cart/amendAdd` helpers so this component stays thin.
 */
export function AddItemPicker({ onAdd, onBack, isSubmitting }: AddItemPickerProps) {
  const t = useTranslations('order')

  const [query, setQuery] = useState('')
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null)
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)

  const { data, loading } = useProducts({ query: query.trim() || undefined, limit: 8 })
  const products: ProductDTO[] = data?.items ?? []

  const selectedProduct = products.find((p) => p.id === selectedProductId) ?? null
  const variant = selectedProduct
    ? resolveAddVariant(selectedProduct, selectedVariantId ?? undefined)
    : undefined

  function handleSelectProduct(product: ProductDTO) {
    setSelectedProductId(product.id)
    setSelectedVariantId(product.variants?.[0]?.id ?? null)
  }

  const priceDelta = selectedProduct
    ? computeAddPriceDelta(selectedProduct, variant, quantity)
    : 0

  const canAdd = Boolean(variant) && isValidAddQuantity(quantity) && !isSubmitting

  return (
    <div className="space-y-4">
      <TextField
        label={t('amend_add')}
        placeholder={t('amend_add_search_placeholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={isSubmitting}
      />

      {/* Product results */}
      <div className="max-h-56 overflow-y-auto space-y-1">
        {loading && <p className="text-sm text-smoke-400 text-center py-3">{t('amend_add_loading')}</p>}
        {!loading && products.length === 0 && (
          <p className="text-sm text-smoke-400 text-center py-3">{t('amend_add_empty')}</p>
        )}
        {!loading &&
          products.map((product) => {
            const isSelected = product.id === selectedProductId
            return (
              <button
                key={product.id}
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSelectProduct(product)}
                className={`w-full text-left py-2 px-2 rounded-sm border transition-colors ${
                  isSelected ? 'border-brand-500 bg-brand-50' : 'border-transparent hover:bg-smoke-50'
                }`}
              >
                <span className="flex items-center justify-between">
                  <span className="text-sm font-medium text-charcoal-900">{product.title}</span>
                  <span className="text-xs text-smoke-400">{formatBRL(product.price)}</span>
                </span>
              </button>
            )
          })}
      </div>

      {/* Variant selection — only when the chosen product has more than one */}
      {selectedProduct && (selectedProduct.variants?.length ?? 0) > 1 && (
        <div className="space-y-2">
          <p className="text-xs text-smoke-400">{t('amend_add_variant_label')}</p>
          <div className="flex flex-wrap gap-2">
            {selectedProduct.variants.map((v) => {
              const isSelected = v.id === (selectedVariantId ?? selectedProduct.variants[0]?.id)
              return (
                <Button
                  key={v.id}
                  variant={isSelected ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => setSelectedVariantId(v.id)}
                >
                  {v.title ?? t('amend_add_variant_default')}
                </Button>
              )
            })}
          </div>
        </div>
      )}

      {/* Quantity stepper — only once a product is chosen */}
      {selectedProduct && (
        <div className="flex items-center justify-between border-t border-smoke-100 pt-3">
          <span className="text-sm text-charcoal-700">{t('amend_qty_label')}</span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={quantity <= 1 || isSubmitting}
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            >
              −
            </Button>
            <span className="text-sm font-medium w-8 text-center">{quantity}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={quantity >= MAX_ADD_QUANTITY || isSubmitting}
              onClick={() => setQuantity((q) => Math.min(MAX_ADD_QUANTITY, q + 1))}
            >
              +
            </Button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 justify-between border-t border-smoke-200 pt-3">
        <Button variant="secondary" size="sm" disabled={isSubmitting} onClick={onBack}>
          ← {t('dialog_back')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canAdd}
          isLoading={isSubmitting}
          onClick={() => variant && onAdd(variant.id, quantity)}
        >
          {t('amend_add_confirm')}
          {priceDelta > 0 && <span className="ml-1">{`(+${formatBRL(priceDelta)})`}</span>}
        </Button>
      </div>
    </div>
  )
}
