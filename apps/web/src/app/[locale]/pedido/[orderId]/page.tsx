"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams } from "next/navigation"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { getApiBase } from "@/lib/api"
import { formatBRL } from '@/lib/format'
import { formatOrderId } from '@ibatexas/types'
import { OrderTimeline } from "@/components/molecules/OrderTimeline"
import { PaymentStatusBadge } from "@/components/molecules/PaymentStatusBadge"
import { PixCountdown } from "@/components/molecules/PixCountdown"
import { OrderActions } from "@/components/molecules/OrderActions"
import { OrderNotes } from "@/components/molecules/OrderNotes"
import { Flame } from "lucide-react"

interface OrderItem {
  id: string
  title: string
  quantity: number
  unit_price: number
  thumbnail?: string
  variant_id?: string
  productType?: 'food' | 'frozen' | 'merchandise'
}

interface CurrentPayment {
  id: string
  method: string
  status: string
  amountInCentavos: number
  pixExpiresAt?: string | null
}

interface OrderNote {
  id: string
  author: string
  authorId?: string | null
  content: string
  createdAt: string
}

interface Order {
  id: string
  status: string
  display_id: number
  total: number
  subtotal: number
  shipping_total: number
  delivery_type?: string | null
  payment_method?: string | null
  payment_status?: string | null
  tip_in_centavos?: number
  items: OrderItem[]
  created_at: string
  metadata?: Record<string, string>
  currentPayment?: CurrentPayment | null
  notes?: OrderNote[]
}

