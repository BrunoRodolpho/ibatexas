"use client"

import { useEffect, useState, useMemo } from "react"
import { Link } from '@/i18n/navigation'
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { useSessionStore } from '@/domains/session'
import { Heading, Text, Button } from "@/components/atoms"
import { Package } from "lucide-react"
import { apiFetch } from '@/lib/api'
import { PaymentStatusBadge } from '@/components/molecules/PaymentStatusBadge'
import { mapMedusaOrderToSummary, formatOrderId, type MedusaOrderRaw, type OrderSummary } from '@ibatexas/types'

interface CurrentPaymentSummary {
  id: string
  method: string
  status: string
}

interface PendingOrder extends MedusaOrderRaw {
  _pending?: boolean
  currentPayment?: CurrentPaymentSummary | null
}

interface OrderHistoryResponse {
  orders?: PendingOrder[]
  count?: number
}

/** Extended order summary that carries currentPayment from projection */
interface OrderSummaryWithPayment extends OrderSummary {
  currentPayment?: CurrentPaymentSummary | null
}

function formatCentavos(total: number): string {
  return `R$ ${(total / 100).toFixed(2).replace('.', ',')}`
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

type OrderFilter = 'all' | 'active' | 'completed' | 'canceled'

const TERMINAL_STATUSES = ['delivered', 'canceled', 'completed']
const ACTIVE_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'in_delivery']

function getFulfillmentBadgeStyle(status: string): string {
  switch (status) {
    case 'canceled':
      return 'bg-accent-red/10 text-accent-red'
    case 'delivered':
    case 'completed':
      return 'bg-accent-green/10 text-accent-green'
    case 'preparing':
    case 'ready':
    case 'in_delivery':
      return 'bg-brand-50 text-brand-600'
    default:
      return 'bg-smoke-100 text-smoke-500'
  }
}

function FulfillmentBadge({ status, t }: { readonly status: string; readonly t: ReturnType<typeof useTranslations<'order'>> }) {
  const key = `fulfillment_${status}` as Parameters<typeof t>[0]
  const label = t.has(key) ? t(key) : status
  return (
    <span className={`inline-block text-micro font-semibold uppercase tracking-editorial px-2 py-0.5 rounded-sm ${getFulfillmentBadgeStyle(status)}`}>
      {label}
    </span>
  )
}

