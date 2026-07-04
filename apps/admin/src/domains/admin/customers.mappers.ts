// customers.mappers.ts — PURE view types + pt-BR format/label helpers for the
// OPS-070 Clientes admin surface (VIEW-FIRST). Renders the READ-ONLY
// GET /api/admin/customers[?q=] list + GET /api/admin/customers/:id composed
// view. Framework-free (no React, no '@/' imports) so the logic is trivially
// unit-testable in the repo's node vitest env — the only deps it pulls are the
// PURE `@ibatexas/ui/utils` (formatBRL / formatDate + the canonical status
// variant maps) and `@ibatexas/ui/constants` (the SINGLE-SOURCE pt-BR order /
// payment status label maps), never re-declared here. The response types below
// mirror the route-local view-composition (apps/api/src/ops/admin-customer-
// compose.ts) — a view, not domain state, so not exported from @ibatexas/domain
// (which the browser bundle cannot import anyway). MONEY crosses the boundary as
// INTEGER centavos (Hard Rule #2). pt-BR throughout (Hard Rule #4).

import { formatBRL, formatDate, statusVariant, paymentVariant, type BadgeVariant } from '@ibatexas/ui/utils'
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '@ibatexas/ui/constants'

// Re-export the canonical order/payment variant helpers so the page imports one
// source; the DECLARATION stays solely in @ibatexas/ui.
export { statusVariant, paymentVariant }
export type { BadgeVariant }

// ── Client mirror of the GET /api/admin/customers view-composition ───────────

/** One row of the compact customer search list (never carries CPF). */
export interface AdminCustomerListItem {
  readonly id: string
  readonly name: string | null
  readonly phone: string
  readonly email: string | null
  readonly source: string | null
  readonly createdAt: string
}

/** The paginated search response. */
export interface AdminCustomerListResponse {
  readonly customers: readonly AdminCustomerListItem[]
  readonly count: number
}

export interface AdminCustomerAddress {
  readonly id: string
  readonly street: string
  readonly number: string
  readonly complement: string | null
  readonly district: string
  readonly city: string
  readonly state: string
  readonly cep: string
  readonly isDefault: boolean
}

export interface AdminCustomerOrder {
  readonly id: string
  readonly displayId: number
  readonly fulfillmentStatus: string
  readonly paymentStatus: string | null
  readonly totalInCentavos: number
  readonly itemCount: number
  readonly deliveryType: string | null
  readonly paymentMethod: string | null
  readonly createdAt: string
}

export interface AdminCustomerLoyalty {
  readonly stamps: number
  readonly stampsNeeded: number
  readonly totalEarned: number
  readonly redeemed: number
  readonly exists: boolean
}

export interface AdminCustomerPreferences {
  readonly dietaryRestrictions: readonly string[]
  readonly allergenExclusions: readonly string[]
  readonly favoriteCategories: readonly string[]
}

export interface AdminCustomerDetail {
  readonly id: string
  readonly name: string | null
  readonly phone: string
  readonly email: string | null
  readonly cpf: string | null
  readonly source: string | null
  readonly firstContactAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly preferences: AdminCustomerPreferences | null
  readonly addresses: readonly AdminCustomerAddress[]
  readonly recentOrders: {
    readonly orders: readonly AdminCustomerOrder[]
    readonly count: number
  }
  readonly loyalty: AdminCustomerLoyalty
  readonly optedOutOfBroadcast: boolean
}

// ── Money (integer centavos → pt-BR BRL) ─────────────────────────────────────

/** INTEGER-centavos → "R$ 89,00" via the canonical formatBRL (guards NaN). */
export function formatCentavosBRL(centavos: number): string {
  return formatBRL(Number.isFinite(centavos) ? Math.trunc(centavos) : 0)
}

// ── Missing-value display ────────────────────────────────────────────────────

const EMPTY = '—'

/** A non-empty string or the em-dash placeholder (never a blank cell). */
export function orDash(value: string | null | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : EMPTY
}

// ── Phone (E.164 BR → humane) ────────────────────────────────────────────────

/**
 * Format a stored phone for display. Best-effort for the BR E.164 shape
 * (+55DDNNNNNNNNN) → "(DD) NNNNN-NNNN"; anything else renders verbatim (never
 * blank, never throws). PII: shown in full to the manager view only.
 */
