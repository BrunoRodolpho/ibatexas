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

// WS5A — Information architecture retiered by the owner's axis: everyday ops
// (fast access) vs. attention-needed vs. analysis/support vs. config, instead of
// one flat 15-item "Operações" bucket. Item `key`s are preserved so the badge
// mapping (incidentes/aprovacoes/agentes) and active-route highlighting keep
// working; role gates (minRole) are unchanged. Role filtering + the tablet/mobile
// collapse behavior are handled downstream (WS2 + AdminSidebarBase).
const baseGroups: AdminSidebarNavGroup[] = [
  {
    label: 'Operação diária',
    items: [
      { key: 'dashboard', label: 'Visão Geral', href: '/admin', icon: LayoutDashboard },
      { key: 'pedidos', label: 'Pedidos', href: '/admin/pedidos', icon: ClipboardList },
      { key: 'reservas', label: 'Reservas', href: '/admin/reservas', icon: CalendarDays },
      { key: 'painel-operacional', label: 'Painel Operacional', href: '/admin/painel-operacional', icon: Gauge },
      { key: 'cardapio', label: 'Cardápio', href: '/admin/cardapio', icon: UtensilsCrossed },
      { key: 'loja', label: 'Loja', href: '/admin/loja', icon: ShoppingBag },
    ],
  },
  {
    label: 'Precisa de atenção',
    items: [
      { key: 'incidentes', label: INCIDENT_LABELS.nav, href: '/admin/incidentes', icon: AlertTriangle },
      { key: 'aprovacoes', label: 'Aprovações', href: '/admin/aprovacoes', icon: ShieldCheck, minRole: 'MANAGER' },
      { key: 'escalacoes', label: 'Escalações', href: '/admin/escalacoes', icon: ArrowUpCircle },
      { key: 'alertas-operacionais', label: 'Alertas Operacionais', href: '/admin/alertas-operacionais', icon: Siren },
      { key: 'agentes', label: 'Agentes', href: '/admin/agentes', icon: Power, minRole: 'MANAGER' },
    ],
  },
  {
    label: 'Análise & suporte',
    items: [
      { key: 'avaliacoes', label: 'Avaliações', href: '/admin/avaliacoes', icon: Star },
      { key: 'conversas', label: 'Conversas', href: '/admin/conversas', icon: MessagesSquare, minRole: 'MANAGER' },
      { key: 'canal-operacional', label: 'Canal Operacional', href: '/admin/canal-operacional', icon: BotMessageSquare, minRole: 'MANAGER' },
      { key: 'clientes', label: 'Clientes', href: '/admin/clientes', icon: Users, minRole: 'MANAGER' },
    ],
  },
  {
    label: 'Configurações',
    items: [
      { key: 'horarios', label: 'Horários', href: '/admin/horarios', icon: Clock },
      { key: 'zonas', label: 'Zonas de Entrega', href: '/admin/zonas', icon: MapPin },
      { key: 'banner', label: 'Banner', href: '/admin/banner', icon: Type },
      { key: 'funcionarios', label: 'Funcionários', href: '/admin/funcionarios', icon: UserCog, minRole: 'OWNER' },
    ],
  },
  {
    label: 'Marketing',
    items: [
      { key: 'broadcast', label: 'Broadcast', href: '/admin/broadcast', icon: Megaphone },
    ],
  },
]

type StaffRole = 'OWNER' | 'MANAGER' | 'ATTENDANT'

const ROLE_RANK: Record<StaffRole, number> = { OWNER: 3, MANAGER: 2, ATTENDANT: 1 }

/** Whether a role may SEE a nav item. No minRole → everyone; unknown role →
 *  hide gated entries (fail-safe: never flash an owner-only link to a lower role). */
function canSee(minRole: StaffRole | undefined, staffRole: StaffRole | null): boolean {
  if (!minRole) return true
  if (!staffRole) return false
  return ROLE_RANK[staffRole] >= ROLE_RANK[minRole]
}

export function AdminSidebar({ staffRole = null }: { staffRole?: StaffRole | null }) {
  const pathname = usePathname()
  const openIncidentCount = useOpenIncidentCount()
  const pendingApprovalCount = useAgentApprovalPendingCount()
  const killedAgentCount = useAgentKilledCount()

  const groups = useMemo<AdminSidebarNavGroup[]>(
    () =>
      baseGroups
        .map((group) => ({
          ...group,
          items: group.items
            .filter((item) => canSee(item.minRole, staffRole))
            .map((item) => {
              if (item.key === 'incidentes') return { ...item, count: openIncidentCount }
              if (item.key === 'aprovacoes') return { ...item, count: pendingApprovalCount }
              if (item.key === 'agentes') return { ...item, count: killedAgentCount }
              return item
            }),
        }))
        // Drop a group that role-filtering emptied (keeps its header from showing).
        .filter((group) => group.items.length > 0),
    [openIncidentCount, pendingApprovalCount, killedAgentCount, staffRole],
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