export default function OrderTrackingPage() {
  const t = useTranslations()
  const params = useParams<{ orderId: string }>()
  const orderId = params.orderId

  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const fetchOrder = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/cart/orders/${encodeURIComponent(orderId)}`, {
        credentials: "include",
      })
      if (res.status === 202) {
        setPending(true)
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string }
        throw new Error(data.message ?? "Pedido não encontrado.")
      }
      const data = await res.json() as { order: Order }
      setOrder(data.order)
      setPending(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar pedido.")
    } finally {
      setLoading(false)
    }
  }, [orderId])

  useEffect(() => { void fetchOrder() }, [fetchOrder])

  // Retry fetchOrder while pending (order not yet created after webhook)
  useEffect(() => {
    if (!pending) return
    const interval = setInterval(() => { void fetchOrder() }, 5_000)
    return () => clearInterval(interval)
  }, [pending, fetchOrder])

  // Poll for status updates every 15 seconds (stops on terminal status)
  useEffect(() => {
    if (!order || order.status === 'delivered' || order.status === 'canceled' || order.status === 'completed') return
    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/cart/orders/${encodeURIComponent(orderId)}/status`, {
          credentials: "include",
        })
        if (cancelled) return
        if (res.ok) {
          const data = await res.json() as { status: string; paymentStatus?: string; updatedAt: string | null }
          if (data.status) {
            setOrder((prev) => {
              if (!prev) return prev
              const changed = prev.status !== data.status || (data.paymentStatus && prev.currentPayment?.status !== data.paymentStatus)
              if (!changed) return prev
              return {
                ...prev,
                status: data.status,
                currentPayment: prev.currentPayment && data.paymentStatus
                  ? { ...prev.currentPayment, status: data.paymentStatus }
                  : prev.currentPayment,
              }
            })
          }
        }
      } catch {
        // Silently ignore polling errors
      }
    }, 15_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [order?.status, orderId])

  if (loading) {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center">
        <p className="text-smoke-400 text-sm">{t("order.loading")}</p>
      </div>
    )
  }

  if (pending) {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="w-10 h-10 border-3 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <h1 className="text-2xl font-display text-charcoal-900 mb-2">Aguardando pagamento</h1>
          <p className="text-smoke-400 text-sm mb-4">
            O pedido será confirmado automaticamente após o pagamento PIX ser processado.
          </p>
          <p className="text-xs text-smoke-300">Referência: {orderId}</p>
        </div>
      </div>
    )
  }

  if (error || !order) {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center px-4">
        <div className="text-center">
          <h1 className="text-2xl font-display text-charcoal-900 mb-2">{t("order.not_found")}</h1>
          <p className="text-smoke-400 text-sm mb-4">{error}</p>
          <Link href="/loja" className="text-brand-600 hover:underline">{t("order.back_to_store")}</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-smoke-50 py-16 lg:py-24 px-4">
      <div className="mx-auto max-w-lg space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Flame className="w-4 h-4 text-brand-500 flex-shrink-0" strokeWidth={1.5} />
          <div className="h-px flex-1 bg-smoke-200/60" />
        </div>
        <h1 className="text-3xl font-display text-charcoal-900">Pedido {formatOrderId(order.display_id)}</h1>

        {/* Order Timeline + Payment Status */}
        <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">Status</h2>
            {order.currentPayment && (
              <PaymentStatusBadge status={order.currentPayment.status} />
            )}
          </div>
          <OrderTimeline
            status={order.status}
            deliveryType={order.metadata?.deliveryType as "pickup" | "delivery" | "dine_in" | undefined}
          />

          {/* PIX countdown */}
          {order.currentPayment?.method === 'pix' &&
           order.currentPayment.status === 'payment_pending' &&
           order.currentPayment.pixExpiresAt && (
            <div className="mt-3 pt-3 border-t border-smoke-200">
              <PixCountdown
                expiresAt={order.currentPayment.pixExpiresAt}
                onExpired={fetchOrder}
              />
            </div>
          )}

          {/* Order actions — inline within the status card */}
          <OrderActions
            orderId={order.id}
            fulfillmentStatus={order.status}
            currentPayment={order.currentPayment ?? null}
            orderType={order.delivery_type ?? order.metadata?.deliveryType}
            items={order.items.map((i) => ({ id: i.id, title: i.title, quantity: i.quantity, variant_id: i.variant_id ?? i.id, unit_price: i.unit_price, productType: i.productType }))}
            onMutate={fetchOrder}
          />
        </div>

        {/* WhatsApp updates */}
        {process.env.NEXT_PUBLIC_WHATSAPP_URL && (
          <a
            href={`${process.env.NEXT_PUBLIC_WHATSAPP_URL}?text=${encodeURIComponent("Olá! Gostaria de acompanhar meu pedido #" + formatOrderId(order.display_id))}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 shadow-card border border-smoke-200/40 rounded-sm p-4 hover:shadow-card-hover transition-premium"
          >
            <div className="w-8 h-8 rounded-full bg-accent-green flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-white fill-current">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-charcoal-900">Acompanhe pelo WhatsApp</p>
              <p className="text-xs text-smoke-400">Receba atualizações automáticas sobre seu pedido.</p>
            </div>
          </a>
        )}

        {/* Order Details */}
        {(order.delivery_type || order.currentPayment?.method || order.payment_method || (order.tip_in_centavos ?? 0) > 0) && (
          <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-5 space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-3">Detalhes</h2>
            {order.delivery_type && (
              <div className="flex justify-between text-sm">
                <span className="text-smoke-400">Modalidade</span>
                <span className="text-charcoal-700">{order.delivery_type === 'delivery' ? 'Entrega' : order.delivery_type === 'pickup' ? 'Retirada' : 'No local'}</span>
              </div>
            )}
            {(order.currentPayment?.method ?? order.payment_method) && (
              <div className="flex justify-between text-sm">
                <span className="text-smoke-400">Pagamento</span>
                <span className="text-charcoal-700">{(order.currentPayment?.method ?? order.payment_method) === 'cash' ? 'Dinheiro' : (order.currentPayment?.method ?? order.payment_method) === 'pix' ? 'PIX' : 'Cartão'}</span>
              </div>
            )}
            {(order.tip_in_centavos ?? 0) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-smoke-400">Gorjeta</span>
                <span className="text-charcoal-700">{formatBRL(order.tip_in_centavos ?? 0)}</span>
              </div>
            )}
          </div>
        )}

        {/* Items */}
        <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-5 space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-3">Itens</h2>
          {order.items.map((item) => (
            <div key={item.id} className="flex items-center justify-between text-sm text-charcoal-700">
              <div className="flex items-center gap-3">
                {item.thumbnail && (
                  <Image src={item.thumbnail} alt={item.title} width={40} height={40} className="rounded-sm object-cover" />
                )}
                <span>{item.quantity}× {item.title}</span>
              </div>
              <span className="tabular-nums">{formatBRL(item.unit_price * item.quantity)}</span>
            </div>
          ))}
        </div>

        {/* Totals */}
        <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-5 space-y-2">
          <div className="flex justify-between text-sm text-smoke-400">
            <span>Subtotal</span><span>{formatBRL(order.subtotal)}</span>
          </div>
          {order.shipping_total > 0 && (
            <div className="flex justify-between text-sm text-smoke-400">
              <span>Entrega</span><span>{formatBRL(order.shipping_total)}</span>
            </div>
          )}
          <div className="border-t border-smoke-200 pt-4 flex justify-between items-baseline font-bold text-charcoal-900 font-display text-display-2xs">
            <span>Total</span><span className="tabular-nums">{formatBRL(order.total)}</span>
          </div>
        </div>

        {/* Notes */}
        <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-5">
          <OrderNotes
            orderId={order.id}
            notes={order.notes ?? []}
            canAdd={!['delivered', 'canceled', 'completed'].includes(order.status)}
            onMutate={fetchOrder}
          />
        </div>

        {order.status !== 'delivered' && order.status !== 'canceled' && (
          <p className="text-xs text-smoke-300 animate-pulse">
            Atualizando automaticamente...
          </p>
        )}
        <p className="text-xs text-smoke-400">
          Pedido realizado em {new Date(order.created_at).toLocaleString("pt-BR")}
        </p>

        {(order.status === 'delivered' || order.status === 'completed') && process.env.NEXT_PUBLIC_WHATSAPP_URL && (
          <a
            href={`${process.env.NEXT_PUBLIC_WHATSAPP_URL}?text=${encodeURIComponent("Quero repetir o pedido #" + formatOrderId(order.display_id))}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center rounded-sm border border-brand-500 bg-brand-500 text-white py-3 text-sm font-semibold hover:bg-brand-600 transition-colors"
          >
            Repetir pedido
          </a>
        )}

        <Link href="/search" className="block text-center text-sm text-brand-600 hover:underline">
          Continuar comprando →
        </Link>
      </div>
    </div>
  )
}
