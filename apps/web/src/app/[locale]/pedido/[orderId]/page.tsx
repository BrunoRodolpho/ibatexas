"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Image from "next/image"
import { Link } from "@/i18n/navigation"
import { getApiBase } from "@/lib/api"

function formatPrice(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Aguardando pagamento",
  processing: "Preparando",
  shipped: "Em entrega",
  delivered: "Entregue",
  canceled: "Cancelado",
  requires_action: "Ação necessária",
}

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

  const statusLabel = STATUS_LABELS[order.status] ?? order.status

  return (
    <div className="min-h-screen bg-smoke-50 py-8 px-4">
      <div className="mx-auto max-w-lg space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-display text-charcoal-900">Pedido #{order.display_id}</h1>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${order.status === "delivered" ? "bg-green-100 text-green-700" : order.status === "canceled" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
            {statusLabel}
          </span>
        </div>

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
              <span>{formatPrice(item.unit_price * item.quantity)}</span>
            </div>
          ))}
        </div>

        {/* Totals */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-2">
          <div className="flex justify-between text-sm text-smoke-400">
            <span>Subtotal</span><span>{formatPrice(order.subtotal)}</span>
          </div>
          {order.shipping_total > 0 && (
            <div className="flex justify-between text-sm text-smoke-400">
              <span>Entrega</span><span>{formatPrice(order.shipping_total)}</span>
            </div>
          )}
          <div className="border-t border-smoke-200 pt-2 flex justify-between font-bold text-charcoal-900">
            <span>Total</span><span>{formatPrice(order.total)}</span>
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
