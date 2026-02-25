'use client'

import Link from 'next/link'

interface Category {
  id: string
  name: string
  handle: string
}

interface CategoryCarouselProps {
  categories: Category[]
  activeHandle?: string
}

export const CategoryCarousel = ({ categories, activeHandle }: CategoryCarouselProps) => {
  return (
    <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
      {categories.map((category) => {
        const isActive = activeHandle === category.handle
        return (
          <Link
            key={category.id}
            href={`/search?category=${category.handle}`}
            className={`flex-shrink-0 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
              isActive
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-900'
            }`}
          >
            {category.name}
          </Link>
        )
      })}
    </div>
  )
}
