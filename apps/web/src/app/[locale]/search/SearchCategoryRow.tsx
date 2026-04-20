'use client'

import React, { useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Flame, Sandwich, Salad, IceCream, GlassWater, Snowflake, UtensilsCrossed } from 'lucide-react'

/** Category icons — mapped to category handles */
const CATEGORY_ICONS: Record<string, React.ElementType> = {
  'carnes-defumadas': Flame,
  'acompanhamentos': Salad,
  'sanduiches': Sandwich,
  'sobremesas': IceCream,
  'bebidas': GlassWater,
  'congelados': Snowflake,
}

interface CategoryOption {
  readonly id: string
  readonly label: string
}

interface SearchCategoryRowProps {
  readonly categories: CategoryOption[]
  readonly selectedCategory: string | undefined
  readonly onCategoryChange: (categoryId: string) => void
  readonly onClearCategory: () => void
  readonly sticky?: boolean
}

/**
 * Horizontal scrollable category row with icons, sticky behavior, and hover animations.
 * Pattern: DoorDash / Zomato food navigation.
 * Scroll behavior is owned by SearchContent — this component is purely presentational.
 */
export function SearchCategoryRow({
  categories,
  selectedCategory,
  onCategoryChange,
  onClearCategory,
  sticky = false,
}: SearchCategoryRowProps) {
  const t = useTranslations()
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // Auto-scroll to active category pill when it changes
  useEffect(() => {
    if (activeRef.current && scrollRef.current) {
      const container = scrollRef.current
      const active = activeRef.current
      const scrollLeft = active.offsetLeft - container.offsetWidth / 2 + active.offsetWidth / 2
      container.scrollTo({ left: scrollLeft, behavior: 'smooth' })
    }
  }, [selectedCategory])

  return (
    <div
      className={`transition-shadow duration-500 ease-luxury ${
        sticky ? 'sticky top-[104px] z-15 shadow-xs bg-smoke-50/95 backdrop-blur-sm py-1 mb-2' : ''
      }`}
    >
      <div
        ref={scrollRef}
        className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide snap-x"
      >
        {/* "Todos" reset option */}
        <button
          ref={selectedCategory ? undefined : activeRef}
          onClick={() => onClearCategory()}
          className={`category-pill flex-shrink-0 snap-start flex items-center gap-2 text-sm font-medium tracking-wide px-4 py-2.5 rounded-full transition-all duration-500 ease-luxury focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
            selectedCategory
              ? 'text-smoke-500 hover:text-charcoal-900 hover:bg-smoke-100 hover:-translate-y-0.5 hover:shadow-sm'
              : 'bg-charcoal-900 text-smoke-50 font-semibold shadow-md'
          }`}
        >
          <UtensilsCrossed className="w-4 h-4" strokeWidth={1.5} />
          {t('common.all')}
        </button>

        {categories.map((cat) => {
          const Icon = CATEGORY_ICONS[cat.id] || Flame
          const isActive = selectedCategory === cat.id

          return (
            <button
              key={cat.id}
              ref={isActive ? activeRef : undefined}
              onClick={() => onCategoryChange(cat.id)}
              className={`category-pill flex-shrink-0 snap-start flex items-center gap-2 text-sm font-medium tracking-wide px-4 py-2.5 rounded-full transition-all duration-500 ease-luxury focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-charcoal-900 focus-visible:ring-offset-2 ${
                isActive
                  ? 'bg-charcoal-900 text-smoke-50 font-semibold shadow-md'
                  : 'text-smoke-500 hover:text-charcoal-900 hover:bg-smoke-100 hover:-translate-y-0.5 hover:shadow-sm'
              }`}
            >
              <Icon className={`w-4 h-4 transition-micro ${isActive ? 'text-brand-400' : ''}`} strokeWidth={1.5} />
              {cat.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
