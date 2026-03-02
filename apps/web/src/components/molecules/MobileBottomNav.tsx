'use client'

import { Link, usePathname } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { UtensilsCrossed, ShoppingBag, CalendarDays } from 'lucide-react'

const NAV_ITEMS = [
  { href: '/search' as const, icon: UtensilsCrossed, labelKey: 'nav.shop' },
  { href: '/loja' as const, icon: ShoppingBag, labelKey: 'nav.loja' },
  { href: '/account/reservations' as const, icon: CalendarDays, labelKey: 'nav.reservations' },
]

export function MobileBottomNav() {
  const t = useTranslations()
  const pathname = usePathname()

  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 sm:hidden bg-smoke-50/95 backdrop-blur-sm border-t border-smoke-200 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center justify-around h-14">
        {NAV_ITEMS.map(({ href, icon: Icon, labelKey }) => {
          const isActive = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center justify-center flex-1 py-2 transition-colors duration-500 ease-luxury ${
                isActive ? 'text-brand-500' : 'text-smoke-400'
              }`}
            >
              <Icon className="h-5 w-5" strokeWidth={1.5} />
              <span className="mt-0.5 text-[9px] font-medium uppercase tracking-editorial">
                {t(labelKey)}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
