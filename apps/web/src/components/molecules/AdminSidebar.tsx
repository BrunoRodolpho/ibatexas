'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import { MEDUSA_ADMIN_URL } from '@/lib/api'
import {
  LayoutDashboard,
  UtensilsCrossed,
  ShoppingBag,
  ClipboardList,
  CalendarDays,
  MapPin,
  Star,
  BarChart2,
  ChevronRight,
} from 'lucide-react'

interface NavItem {
  key: string
  labelKey: string
  href: string
  icon: React.ElementType
  comingSoon?: boolean
}

export function AdminSidebar() {
  const t = useTranslations()
  const locale = useLocale()
  const pathname = usePathname()

  const nav: NavItem[] = [
    { key: 'dashboard', labelKey: 'admin.dashboard', href: `/${locale}/admin`, icon: LayoutDashboard },
    { key: 'cardapio', labelKey: 'admin.menu', href: `/${locale}/admin/cardapio`, icon: UtensilsCrossed },
    { key: 'loja', labelKey: 'admin.shop', href: `/${locale}/admin/loja`, icon: ShoppingBag },
    { key: 'pedidos', labelKey: 'admin.orders', href: `/${locale}/admin/pedidos`, icon: ClipboardList, comingSoon: true },
    { key: 'reservas', labelKey: 'admin.reservations', href: `/${locale}/admin/reservas`, icon: CalendarDays, comingSoon: true },
    { key: 'zonas', labelKey: 'admin.delivery_zones', href: `/${locale}/admin/zonas`, icon: MapPin, comingSoon: true },
    { key: 'avaliacoes', labelKey: 'admin.reviews', href: `/${locale}/admin/avaliacoes`, icon: Star, comingSoon: true },
    { key: 'analises', labelKey: 'admin.analytics', href: `/${locale}/admin/analises`, icon: BarChart2, comingSoon: true },
  ]

  const isActive = (href: string) => {
    if (href === `/${locale}/admin`) return pathname === `/${locale}/admin`
    return pathname.startsWith(href)
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      {/* Logo */}
      <div className="flex h-16 items-center border-b border-slate-200 px-6">
        <Link href={`/${locale}/admin`} className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-amber-700" />
          <span className="font-bold text-slate-900">IbateXas</span>
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-700">
            Admin
          </span>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-0.5">
          {nav.map((item) => {
            const active = isActive(item.href)
            const Icon = item.icon
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-amber-50 text-amber-700'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-amber-700' : 'text-slate-400'}`} />
                  <span className="flex-1">{t(item.labelKey)}</span>
                  {item.comingSoon && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-400">
                      Em breve
                    </span>
                  )}
                  {active && !item.comingSoon && (
                    <ChevronRight className="h-3 w-3 text-amber-700" />
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Bottom — Medusa link */}
      <div className="border-t border-slate-200 p-3">
        <a
          href={`${MEDUSA_ADMIN_URL}/app`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
        >
          <div className="h-4 w-4 shrink-0 rounded-sm bg-slate-400" />
          Medusa Admin ↗
        </a>
      </div>
    </aside>
  )
}
