'use client'

import { useEffect, useRef } from 'react'
import { X, Clock } from 'lucide-react'
import { Badge } from '../atoms/Badge'
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, ACTION_LABELS } from '../constants/admin-labels'
import { getNextStatus, formatOrderId, ORDER_STATUS_LABELS_PT, type OrderFulfillmentStatus } from '@ibatexas/types'

function formatBRL(centavos: number) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  const map: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
    completed: 'success',
    delivered: 'success',
    confirmed: 'success',
    pending: 'warning',
    preparing: 'warning',
    ready: 'warning',
    canceled: 'danger',
  }
  return map[status] ?? 'default'
}

function paymentVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  const map: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
    paid: 'success',
    awaiting_payment: 'warning',
    payment_pending: 'warning',
    cash_pending: 'warning',
    switching_method: 'warning',
    payment_expired: 'danger',
    payment_failed: 'danger',
    canceled: 'danger',
  }
  return map[status] ?? 'default'
}

const ADVANCE_LABELS: Record<string, string> = {
  confirmed: ACTION_LABELS.confirmOrder,
  preparing: ACTION_LABELS.startPreparing,
  ready: ACTION_LABELS.markReady,
  in_delivery: ACTION_LABELS.sendDelivery,
  delivered: ACTION_LABELS.markDelivered,
}

const ACTOR_LABELS: Record<string, string> = {
  admin: 'Admin',
  system: 'Sistema',
  system_backfill: 'Migração',
  customer: 'Cliente',
}

export interface StatusHistoryEntry {
  id: string
  fromStatus: string
  toStatus: string
  actor: string
  actorId?: string | null
  reason?: string | null
  createdAt: string
}

export interface AdminOrderDetail {
  id: string
  display_id: number
  email?: string
  total: number
  subtotal: number
  shipping_total: number
  status: string
  payment_status: string
  fulfillment_status: string
  delivery_type?: string | null
  payment_method?: string | null
  tip_in_centavos?: number
  created_at: string
  version?: number
  currentPayment?: {
    id: string
    method: string
    status: string
    amountInCentavos: number
    pixExpiresAt?: string | null
    version?: number
  } | null
  statusHistory?: StatusHistoryEntry[]
  items?: Array<{
    id: string
    title: string
    quantity: number
    unit_price: number
    thumbnail?: string
  }>
  customer?: {
    id: string
    first_name?: string
    last_name?: string
    email?: string
    phone?: string
  }
  shipping_address?: {
    address_1?: string
    city?: string
    postal_code?: string
  }
}

export interface AdminOrderDetailDrawerProps {
  readonly order: AdminOrderDetail | null
  readonly open: boolean
  readonly onClose: () => void
  readonly onAdvanceStatus: (orderId: string, newStatus: string, version?: number) => void
  onAction?: (orderId: string, action: string, body?: Record<string, unknown>) => Promise<void>
  paymentHistory?: Array<{
    id: string
    method: string
    status: string
    amountInCentavos: number
    createdAt: string
    version: number
  }>
}

