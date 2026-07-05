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
  ArrowUpCircle,
  MessagesSquare,
  Megaphone,
  Siren,
  Gauge,
  BotMessageSquare,
  Users,
  UserCog,
  ShieldCheck,
  Power,
} from 'lucide-react'
import { AdminSidebarBase, INCIDENT_LABELS, type AdminSidebarNavGroup } from '@ibatexas/ui'
import {
  useOpenIncidentCount,
  useAgentApprovalPendingCount,
  useAgentKilledCount,
} from '@/domains/admin/admin.hooks'

const baseGroups: AdminSidebarNavGroup[] = [
  {
    label: 'Principal',
    items: [
      { key: 'dashboard', label: 'Dashboard', href: '/admin', icon: LayoutDashboard },
      { key: 'cardapio', label: 'Cardápio', href: '/admin/cardapio', icon: UtensilsCrossed },
      { key: 'loja', label: 'Loja', href: '/admin/loja', icon: ShoppingBag },
      { key: 'clientes', label: 'Clientes', href: '/admin/clientes', icon: Users },
      { key: 'funcionarios', label: 'Funcionários', href: '/admin/funcionarios', icon: UserCog },
    ],
  },
  {
    label: 'Operações',
    items: [
      { key: 'painel-operacional', label: 'Painel Operacional', href: '/admin/painel-operacional', icon: Gauge },
      { key: 'canal-operacional', label: 'Canal Operacional', href: '/admin/canal-operacional', icon: BotMessageSquare },
      { key: 'pedidos', label: 'Pedidos', href: '/admin/pedidos', icon: ClipboardList },
      { key: 'reservas', label: 'Reservas', href: '/admin/reservas', icon: CalendarDays },
      { key: 'incidentes', label: INCIDENT_LABELS.nav, href: '/admin/incidentes', icon: AlertTriangle },
      { key: 'aprovacoes', label: 'Aprovações', href: '/admin/aprovacoes', icon: ShieldCheck },
      { key: 'agentes', label: 'Agentes', href: '/admin/agentes', icon: Power },
      { key: 'alertas-operacionais', label: 'Alertas Operacionais', href: '/admin/alertas-operacionais', icon: Siren },
      { key: 'escalacoes', label: 'Escalações', href: '/admin/escalacoes', icon: ArrowUpCircle },
      { key: 'conversas', label: 'Conversas', href: '/admin/conversas', icon: MessagesSquare },
      { key: 'horarios', label: 'Horários', href: '/admin/horarios', icon: Clock },
      { key: 'zonas', label: 'Zonas de Entrega', href: '/admin/zonas', icon: MapPin },
      { key: 'avaliacoes', label: 'Avaliações', href: '/admin/avaliacoes', icon: Star },
      { key: 'analises', label: 'Análises', href: '/admin/analises', icon: BarChart2 },
      { key: 'banner', label: 'Banner', href: '/admin/banner', icon: Type },
    ],
  },
  {
    label: 'Marketing',
    items: [
      { key: 'broadcast', label: 'Broadcast', href: '/admin/broadcast', icon: Megaphone },
    ],
  },
]

export function AdminSidebar() {
  const pathname = usePathname()
  const openIncidentCount = useOpenIncidentCount()
  const pendingApprovalCount = useAgentApprovalPendingCount()
  const killedAgentCount = useAgentKilledCount()

  const groups = useMemo<AdminSidebarNavGroup[]>(
    () =>
      baseGroups.map((group) => ({
        ...group,
        items: group.items.map((item) => {
          if (item.key === 'incidentes') return { ...item, count: openIncidentCount }
          if (item.key === 'aprovacoes') return { ...item, count: pendingApprovalCount }
          if (item.key === 'agentes') return { ...item, count: killedAgentCount }
          return item
        }),
      })),
    [openIncidentCount, pendingApprovalCount, killedAgentCount],
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
