'use client'

// WS5B — consolidated "Visão Geral" landing. Dashboard KPIs (all staff) +
// Análises (manager+) as role-scoped collapsible sections, with a quick link to
// the live-poll Painel Operacional. Section gating uses the client role (WS2);
// the server guards remain the authorization boundary.

import { Suspense, useCallback, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronRight, Gauge } from 'lucide-react'
import { MEDUSA_ADMIN_URL, apiFetch } from '@/lib/api'
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

interface TopItem {
  productId: string
  title: string
  quantity: number
  orderCount: number
}

/**
 * WS5C — "Relatórios": the dormant manager-gated report endpoints, wired at last.
 * LAZY — best-sellers (top-items) are fetched only on first expand (never on the
 * landing's initial load), keeping the page light. Refunds/margins reuse the
 * same pattern and can be added as sibling tabs.
 */
function RelatoriosSection(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<TopItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = (await apiFetch('/api/admin/analytics/top-items?limit=10')) as { items: TopItem[] }
      setItems(data.items ?? [])
    } catch {
      // A 403/500/network failure is NOT "no sales" — never render the empty
      // "Nenhum dado no período." on a broken call. Keep items null so a
      // re-expand retries, and surface a distinct, retryable error.
      setItems(null)
      setError('Não foi possível carregar o relatório. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && items === null) void load()
  }

  return (
    <section className="border-b border-smoke-200">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-charcoal-800 hover:bg-smoke-50"
      >
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        Relatórios · Mais vendidos (30 dias)
      </button>
      {open ? (
        <div className="px-4 pb-4">
          {loading ? (
            <p className="text-sm text-smoke-500">Carregando…</p>
          ) : error ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-red-600">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100"
              >
                Tentar novamente
              </button>
            </div>
          ) : items && items.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-smoke-500">
                  <th className="py-1">Produto</th>
                  <th className="py-1 text-right">Qtd</th>
                  <th className="py-1 text-right">Pedidos</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.productId} className="border-t border-smoke-100">
                    <td className="py-1.5">{it.title}</td>
                    <td className="py-1.5 text-right tabular-nums">{it.quantity}</td>
                    <td className="py-1.5 text-right tabular-nums">{it.orderCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-smoke-500">Nenhum dado no período.</p>
          )}
        </div>
      ) : null}
    </section>
  )
}

function VisaoGeralContent(): React.JSX.Element {
  const router = useRouter()
  const searchParams = useSearchParams()
  // S14 — a deep link to /admin/analises redirects here with ?section=analises;
  // open the Análises section on arrival so the analytics land visible.
  const analisesDeepLink = searchParams.get('section') === 'analises'
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
        <Section title="Análises" defaultOpen={analisesDeepLink}>
          <AdminAnalisesPage metrics={analytics} loading={analyticsLoading} />
        </Section>
      ) : null}

      {isManager ? <RelatoriosSection /> : null}

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

export default function VisaoGeral(): React.JSX.Element {
  // useSearchParams() requires a Suspense boundary (Next App Router).
  return (
    <Suspense fallback={null}>
      <VisaoGeralContent />
    </Suspense>
  )
}
