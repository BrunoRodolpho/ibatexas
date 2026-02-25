'use client'

import { Card, Image, Heading, Text, Badge } from '../atoms'
import { Button } from '../atoms/Button'
import Link from 'next/link'

interface ProductCardProps {
  id: string
  title: string
  imageUrl?: string | null
  price: number
  rating?: number
  tags?: string[]
  href?: string
  onAddToCart?: () => void
}

export const ProductCard = ({ id, title, imageUrl, price, rating, tags, href, onAddToCart }: ProductCardProps) => {
  const priceFormatted = (price / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })

  const linkHref = href || `/products/${id}`

  return (
    <Link href={linkHref} className="group block h-full">
      <Card className="flex flex-col cursor-pointer h-full card-hover overflow-hidden">
        {/* Image area — fixed aspect ratio */}
        <div className="relative aspect-[4/3] overflow-hidden">
          {imageUrl ? (
            <Image
              src={imageUrl}
              alt={title}
              variant="card"
              className="aspect-[4/3] transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-brand-50 to-brand-100 flex items-center justify-center">
              <span className="text-5xl">🔥</span>
            </div>
          )}
          {rating && (
            <div className="absolute top-3 right-3 z-10 bg-brand-500 text-white px-2.5 py-1 rounded-lg text-xs font-bold shadow-sm">
              ⭐ {rating.toFixed(1)}
            </div>
          )}
        </div>

        {/* Card body */}
        <div className="flex flex-col gap-2 p-4 flex-1">
          <Heading as="h3" variant="h5" className="line-clamp-2 text-base">
            {title}
          </Heading>

          {tags && tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.slice(0, 2).map((tag) => (
                <Badge key={tag} variant={tag as any} className="text-xs">
                  {tag.replace(/_/g, ' ')}
                </Badge>
              ))}
              {tags.length > 2 && <Badge className="text-xs">+{tags.length - 2}</Badge>}
            </div>
          )}

          <div className="mt-auto flex items-center justify-between pt-3 border-t border-slate-100">
            <Text variant="h6" textColor="accent">
              {priceFormatted}
            </Text>
            <Button
              size="sm"
              onClick={(e) => {
                e.preventDefault()
                onAddToCart?.()
              }}
            >
              Adicionar
            </Button>
          </div>
        </div>
      </Card>
    </Link>
  )
}
