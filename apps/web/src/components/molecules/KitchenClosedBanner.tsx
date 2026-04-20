'use client'

import { AlertTriangle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '../atoms'
import { Link } from '@/i18n/navigation'
import type { CartItem } from '@/domains/cart'

interface KitchenClosedBannerProps {
  nextOpenDay: string
  kitchenItems: CartItem[]
  /** When provided, shows a "remove unavailable items" button. */
  onRemoveKitchenItems?: () => void
  /** Compact mode for cart drawer (hides item list). */
  compact?: boolean
}

export function KitchenClosedBanner({
  nextOpenDay,
  kitchenItems,
  onRemoveKitchenItems,
  compact = false,
}: KitchenClosedBannerProps) {
  const t = useTranslations('checkout')

  return (
    <div className="rounded-sm border border-amber-200 bg-amber-50 p-4 space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <div className="space-y-1 min-w-0">
          <p className="text-sm font-semibold text-amber-800">
            {t('kitchen_closed_title')}
          </p>
          <p className="text-sm text-amber-700">
            {t('kitchen_closed_message', { nextOpenDay })}
          </p>
        </div>
      </div>

      {!compact && kitchenItems.length > 0 && (
        <div className="space-y-2 pt-1">
          <p className="text-xs text-amber-700">
            {t('kitchen_closed_food_blocked', { count: kitchenItems.length })}
          </p>
          <ul className="text-xs text-amber-600 space-y-0.5 pl-4 list-disc">
            {kitchenItems.map((item) => (
              <li key={item.id}>{item.quantity}&times; {item.title}</li>
            ))}
          </ul>
        </div>
      )}

      {onRemoveKitchenItems && kitchenItems.length > 0 && (
        <div className="flex flex-col gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={onRemoveKitchenItems}
            className="w-full"
          >
            {t('kitchen_closed_remove_items')}
          </Button>
          <p className="text-xs text-amber-600 text-center">
            {t('kitchen_closed_mixed_hint')}
          </p>
        </div>
      )}

      {!onRemoveKitchenItems && kitchenItems.length > 0 && (
        <Link
          href="/loja"
          className="inline-block text-sm text-amber-700 hover:text-amber-900 underline pt-1"
        >
          {t('kitchen_closed_browse_available')}
        </Link>
      )}
    </div>
  )
}
