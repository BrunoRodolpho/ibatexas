'use client'

import { Link } from '@/i18n/navigation'

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
    <div className="flex items-center gap-6 overflow-x-auto scrollbar-hide">
      {categories.map((category) => {
        const isActive = activeHandle === category.handle
        return (
          <Link
            key={category.id}
            href={{ pathname: '/search', query: { category: category.handle } } as any}
            className={`flex-shrink-0 text-xs font-medium uppercase tracking-editorial transition-colors duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              isActive
                ? 'text-charcoal-900 border-b border-charcoal-900 pb-0.5'
                : 'text-smoke-400 hover:text-charcoal-900'
            }`}
          >
            {category.name}
          </Link>
        )
      })}
    </div>
  )
}
