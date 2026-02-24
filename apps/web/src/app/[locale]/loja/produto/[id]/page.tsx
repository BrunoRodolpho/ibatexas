'use client'

import { useTranslations, useLocale } from 'next-intl'
import { useProductDetail } from '@/hooks/api'
import { useCartStore } from '@/stores'
import { Heading, Text, Button } from '@/components/atoms'
import { Badge } from '@/components/atoms/Badge'
import { SizeSelector, ShippingEstimate } from '@/components/molecules'
import { useState } from 'react'
import { ArrowLeft, Heart, Share2 } from 'lucide-react'
import Link from 'next/link'
import Image from 'next/image'
import clsx from 'clsx'

interface ProductPageProps {
  params: { id: string }
}

export default function ProductPage({ params }: ProductPageProps) {
  const t = useTranslations()
  const locale = useLocale()
  const { data: product, loading, error } = useProductDetail(params.id)
  const addToCart = useCartStore(s => s.addItem)
  const [selectedVariantId, setSelectedVariantId] = useState<string>('')
  const [quantity, setQuantity] = useState(1)
  const [isAdding, setIsAdding] = useState(false)

  if (loading) {
    return (
      <div className="text-center py-12">
        <Text>{t('common.loading')}</Text>
      </div>
    )
  }

  if (error || !product) {
    return (
      <div className="text-center py-12">
        <Text variant="body" className="text-red-600">
          {t('shop.errors.product_not_found')}
        </Text>
        <Button variant="tertiary" className="mt-4" asChild>
          <Link href={`/${locale}/loja`}>{t('shop.back_to_shop')}</Link>
        </Button>
      </div>
    )
  }

  const selectedVariant = selectedVariantId 
    ? product.variants.find(v => v.id === selectedVariantId)
    : product.variants[0]

  const hasVariants = product.variants.length > 1
  const currentImage = product.imageUrl

  const handleAddToCart = async () => {
    if (!selectedVariant) return

    setIsAdding(true)
    try {
      addToCart(product, quantity)
      // Could show success toast here
    } catch (error) {
      console.error('Failed to add to cart:', error)
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Breadcrumb & Back */}
      <div className="mb-6">
        <Button variant="tertiary" asChild>
          <Link href={`/${locale}/loja`} className="inline-flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            {t('shop.back_to_shop')}
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
        {/* Product Images */}
        <div className="space-y-4">
          {/* Main Image */}
          <div className="aspect-square bg-gray-100 rounded-2xl overflow-hidden">
            {currentImage ? (
              <Image
                src={currentImage}
                alt={product.title}
                width={600}
                height={600}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Text className="text-gray-400">Sem imagem</Text>
              </div>
            )}
          </div>
        </div>

        {/* Product Details */}
        <div className="space-y-6">
          {/* Header */}
          <div>
            <div className="flex items-start justify-between mb-2">
              <Heading variant="h1" className="text-gray-900">
                {product.title}
              </Heading>
              <div className="flex gap-2">
                <Button variant="tertiary" size="sm">
                  <Heart className="w-4 h-4" />
                </Button>
                <Button variant="tertiary" size="sm">
                  <Share2 className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Categories & Tags */}
            <div className="flex flex-wrap gap-2 mb-4">
              {product.tags?.map((tag) => (
                <Badge key={tag} variant="default">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>

          {/* Price */}
          <div className="space-y-2">
            <Text variant="h2" weight="bold" className="text-gray-900">
              {new Intl.NumberFormat('pt-BR', {
                style: 'currency',
                currency: 'BRL'
              }).format(product.price / 100)}
            </Text>
          </div>

          {/* Size Selection */}
          {hasVariants && (
            <SizeSelector
              variants={product.variants}
              selectedVariant={selectedVariantId}
              onVariantChange={setSelectedVariantId}
            />
          )}

          {/* Add to Cart */}
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <Text className="font-medium text-gray-900">Quantidade:</Text>
              <div className="flex items-center border rounded-lg">
                <Button 
                  variant="tertiary" 
                  size="sm"
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  disabled={quantity <= 1}
                >
                  -
                </Button>
                <span className="px-4 py-2 min-w-[3rem] text-center">{quantity}</span>
                <Button 
                  variant="tertiary" 
                  size="sm"
                  onClick={() => setQuantity(quantity + 1)}
                >
                  +
                </Button>
              </div>
            </div>

            <Button
              onClick={handleAddToCart}
              disabled={!selectedVariant || isAdding}
              className="w-full"
              size="lg"
            >
              {isAdding ? 'Adicionando...' : 'Adicionar ao Carrinho'}
            </Button>

            {!selectedVariant && hasVariants && (
              <Text variant="small" className="text-amber-600 text-center">
                Selecione um tamanho
              </Text>
            )}
          </div>

          {/* Shipping Estimate */}
          <ShippingEstimate />

          {/* Product Description */}
          {product.description && (
            <div className="space-y-3 pt-6 border-t">
              <Heading variant="h3">{t('shop.product_details')}</Heading>
              <Text className="text-gray-600 leading-relaxed">
                {product.description}
              </Text>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}