'use client'

import { useTranslations } from 'next-intl'
import { Flame, BadgeDollarSign, Utensils, Users } from 'lucide-react'
import type { ProductDTO } from '@ibatexas/types'
import type { ReactNode } from 'react'

// ── Smart filter definitions ─────────────────────────────────────────────
// Each filter has a client-side predicate applied to allProducts.
// Icons & labels follow the DoorDash "decision shortcut" pattern.

export type SmartFilterId = 'best_seller' | 'under_100' | 'combos' | 'family'

interface SmartFilterDef {
  id: SmartFilterId
  icon: ReactNode
  predicate: (p: ProductDTO) => boolean
}

const SMART_FILTERS: SmartFilterDef[] = [
  {
    id: 'best_seller',
    icon: <Flame className="w-3.5 h-3.5" />,
    predicate: (p) => p.tags?.includes('popular') ?? false,
  },
  {
    id: 'under_100',
    icon: <BadgeDollarSign className="w-3.5 h-3.5" />,
    predicate: (p) => p.price <= 10000, // ≤ R$100,00
  },
  {
    id: 'combos',
    icon: <Utensils className="w-3.5 h-3.5" />,
    predicate: (p) =>
      p.categoryHandle === 'sanduiches' ||
      p.isBundle === true ||
      (p.tags?.includes('combo') ?? false),
  },
  {
    id: 'family',
    icon: <Users className="w-3.5 h-3.5" />,
    predicate: (p) => (p.servings ?? 0) >= 4 || (p.bundleServings ?? 0) >= 4,
  },
]

// ── Public API ───────────────────────────────────────────────────────────

interface SmartFilterRowProps {
  /** Active filters (toggle on/off) */
  readonly activeFilters: SmartFilterId[]
  /** Toggle callback */
  readonly onToggle: (id: SmartFilterId) => void
  /** Full product list — used to show counts per filter */
  readonly products: ProductDTO[]
}

export function SmartFilterRow({ activeFilters, onToggle, products }: SmartFilterRowProps) {
  const t = useTranslations('smart_filters')

  return (
    <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide py-2 -mx-1 px-1">
      {SMART_FILTERS.map((f) => {
        const count = products.filter(f.predicate).length
        if (count === 0) return null // hide empty filters

        const isActive = activeFilters.includes(f.id)

        return (
          <button
            key={f.id}
            onClick={() => onToggle(f.id)}
            className={`
              inline-flex items-center gap-1.5 whitespace-nowrap rounded-full
              border px-3.5 py-2 text-xs font-medium tracking-wide
              transition-all duration-300 ease-luxury
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2
              ${
                isActive
                  ? 'border-brand bg-brand/10 text-brand shadow-sm'
                  : 'border-smoke-200 text-charcoal-700 hover:border-smoke-300 hover:shadow-sm'
              }
            `}
          >
            {f.icon}
            {t(f.id)}
            <span
              className={`
                text-[10px] font-semibold leading-none rounded-full px-1.5 py-0.5
                ${isActive ? 'bg-brand/20 text-brand' : 'bg-smoke-100 text-smoke-500'}
              `}
            >
              {count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Apply active smart filters to a product list (OR logic — any match passes) */
export function applySmartFilters(products: ProductDTO[], activeFilters: SmartFilterId[]): ProductDTO[] {
  if (activeFilters.length === 0) return products
  const predicates = SMART_FILTERS.filter((f) => activeFilters.includes(f.id)).map((f) => f.predicate)
  return products.filter((p) => predicates.some((pred) => pred(p)))
}
