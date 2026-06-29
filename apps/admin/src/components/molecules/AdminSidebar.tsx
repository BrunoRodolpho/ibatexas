'use client'

import { useMemo } from 'react'
import Link from 'next/link'
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
  Clock,
  Type,
  AlertTriangle,
} from 'lucide-react'
import { AdminSidebarBase, INCIDENT_LABELS, type AdminSidebarNavGroup } from '@ibatexas/ui'
import { useOpenIncidentCount } from '@/domains/admin/admin.hooks'

const baseGroups: AdminSidebarNavGroup[] = [
  {
    label: 'Principal',
    items: [
      { key: 'dashboard', label: 'Dashboard', href: '/admin', icon: LayoutDashboard },
      { key: 'cardapio', label: 'Cardápio', href: '/admin/cardapio', icon: UtensilsCrossed },
      { key: 'loja', label: 'Loja', href: '/admin/loja', icon: ShoppingBag },
    ],
  },
  {
    label: 'Operações',
    items: [
      { key: 'pedidos', label: 'Pedidos', href: '/admin/pedidos', icon: ClipboardList },
      { key: 'reservas', label: 'Reservas', href: '/admin/reservas', icon: CalendarDays },
      { key: 'incidentes', label: INCIDENT_LABELS.nav, href: '/admin/incidentes', icon: AlertTriangle },
      { key: 'horarios', label: 'Horários', href: '/admin/horarios', icon: Clock },
      { key: 'zonas', label: 'Zonas de Entrega', href: '/admin/zonas', icon: MapPin },
      { key: 'avaliacoes', label: 'Avaliações', href: '/admin/avaliacoes', icon: Star },
      { key: 'analises', label: 'Análises', href: '/admin/analises', icon: BarChart2 },
      { key: 'banner', label: 'Banner', href: '/admin/banner', icon: Type },
    ],
  },
]

export function AdminSidebar() {
  const pathname = usePathname()
  const openIncidentCount = useOpenIncidentCount()

  const groups = useMemo<AdminSidebarNavGroup[]>(
    () =>
      baseGroups.map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.key === 'incidentes' ? { ...item, count: openIncidentCount } : item,
        ),
      })),
    [openIncidentCount],
  )

  return (
    <AdminSidebarBase
      LinkComponent={Link}
      groups={groups}
      pathname={pathname}
      medusaAdminUrl={MEDUSA_ADMIN_URL}
    />
  )
}
