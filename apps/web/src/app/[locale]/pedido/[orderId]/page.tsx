"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Image from "next/image"
import { Link } from "@/i18n/navigation"
import { getApiBase } from "@/lib/api"
import { formatBRL } from '@/lib/format'
import { OrderTimeline } from "@/components/molecules/OrderTimeline"

interface OrderItem {
  id: string
  title: string
  quantity: number
  unit_price: number
  thumbnail?: string
}

interface Order {
  id: string
  status: string
  display_id: number
  total: number
  subtotal: number
  shipping_total: number
  items: OrderItem[]
  created_at: string
}

export default function OrderTrackingPage() {
  const params = useParams<{ orderId: string }>()
  const orderId = params.orderId

  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchOrder() {
      try {
        const res = await fetch(`${getApiBase()}/api/cart/orders/${encodeURIComponent(orderId)}`, {
          credentials: "include",
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { message?: string }
          throw new Error(data.message ?? "Pedido não encontrado.")
        }
        const data = await res.json() as { order: Order }
        setOrder(data.order)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro ao carregar pedido.")
      } finally {
        setLoading(false)
      }
    }
    void fetchOrder()
  }, [orderId])

  if (loading) {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center">
        <p className="text-smoke-400 text-sm">Carregando pedido…</p>
      </div>
    )
  }

  if (error || !order) {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center px-4">
        <div className="text-center">
          <h1 className="text-2xl font-display text-charcoal-900 mb-2">Pedido não encontrado</h1>
          <p className="text-smoke-400 text-sm mb-4">{error}</p>
          <Link href="/loja" className="text-brand-600 hover:underline">Voltar à loja →</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-smoke-50 py-16 lg:py-24 px-4">
      <div className="mx-auto max-w-lg space-y-6">
        <h1 className="text-3xl font-display text-charcoal-900">Pedido #{order.display_id}</h1>

        {/* Order Timeline */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-4">Status</h2>
          <OrderTimeline status={order.status} />
        </div>

        {/* WhatsApp updates */}
        {process.env.NEXT_PUBLIC_WHATSAPP_URL && (
          <a
            href={`${process.env.NEXT_PUBLIC_WHATSAPP_URL}?text=${encodeURIComponent("Olá! Gostaria de acompanhar meu pedido #" + String(order.display_id))}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-smoke-200 rounded-sm p-4 hover:border-accent-green/40 transition-colors"
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

        {/* Items */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-3">Itens</h2>
          {order.items.map((item) => (
            <div key={item.id} className="flex items-center justify-between text-sm text-charcoal-700">
              <div className="flex items-center gap-3">
                {item.thumbnail && (
                  <Image src={item.thumbnail} alt={item.title} width={40} height={40} className="rounded-sm object-cover" />
                )}
                <span>{item.quantity}× {item.title}</span>
              </div>
              <span>{formatBRL(item.unit_price * item.quantity)}</span>
            </div>
          ))}
        </div>

        {/* Totals */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-2">
          <div className="flex justify-between text-sm text-smoke-400">
            <span>Subtotal</span><span>{formatBRL(order.subtotal)}</span>
          </div>
          {order.shipping_total > 0 && (
            <div className="flex justify-between text-sm text-smoke-400">
              <span>Entrega</span><span>{formatBRL(order.shipping_total)}</span>
            </div>
          )}
          <div className="border-t border-smoke-200 pt-2 flex justify-between font-bold text-charcoal-900">
            <span>Total</span><span>{formatBRL(order.total)}</span>
          </div>
        </div>

        <p className="text-xs text-smoke-400">
          Pedido realizado em {new Date(order.created_at).toLocaleString("pt-BR")}
        </p>

        <Link href="/loja" className="block text-center text-sm text-brand-600 hover:underline">
          Continuar comprando →
        </Link>
      </div>
    </div>
  )
}
