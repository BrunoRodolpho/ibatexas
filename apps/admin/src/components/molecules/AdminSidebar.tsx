'use client'

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
} from 'lucide-react'
import { AdminSidebarBase, type AdminSidebarNavGroup } from '@ibatexas/ui'

const groups: AdminSidebarNavGroup[] = [
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
      { key: 'horarios', label: 'Horários', href: '/admin/horarios', icon: Clock },
      { key: 'zonas', label: 'Zonas de Entrega', href: '/admin/zonas', icon: MapPin },
      { key: 'avaliacoes', label: 'Avaliações', href: '/admin/avaliacoes', icon: Star },
      { key: 'analises', label: 'Análises', href: '/admin/analises', icon: BarChart2 },
    ],
  },
]

export function AdminSidebar() {
  const pathname = usePathname()
  return (
    <AdminSidebarBase
      LinkComponent={Link}
      groups={groups}
      pathname={pathname}
      medusaAdminUrl={MEDUSA_ADMIN_URL}
    />
  )
}
