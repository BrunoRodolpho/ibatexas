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
  onAddToCart?: () => void
}

export const ProductCard = ({ id, title, imageUrl, price, rating, tags, onAddToCart }: ProductCardProps) => {
  const priceFormatted = (price / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })

  return (
    <Link href={`/products/${id}`}>
      <Card className="flex flex-col gap-3 cursor-pointer h-full transition-transform hover:scale-105">
        <div className="relative overflow-hidden rounded-lg">
          {imageUrl ? (
            <Image src={imageUrl} alt={title} variant="card" className="w-full h-48 object-cover" />
          ) : (
            <div className="w-full h-48 bg-slate-200 flex items-center justify-center text-slate-400">
              Sem imagem
            </div>
          )}
          {rating && (
            <div className="absolute top-2 right-2 bg-amber-700 text-white px-2 py-1 rounded text-xs font-bold">
              ⭐ {rating.toFixed(1)}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Heading as="h3" variant="h5" className="line-clamp-2">
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

          <div className="flex items-center justify-between pt-2 border-t border-slate-200">
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