function PendingOrderCard({ order, t }: { readonly order: OrderSummaryWithPayment; readonly t: ReturnType<typeof useTranslations<'order'>> }) {
  return (
    <div className="rounded-sm border border-brand-200 bg-brand-50/30 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-micro font-semibold uppercase tracking-editorial text-brand-500">
            Aguardando pagamento
          </div>
          <div className="mt-1 text-sm text-charcoal-700">
            {formatDate(order.createdAt)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {order.currentPayment ? (
            <PaymentStatusBadge status={order.currentPayment.status} />
          ) : (
            <>
              <div className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" />
              <span className="text-xs uppercase tracking-wide text-brand-500">Pendente</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function OrderCard({ order, t }: { readonly order: OrderSummaryWithPayment; readonly t: ReturnType<typeof useTranslations<'order'>> }) {
  const fulfillment = order.fulfillmentStatus ?? order.status ?? 'pending'
  const isCanceled = fulfillment === 'canceled'

  return (
    <div className={`rounded-sm border p-5 ${isCanceled ? 'border-smoke-200 bg-smoke-50/60 opacity-75' : 'border-smoke-200 bg-smoke-50'}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
            Pedido {formatOrderId(order.displayId ?? 0)}
          </div>
          <div className="mt-1 text-sm text-charcoal-900">
            {formatDate(order.createdAt)} · {order.itemCount} {order.itemCount === 1 ? 'item' : 'itens'}
          </div>
        </div>
        <div className="text-right space-y-1.5">
          <div className={`text-base font-semibold ${isCanceled ? 'text-smoke-400 line-through' : 'text-charcoal-900'}`}>
            {formatCentavos(order.total)}
          </div>
          <FulfillmentBadge status={fulfillment} t={t} />
        </div>
      </div>
    </div>
  )
}

export default function AccountOrdersPage() {
  const t = useTranslations()
  const router = useRouter()
  const { customerId } = useSessionStore()

  const [orders, setOrders] = useState<OrderSummaryWithPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<OrderFilter>('all')

  const to = useTranslations('order')

  const filteredOrders = useMemo(() => {
    if (filter === 'all') return orders
    return orders.filter((o) => {
      const fs = o.fulfillmentStatus ?? o.status ?? 'pending'
      if (filter === 'active') return ACTIVE_STATUSES.includes(fs)
      if (filter === 'completed') return fs === 'delivered' || fs === 'completed'
      if (filter === 'canceled') return fs === 'canceled'
      return true
    })
  }, [orders, filter])

  const counts = useMemo(() => ({
    all: orders.length,
    active: orders.filter(o => ACTIVE_STATUSES.includes(o.fulfillmentStatus ?? o.status ?? 'pending')).length,
    completed: orders.filter(o => ['delivered', 'completed'].includes(o.fulfillmentStatus ?? o.status ?? '')).length,
    canceled: orders.filter(o => (o.fulfillmentStatus ?? o.status) === 'canceled').length,
  }), [orders])

  const fetchOrders = async (signal?: { cancelled: boolean }) => {
    try {
      const data = await apiFetch<OrderHistoryResponse>('/api/customer/orders')
      if (signal?.cancelled) return
      const raw = data?.orders ?? []
      // Separate pending (no Medusa order yet) from completed
      const pending = raw.filter((o) => o._pending)
      const completed = raw.filter((o) => !o._pending)
      const mapWithPayment = (o: PendingOrder): OrderSummaryWithPayment => ({
        ...mapMedusaOrderToSummary(o),
        currentPayment: o.currentPayment ?? null,
      })
      setOrders([
        ...pending.map(mapWithPayment),
        ...completed.map(mapWithPayment),
      ])
    } catch (err) {
      if (signal?.cancelled) return
      setError(err instanceof Error ? err.message : 'Erro ao carregar pedidos.')
    } finally {
      if (!signal?.cancelled) setLoading(false)
    }
  }

  useEffect(() => {
    if (!customerId) {
      setLoading(false)
      return
    }
    const signal = { cancelled: false }
    fetchOrders(signal)
    return () => { signal.cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  useEffect(() => {
    const TERMINAL = ['delivered', 'canceled', 'completed']
    const hasPending = orders.some(
      (o) => !TERMINAL.includes(o.fulfillmentStatus || o.status)
    )
    if (!hasPending) return
    const interval = setInterval(() => { fetchOrders() }, 15_000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders])

  if (!customerId) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <div className="bg-smoke-100 warm-glow rounded-sm p-10 text-center">
          <div className="flex justify-center mb-6">
            <div className="w-14 h-14 rounded-full bg-smoke-50 flex items-center justify-center shadow-sm">
              <Package className="w-6 h-6 text-charcoal-900" strokeWidth={1.5} />
            </div>
          </div>
          <Heading as="h1" variant="h2" className="text-charcoal-900 mb-3">
            {t("account.orders")}
          </Heading>
          <Text textColor="muted" className="mb-6">
            {t("account.login_required")}
          </Text>
          <Button
            variant="brand"
            onClick={() => router.push('/entrar?next=/account/orders')}
            className="w-full"
            size="lg"
          >
            {t("checkout.login_button")}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/account"
          className="text-sm text-smoke-400 hover:text-charcoal-900 transition-colors duration-300"
        >
          ← {t("account.title")}
        </Link>
        <Heading as="h1" variant="h1" className="text-charcoal-900 mt-2">
          {t("account.orders")}
        </Heading>
        <Text textColor="muted" className="mt-1">
          {t("account.orders_description")}
        </Text>
      </div>

      {/* Filter tabs */}
      {!loading && !error && orders.length > 0 && (
        <div className="flex gap-1 mb-6 overflow-x-auto pb-1">
          {(['all', 'active', 'completed', 'canceled'] as const).map((f) => {
            const isActive = filter === f
            const count = counts[f]
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-xs font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-charcoal-900 text-white'
                    : 'bg-smoke-100 text-smoke-500 hover:bg-smoke-200 hover:text-charcoal-700'
                }`}
              >
                {to(`filter_${f}` as Parameters<typeof to>[0])}
                {count > 0 && (
                  <span className={`text-micro px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white/20' : 'bg-smoke-200'}`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {loading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded-sm bg-smoke-100 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="rounded-sm border border-accent-red/20 bg-accent-red/10 p-4 text-sm text-accent-red">
          {error}
        </div>
      )}

      {!loading && !error && orders.length === 0 && (
        <div className="rounded-sm border border-smoke-200 bg-smoke-50 p-10 text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-smoke-100 flex items-center justify-center">
              <Package className="w-5 h-5 text-smoke-400" strokeWidth={1.5} />
            </div>
          </div>
          <Text textColor="muted" className="mb-6">
            {t("account.no_orders")}
          </Text>
          <Link href="/search">
            <Button variant="brand" size="lg">
              {t("cart.continue_shopping")} →
            </Button>
          </Link>
        </div>
      )}

      {!loading && !error && orders.length > 0 && filteredOrders.length === 0 && (
        <div className="rounded-sm border border-smoke-200 bg-smoke-50 p-8 text-center">
          <Text textColor="muted" className="text-sm">
            Nenhum pedido nesta categoria.
          </Text>
        </div>
      )}

      {!loading && !error && filteredOrders.length > 0 && (
        <div className="space-y-3">
          {filteredOrders.map((order) => (
            <Link
              key={order.id}
              href={`/pedido/${order.id}`}
              className="block transition-colors duration-200 rounded-sm hover:ring-1 hover:ring-brand-200"
            >
              {order.status === 'pending' && !order.displayId
                ? <PendingOrderCard order={order} t={to} />
                : <OrderCard order={order} t={to} />}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