export function AdminOrderDetailDrawer({
  order,
  open,
  onClose,
  onAdvanceStatus,
  onAction,
  paymentHistory,
}: AdminOrderDetailDrawerProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open || !order) return null

  const fulfillmentStatus = order.fulfillment_status ?? order.status
  const next = getNextStatus(fulfillmentStatus as OrderFulfillmentStatus)

  return (
    <>
      {/* Overlay */}
      <div
        ref={overlayRef}
        className="fixed inset-0 z-40 bg-charcoal-900/30 transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-smoke-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-charcoal-900">
            Pedido {formatOrderId(order.display_id)}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-sm text-smoke-400 hover:text-charcoal-900 hover:bg-smoke-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Status + Advance */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-smoke-400">Status</span>
              <Badge variant={statusVariant(fulfillmentStatus)}>
                {ORDER_STATUS_LABELS[fulfillmentStatus] ?? fulfillmentStatus}
              </Badge>
            </div>
            {next && fulfillmentStatus !== 'canceled' && (
              <button
                onClick={() => onAdvanceStatus(order.id, next, order.version)}
                className="rounded-sm bg-brand-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                {ADVANCE_LABELS[next] ?? ACTION_LABELS.advanceStatus}
              </button>
            )}
          </div>

          {/* Payment Status */}
          {order.currentPayment && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-smoke-400">Pagamento</span>
                <Badge variant={paymentVariant(order.currentPayment.status)}>
                  {PAYMENT_STATUS_LABELS[order.currentPayment.status] ?? order.currentPayment.status}
                </Badge>
              </div>
              <span className="text-xs text-smoke-400">
                {order.currentPayment.method === 'pix' ? 'PIX' : order.currentPayment.method === 'card' ? 'Cartão' : 'Dinheiro'}
              </span>
            </div>
          )}

          {/* Customer */}
          {order.customer && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-smoke-400 mb-2">Cliente</h3>
              <div className="text-sm text-charcoal-700 space-y-1">
                {(order.customer.first_name || order.customer.last_name) && (
                  <p>{[order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ')}</p>
                )}
                {order.customer.email && <p>{order.customer.email}</p>}
                {order.customer.phone && <p>{order.customer.phone}</p>}
              </div>
            </div>
          )}

          {/* Items */}
          {order.items && order.items.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-smoke-400 mb-2">
                Itens ({order.items.length})
              </h3>
              <div className="space-y-2">
                {order.items.map((item) => (
                  <div key={item.id} className="flex items-center justify-between text-sm text-charcoal-700">
                    <span>{item.quantity}× {item.title}</span>
                    <span className="text-charcoal-900 font-medium">{formatBRL(item.unit_price * item.quantity)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Order Details (delivery, payment, tip) */}
          {(order.delivery_type || order.payment_method || (order.tip_in_centavos ?? 0) > 0) && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-smoke-400 mb-2">Detalhes</h3>
              <div className="text-sm text-charcoal-700 space-y-1">
                {order.delivery_type && (
                  <div className="flex justify-between">
                    <span className="text-smoke-400">Modalidade</span>
                    <span>{order.delivery_type === 'delivery' ? 'Entrega' : order.delivery_type === 'pickup' ? 'Retirada' : 'No local'}</span>
                  </div>
                )}
                {order.payment_method && (
                  <div className="flex justify-between">
                    <span className="text-smoke-400">Pagamento</span>
                    <span>{order.payment_method === 'cash' ? 'Dinheiro' : order.payment_method === 'pix' ? 'PIX' : 'Cartão'}</span>
                  </div>
                )}
                {(order.tip_in_centavos ?? 0) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-smoke-400">Gorjeta</span>
                    <span>{formatBRL(order.tip_in_centavos!)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Totals */}
          <div className="border-t border-smoke-200 pt-4 space-y-2">
            <div className="flex justify-between text-sm text-smoke-400">
              <span>Subtotal</span>
              <span>{formatBRL(order.subtotal)}</span>
            </div>
            {order.shipping_total > 0 && (
              <div className="flex justify-between text-sm text-smoke-400">
                <span>Entrega</span>
                <span>{formatBRL(order.shipping_total)}</span>
              </div>
            )}
            {(order.tip_in_centavos ?? 0) > 0 && (
              <div className="flex justify-between text-sm text-smoke-400">
                <span>Gorjeta</span>
                <span>{formatBRL(order.tip_in_centavos!)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-bold text-charcoal-900">
              <span>Total</span>
              <span>{formatBRL(order.total)}</span>
            </div>
          </div>

          {/* Shipping address */}
          {order.shipping_address && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-smoke-400 mb-2">Endereço</h3>
              <p className="text-sm text-charcoal-700">
                {[order.shipping_address.address_1, order.shipping_address.city, order.shipping_address.postal_code]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            </div>
          )}

          {/* Status History (Audit Trail) */}
          {order.statusHistory && order.statusHistory.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-smoke-400 mb-3">Historico</h3>
              <div className="space-y-3">
                {order.statusHistory
                  .filter((h) => h.fromStatus !== h.toStatus) // skip initial snapshot entry
                  .map((entry) => (
                    <div key={entry.id} className="flex items-start gap-2 text-sm">
                      <Clock className="w-3.5 h-3.5 mt-0.5 text-smoke-400 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-charcoal-700">
                          <span className="text-smoke-500">
                            {ORDER_STATUS_LABELS_PT[entry.fromStatus as OrderFulfillmentStatus] ?? entry.fromStatus}
                          </span>
                          {' → '}
                          <span className="font-medium text-charcoal-900">
                            {ORDER_STATUS_LABELS_PT[entry.toStatus as OrderFulfillmentStatus] ?? entry.toStatus}
                          </span>
                        </div>
                        <div className="text-xs text-smoke-400 mt-0.5">
                          {new Date(entry.createdAt).toLocaleString('pt-BR')}
                          {' · '}
                          {ACTOR_LABELS[entry.actor] ?? entry.actor}
                          {entry.reason && <span className="italic"> — {entry.reason}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                {order.statusHistory.filter((h) => h.fromStatus !== h.toStatus).length === 0 && (
                  <p className="text-xs text-smoke-400 italic">Nenhuma transicao registrada</p>
                )}
              </div>
            </div>
          )}

          {/* Admin Actions */}
          {order && onAction && (
            <div className="border-t pt-4 mt-4 space-y-2">
              <h4 className="text-sm font-semibold text-smoke-700">Ações administrativas</h4>
              {/* TODO: role-gate buttons client-side once staffRole is available in session */}
              <div className="flex flex-wrap gap-2">
                {order.currentPayment?.status === 'cash_pending' && (
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs font-medium rounded-sm bg-accent-green/10 text-accent-green hover:bg-accent-green/20 transition-colors"
                    onClick={() => onAction(order.id, 'confirm-cash')}
                  >
                    Confirmar dinheiro
                  </button>
                )}
                {!['canceled', 'delivered'].includes(order.fulfillment_status ?? '') && (
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs font-medium rounded-sm bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors"
                    onClick={() => onAction(order.id, 'force-cancel')}
                  >
                    Forçar cancelamento
                  </button>
                )}
                {order.currentPayment?.status === 'paid' && (
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs font-medium rounded-sm bg-accent-amber/10 text-accent-amber hover:bg-accent-amber/20 transition-colors"
                    onClick={() => onAction(order.id, 'refund')}
                  >
                    Reembolsar
                  </button>
                )}
                {order.currentPayment && !['paid', 'refunded', 'canceled', 'waived'].includes(order.currentPayment.status) && (
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs font-medium rounded-sm bg-charcoal-600/10 text-charcoal-600 hover:bg-charcoal-600/20 transition-colors"
                    onClick={() => onAction(order.id, 'waive')}
                  >
                    Isentar pagamento
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Payment History */}
          {paymentHistory && paymentHistory.length > 0 && (
            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold text-smoke-700 mb-2">Histórico de pagamentos</h4>
              <div className="space-y-2">
                {paymentHistory.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-xs bg-smoke-50 rounded-sm p-2">
                    <div>
                      <span className="font-medium capitalize">{p.method}</span>
                      <span className="mx-1">·</span>
                      <span className={p.status === 'paid' ? 'text-accent-green' : p.status === 'canceled' ? 'text-accent-red' : 'text-smoke-600'}>
                        {p.status}
                      </span>
                    </div>
                    <div className="text-smoke-500">
                      R$ {(p.amountInCentavos / 100).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Date */}
          <div className="text-xs text-smoke-400">
            Pedido em {new Date(order.created_at).toLocaleString('pt-BR')}
          </div>
        </div>
      </div>
    </>
  )
}
