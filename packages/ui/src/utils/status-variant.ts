/**
 * Shared Badge-variant maps — single source of truth for admin status pills.
 *
 * De-duplicates the two formerly-divergent copies of `statusVariant()` /
 * `paymentVariant()` that lived inline in `AdminPedidosPage` and
 * `AdminOrderDetailDrawer`. Reconciled DELIBERATELY (not a blind extraction):
 *
 *  - `ready` is repointed off the grey `'info'` cast onto its intended amber
 *    `'warning'` (P0-1 regression-safety: this MUST land before `Badge`'s
 *    `info` variant is recolored blue, otherwise every existing `ready` order
 *    badge would silently flip grey→blue).
 *  - `requires_action` (Pedidos-only) and the legacy `captured`/`pending`
 *    payment statuses are unioned in — they carry proper pt-BR labels
 *    (`captured`='pago', `pending`='pendente'), so the unified map is the
 *    semantically-correct superset; the order drawer only ever passes
 *    canonical statuses, so its rendering is unchanged in practice.
 *
 * `incidentStatusVariant()` is the net-new third map (§6 of the Incidentes
 * UX spec), keyed off the recolored blue `info` for AUTO_RESOLVED so staff can
 * tell "the system healed itself" (blue) from "a human closed it" (green).
 */

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'default' | 'info'

const ORDER_STATUS_VARIANTS: Record<string, BadgeVariant> = {
  completed: 'success',
  delivered: 'success',
  confirmed: 'success',
  pending: 'warning',
  preparing: 'warning',
  ready: 'warning', // P0-1: repointed off the old `'info' as 'warning'` cast
  requires_action: 'warning',
  canceled: 'danger',
}

export function statusVariant(status: string): BadgeVariant {
  return ORDER_STATUS_VARIANTS[status] ?? 'default'
}

const PAYMENT_STATUS_VARIANTS: Record<string, BadgeVariant> = {
  paid: 'success',
  captured: 'success', // legacy Medusa status = pago
  awaiting_payment: 'warning',
  payment_pending: 'warning',
  cash_pending: 'warning',
  switching_method: 'warning',
  pending: 'warning',
  payment_expired: 'danger',
  payment_failed: 'danger',
  canceled: 'danger',
}

export function paymentVariant(status: string): BadgeVariant {
  return PAYMENT_STATUS_VARIANTS[status] ?? 'default'
}

const INCIDENT_STATUS_VARIANTS: Record<string, BadgeVariant> = {
  OPEN: 'danger',
  ACKNOWLEDGED: 'warning',
  AUTO_RESOLVED: 'info', // net-new blue — "the system healed itself"
  RESOLVED: 'success',
}

export function incidentStatusVariant(status: string): BadgeVariant {
  return INCIDENT_STATUS_VARIANTS[status] ?? 'default'
}
