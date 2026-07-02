'use client'

import { Button, Card, SectionHeader } from '@ibatexas/ui'

/**
 * OPS-071 — "Confirmações pendentes": two-phase destructive admin actions
 * parked at step 1 and awaiting a DIFFERENT operator's step-2 confirmation
 * (the server refuses same-actor confirms with a pt-BR 403).
 *
 * Presentation-only: the page owns polling GET /api/admin/confirmations and
 * the step-2 POST; this panel lists the receipts and fires `onConfirm`.
 * Fields are optional because the endpoint ships in a sibling change — every
 * render path tolerates a missing field.
 */
export interface PendingConfirmation {
  readonly confirmationId: string
  /** Route key ("force-cancel" | "refund" | "waive" | "force-status") — picks the confirm endpoint. */
  readonly route?: string
  /** Defensive alias — earlier endpoint drafts named the route key `action`. */
  readonly action?: string
  /** The intent kind step 2 dispatches (display-irrelevant here). */
  readonly kind?: string
  readonly orderId?: string
  /** Stored envelope payload (display params — no secrets). */
  readonly params?: Record<string, unknown>
  /** Step-1 operator (staffId) — the confirmer must be someone ELSE. */
  readonly requestedBy?: string | null
  /** Server-authored pt-BR description of what step 2 will execute. */
  readonly prompt?: string
  readonly createdAt?: string
  readonly expiresAt?: string | null
  readonly refundAmountCentavos?: number
  readonly reason?: string
}

/** The receipt's route key, tolerating the `action` alias. */
export function confirmationRouteKey(confirmation: PendingConfirmation): string | undefined {
  return confirmation.route ?? confirmation.action
}

/** pt-BR labels for the known two-phase route keys. Unknown routes render raw. */
const ROUTE_LABELS_PT: Record<string, string> = {
  'force-cancel': 'Forçar cancelamento',
  'refund': 'Reembolsar pagamento',
  'waive': 'Isentar pagamento',
  'force-status': 'Forçar status do pagamento',
}

/** Integer-centavos display formatting — no float math (hard rule #2). */
function formatCentavos(centavos: number): string {
  const reais = Math.floor(centavos / 100).toLocaleString('pt-BR')
  const cents = String(centavos % 100).padStart(2, '0')
  return `R$ ${reais},${cents}`
}

function formatExpiry(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

/** Amount + motivo fallback line for receipts without a server prompt. */
function detailsSummary(confirmation: PendingConfirmation): string[] {
  const parts: string[] = []
  const amount =
    typeof confirmation.refundAmountCentavos === 'number'
      ? confirmation.refundAmountCentavos
      : confirmation.params?.amountInCentavos
  if (typeof amount === 'number' && Number.isSafeInteger(amount)) {
    parts.push(`Valor: ${formatCentavos(amount)}`)
  }
  const reason = confirmation.reason ?? confirmation.params?.reason
  if (typeof reason === 'string' && reason.trim()) {
    parts.push(`Motivo: ${reason.trim()}`)
  }
  return parts
}

export interface PendingConfirmationsPanelProps {
  readonly confirmations: readonly PendingConfirmation[]
  /** confirmationId of the receipt whose step-2 POST is in flight. */
  readonly confirmingId: string | null
  readonly onConfirm: (confirmation: PendingConfirmation) => void
}

export function PendingConfirmationsPanel({
  confirmations,
  confirmingId,
  onConfirm,
}: PendingConfirmationsPanelProps): React.JSX.Element | null {
  if (confirmations.length === 0) return null

  return (
    <Card className="mb-6 border border-smoke-200 p-4">
      <SectionHeader title={`Confirmações pendentes (${confirmations.length})`} />
      <p className="mt-1 text-xs text-charcoal-700">
        Ações destrutivas aguardando dupla checagem — quem iniciou não pode confirmar.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {confirmations.map((confirmation) => {
          const routeKey = confirmationRouteKey(confirmation)
          const label = routeKey ? (ROUTE_LABELS_PT[routeKey] ?? routeKey) : 'Ação desconhecida'
          const expiry = formatExpiry(confirmation.expiresAt)
          const details = detailsSummary(confirmation)
          // Without a known route + orderId we cannot build the step-2 path.
          const confirmable = Boolean(confirmation.orderId && routeKey && ROUTE_LABELS_PT[routeKey])
          return (
            <li
              key={confirmation.confirmationId}
              className="flex items-center justify-between gap-3 rounded-sm border border-smoke-200 bg-white px-3 py-2"
            >
              <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                <span className="font-medium text-charcoal-900">
                  {label}
                  {confirmation.orderId ? ` — pedido ${confirmation.orderId}` : ''}
                </span>
                {confirmation.prompt ? (
                  <span className="text-xs text-charcoal-700">{confirmation.prompt}</span>
                ) : (
                  details.length > 0 && (
                    <span className="truncate text-xs text-charcoal-700">{details.join(' · ')}</span>
                  )
                )}
                <span className="text-xs text-charcoal-700">
                  {confirmation.requestedBy ? `Solicitado por ${confirmation.requestedBy}` : 'Solicitante não identificado'}
                  {expiry ? ` · expira às ${expiry}` : ''}
                </span>
              </div>
              <Button
                variant="danger"
                size="sm"
                isLoading={confirmingId === confirmation.confirmationId}
                disabled={!confirmable || (confirmingId !== null && confirmingId !== confirmation.confirmationId)}
                onClick={() => onConfirm(confirmation)}
              >
                Confirmar
              </Button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
