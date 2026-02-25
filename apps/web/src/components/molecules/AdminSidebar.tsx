'use client'

import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
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
  ExternalLink,
} from 'lucide-react'

interface NavItem {
  key: string
  labelKey: string
  href: string
  icon: React.ElementType
}

interface NavGroup {
  label: string
  items: NavItem[]
}

export function AdminSidebar() {
  const t = useTranslations()
  const pathname = usePathname()

  const groups: NavGroup[] = [
    {
      label: 'Principal',
      items: [
        { key: 'dashboard', labelKey: 'admin.dashboard', href: '/admin', icon: LayoutDashboard },
        { key: 'cardapio', labelKey: 'admin.menu', href: '/admin/cardapio', icon: UtensilsCrossed },
        { key: 'loja', labelKey: 'admin.shop', href: '/admin/loja', icon: ShoppingBag },
      ],
    },
    {
      label: 'Operações',
      items: [
        { key: 'pedidos', labelKey: 'admin.orders', href: '/admin/pedidos', icon: ClipboardList },
        { key: 'reservas', labelKey: 'admin.reservations', href: '/admin/reservas', icon: CalendarDays },
        { key: 'zonas', labelKey: 'admin.delivery_zones', href: '/admin/zonas', icon: MapPin },
        { key: 'avaliacoes', labelKey: 'admin.reviews', href: '/admin/avaliacoes', icon: Star },
        { key: 'analises', labelKey: 'admin.analytics', href: '/admin/analises', icon: BarChart2 },
      ],
    },
  ]

  const isActive = (href: string) => {
    if (href === '/admin') return pathname === '/admin'
    return pathname.startsWith(href)
  }

  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-slate-200 bg-white">
      {/* Logo */}
      <div className="flex h-14 items-center px-5">
        <Link href="/admin" className="flex items-center gap-2">
          <span className="text-base font-semibold text-slate-900">IbateXas</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
            Admin
          </span>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        {groups.map((group) => (
          <div key={group.label} className="mt-5 first:mt-0">
            <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-slate-400">
              {group.label}
            </p>
            <ul className="space-y-px">
              {group.items.map((item) => {
                const active = isActive(item.href)
                const Icon = item.icon
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors ${
                        active
                          ? 'bg-slate-100 text-slate-900'
                          : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                      }`}
                    >
                      <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-slate-900' : 'text-slate-400'}`} />
                      <span>{t(item.labelKey)}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Bottom — Medusa link */}
      <div className="border-t border-slate-100 px-3 py-2">
        <a
          href={`${MEDUSA_ADMIN_URL}/app`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-slate-400 hover:bg-slate-50 hover:text-slate-600"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Medusa Admin
        </a>
      </div>
    </aside>
  )
}
