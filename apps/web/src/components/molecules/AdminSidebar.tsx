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
} from 'lucide-react'
import { AdminSidebarBase, type AdminSidebarNavGroup } from '@ibatexas/ui'

export function AdminSidebar() {
  const t = useTranslations()
  const pathname = usePathname()

  const groups: AdminSidebarNavGroup[] = [
    {
      label: 'Principal',
      items: [
        { key: 'dashboard', label: t('admin.dashboard'), href: '/admin', icon: LayoutDashboard },
        { key: 'cardapio', label: t('admin.menu'), href: '/admin/cardapio', icon: UtensilsCrossed },
        { key: 'loja', label: t('admin.shop'), href: '/admin/loja', icon: ShoppingBag },
      ],
    },
    {
      label: 'Operações',
      items: [
        { key: 'pedidos', label: t('admin.orders'), href: '/admin/pedidos', icon: ClipboardList },
        { key: 'reservas', label: t('admin.reservations'), href: '/admin/reservas', icon: CalendarDays },
        { key: 'zonas', label: t('admin.delivery_zones'), href: '/admin/zonas', icon: MapPin },
        { key: 'avaliacoes', label: t('admin.reviews'), href: '/admin/avaliacoes', icon: Star },
        { key: 'analises', label: t('admin.analytics'), href: '/admin/analises', icon: BarChart2 },
      ],
    },
  ]

  return (
    <AdminSidebarBase
      LinkComponent={Link}
      groups={groups}
      pathname={pathname}
      medusaAdminUrl={MEDUSA_ADMIN_URL}
    />
  )
}