export function formatPhoneBR(phone: string | null | undefined): string {
  const raw = phone?.trim()
  if (!raw) return EMPTY
  const digits = raw.replace(/\D/g, '')
  // +55 + 2-digit DDD + 9-digit mobile.
  if (digits.length === 13 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4)
    const part1 = digits.slice(4, 9)
    const part2 = digits.slice(9)
    return `(${ddd}) ${part1}-${part2}`
  }
  // +55 + 2-digit DDD + 8-digit landline.
  if (digits.length === 12 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4)
    const part1 = digits.slice(4, 8)
    const part2 = digits.slice(8)
    return `(${ddd}) ${part1}-${part2}`
  }
  return raw
}

// ── CPF (LGPD — masked by default) ───────────────────────────────────────────

/**
 * Mask a CPF for display. LGPD data-minimization: the admin view never renders
 * the full document — only the last two (verifier) digits, e.g.
 * "•••.•••.•••-00". A null / empty CPF renders the em-dash. The raw value is
 * NEVER logged (it is masked at the render boundary).
 */
export function formatCpfMasked(cpf: string | null | undefined): string {
  const digits = cpf?.replace(/\D/g, '')
  if (!digits || digits.length < 2) return EMPTY
  const last2 = digits.slice(-2)
  return `•••.•••.•••-${last2}`
}

// ── Source channel label ─────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  web: 'Site',
}

/** pt-BR label for the customer's origin channel (unknown → capitalized raw). */
export function sourceLabel(source: string | null | undefined): string {
  const s = source?.trim()
  if (!s) return EMPTY
  return SOURCE_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Order status / payment / delivery / method labels (pt-BR, DRY) ───────────

/** pt-BR order fulfillment status label (single-source map; raw fallback). */
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status
}

/** pt-BR payment status label (single-source map; em-dash for a null status). */
export function paymentStatusLabel(status: string | null | undefined): string {
  if (!status) return EMPTY
  return PAYMENT_STATUS_LABELS[status] ?? status
}

const DELIVERY_TYPE_LABELS: Record<string, string> = {
  delivery: 'Entrega',
  pickup: 'Retirada',
  dine_in: 'No local',
}

/** pt-BR delivery-type label (em-dash when unknown/null). */
export function deliveryTypeLabel(type: string | null | undefined): string {
  const t = type?.trim()
  if (!t) return EMPTY
  return DELIVERY_TYPE_LABELS[t] ?? t
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  pix: 'PIX',
  card: 'Cartão',
  cash: 'Dinheiro',
}

/** pt-BR payment-method label (em-dash when unknown/null). */
export function paymentMethodLabel(method: string | null | undefined): string {
  const m = method?.trim()
  if (!m) return EMPTY
  return PAYMENT_METHOD_LABELS[m] ?? m
}

// ── Broadcast opt-out badge ──────────────────────────────────────────────────

export interface OptOutBadge {
  readonly label: string
  readonly variant: BadgeVariant
}

/**
 * Broadcast (marketing) opt-out → a display badge. Opted-out is the notable
 * state (the customer must NOT be blasted) → amber `warning`; opted-in is the
 * quiet default → neutral `default`.
 */
export function optOutBadge(optedOut: boolean): OptOutBadge {
  return optedOut
    ? { label: 'Não recebe marketing', variant: 'warning' }
    : { label: 'Recebe marketing', variant: 'default' }
}

// ── Address one-liner ────────────────────────────────────────────────────────

/**
 * Collapse an address to a single pt-BR display line, skipping empty parts:
 * "Rua A, 100 — Apto 5, Centro, São Paulo/SP, CEP 01000-000".
 */
export function formatAddressLine(a: AdminCustomerAddress): string {
  const head = [a.street, a.number].filter((p) => p && p.trim().length > 0).join(', ')
  const withComplement = a.complement?.trim()
    ? `${head} — ${a.complement.trim()}`
    : head
  const tail = [a.district, `${a.city}/${a.state}`].filter((p) => p && p.trim().length > 0).join(', ')
  const cep = formatCep(a.cep)
  return [withComplement, tail, cep ? `CEP ${cep}` : ''].filter((p) => p.length > 0).join(', ')
}

/** 8-digit CEP → "01000-000"; anything else verbatim. */
export function formatCep(cep: string | null | undefined): string {
  const digits = cep?.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 8) return `${digits.slice(0, 5)}-${digits.slice(5)}`
  return cep?.trim() ?? ''
}

// ── Dates ────────────────────────────────────────────────────────────────────

/** ISO → pt-BR short date ("01/06/2026"); em-dash for a null. */
export function formatDateBR(iso: string | null | undefined): string {
  if (!iso) return EMPTY
  return formatDate(iso)
}
