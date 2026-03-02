'use client'

import { CarouselCard } from '../molecules/CarouselCard'
import type { ProductDTO } from '@ibatexas/types'

interface ProductCarouselProps {
  products: ProductDTO[]
  isLoading?: boolean
}

export const ProductCarousel = ({ products, isLoading }: ProductCarouselProps) => {
  const shouldAnimate = products.length >= 4

  if (isLoading) {
    return (
      <div className="overflow-hidden">
        <div className="flex gap-6 px-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex-shrink-0 w-[300px] aspect-[16/10] rounded-sm skeleton"
            />
          ))}
        </div>
      </div>
    )
  }

  if (products.length === 0) return null

  // Static layout for few products
  if (!shouldAnimate) {
    return (
      <div className="overflow-hidden">
        <div className="flex gap-6 px-6 justify-center">
          {products.map((product) => (
            <CarouselCard
              key={product.id}
              id={product.id}
              title={product.title}
              description={product.description}
              imageUrl={product.imageUrl}
              images={product.images}
              price={product.price}
              rating={product.rating}
              tags={product.tags}
            />
          ))}
        </div>
      </div>
    )
  }

  // Infinite marquee — duplicate products for seamless loop
  return (
    <div className="group overflow-hidden marquee-mask">
      <div className="flex w-max gap-6 will-change-transform animate-marquee group-hover:[animation-play-state:paused]">
        {/* First copy */}
        {products.map((product) => (
          <CarouselCard
            key={`a-${product.id}`}
            id={product.id}
            title={product.title}
            description={product.description}
            imageUrl={product.imageUrl}
            images={product.images}
            price={product.price}
            rating={product.rating}
            tags={product.tags}
          />
        ))}
        {/* Duplicate for seamless loop */}
        {products.map((product) => (
          <CarouselCard
            key={`b-${product.id}`}
            id={product.id}
            title={product.title}
            description={product.description}
            imageUrl={product.imageUrl}
            images={product.images}
            price={product.price}
            rating={product.rating}
            tags={product.tags}
          />
        ))}
      </div>
    </div>
  )
}
