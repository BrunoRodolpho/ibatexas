'use client'

// WS5B — consolidated "Visão Geral" landing. Dashboard KPIs (all staff) +
// Análises (manager+) as role-scoped collapsible sections, with a quick link to
// the live-poll Painel Operacional. Section gating uses the client role (WS2);
// the server guards remain the authorization boundary.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, Gauge } from 'lucide-react'
import { MEDUSA_ADMIN_URL } from '@/lib/api'
import {
  useAdminDashboard,
  useAdminOrders,
  useAdminAnalytics,
  useStaffRole,
} from '@/domains/admin/admin.hooks'
import { AdminDashboardPage, AdminAnalisesPage } from '@ibatexas/ui'

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  readonly title: string
  readonly defaultOpen?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-smoke-200">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-charcoal-800 hover:bg-smoke-50"
      >
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        {title}
      </button>
      {open ? <div className="pb-4">{children}</div> : null}
    </section>
  )
}

export default function VisaoGeral(): React.JSX.Element {
  const router = useRouter()
  const role = useStaffRole()
  const isManager = role === 'MANAGER' || role === 'OWNER'
  const { data: metrics, loading: metricsLoading } = useAdminDashboard()
  const { data: orders, loading: ordersLoading } = useAdminOrders({ limit: 10 })
  const { metrics: analytics, loading: analyticsLoading } = useAdminAnalytics()

  return (
    <div className="flex flex-col">
      <Section title="Hoje">
        <AdminDashboardPage
          metrics={metrics}
          metricsLoading={metricsLoading}
          orders={orders}
          ordersLoading={ordersLoading}
          medusaAdminUrl={MEDUSA_ADMIN_URL}
          onOrderClick={() => router.push('/admin/pedidos')}
        />
      </Section>

      {isManager ? (
        <Section title="Análises" defaultOpen={false}>
          <AdminAnalisesPage metrics={analytics} loading={analyticsLoading} />
        </Section>
      ) : null}

      {isManager ? (
        <div className="px-4 py-3">
          <Link
            href="/admin/painel-operacional"
            className="inline-flex items-center gap-1.5 text-sm text-blue-700 underline"
          >
            <Gauge className="h-3.5 w-3.5" aria-hidden /> Abrir Painel Operacional (tempo real) →
          </Link>
        </div>
      ) : null}
    </div>
  )
}
