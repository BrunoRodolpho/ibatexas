'use client'

import { Card, Heading } from '../atoms'
import Link from 'next/link'

interface Category {
  id: string
  name: string
  handle: string
}

interface CategoryCarouselProps {
  categories: Category[]
}

export const CategoryCarousel = ({ categories }: CategoryCarouselProps) => {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
      {categories.map((category) => (
        <Link key={category.id} href={`/search?category=${category.handle}`}>
          <Card className="flex-shrink-0 w-44 p-6 text-center card-hover cursor-pointer">
            <div className="h-16 w-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-glow-brand" />
            <Heading as="h4" variant="h6" className="text-center">
              {category.name}
            </Heading>
          </Card>
        </Link>
      ))}
    </div>
  )
}
