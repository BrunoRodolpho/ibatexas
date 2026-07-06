'use client'

// Clientes — a manager customer surface (OPS-070). A searchable list
// (GET /api/admin/customers) → a composed detail view (GET /api/admin/customers/
// :id): perfil, endereços, pedidos recentes, fidelidade, preferências e o opt-out
// de marketing. VIEW-FIRST — the ONLY governed customer-data write on this page
// is the broadcast opt-out/opt-in TOGGLE (BKL-097), which REUSES the existing
// manager-gated opt-out/opt-in admin endpoints verbatim (no new mutation
// authority); re-enabling marketing (opt-in) is gated behind a re-consent
// confirm. All non-trivial logic (money/phone/CPF/label formatting + the
// optimistic toggle plan) lives in the PURE customers.mappers module. pt-BR
// throughout (Hard Rule #4); money in integer centavos (Hard Rule #2). CPF is
// masked at the render boundary (LGPD).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Users, Search, ChevronLeft, ChevronRight, MapPin, Award, ShoppingBag, Info } from 'lucide-react'
import { Badge, Button, Modal, useToast } from '@ibatexas/ui'
import { useAdminCustomers, useAdminCustomer, useCustomerOptOut } from '@/domains/admin/admin.hooks'
import {
  formatCentavosBRL,
  formatPhoneBR,
  formatCpfMasked,
  formatDateBR,
  formatAddressLine,
  sourceLabel,
  orderStatusLabel,
  paymentStatusLabel,
  deliveryTypeLabel,
  paymentMethodLabel,
  optOutBadge,
  optOutActionLabel,
  OPT_IN_CONFIRM,
  orDash,
  statusVariant,
  paymentVariant,
  type AdminCustomerListItem,
  type AdminCustomerDetail,
} from '@/domains/admin/customers.mappers'

const LIST_LOAD_FAILED = 'Falha ao carregar a lista de clientes.'
const DETAIL_LOAD_FAILED = 'Falha ao carregar a ficha do cliente.'

// ── Small shared primitives (match the border-smoke card language) ───────────

function Card({
  title,
  icon,
  children,
}: Readonly<{ title: string; icon?: React.ReactNode; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-smoke-200 bg-smoke-50 p-4">
      <h2 className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-smoke-400">
        {icon}
        {title}
      </h2>
      {children}
    </div>
  )
}

function Field({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-smoke-500">{label}</span>
      <span className="text-right text-charcoal-800">{value}</span>
    </div>
  )
}

function Chips({ values }: Readonly<{ values: readonly string[] }>): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((v) => (
        <span
          key={v}
          className="rounded-sm border border-smoke-200 bg-white px-2 py-0.5 text-xs text-charcoal-700"
        >
          {v}
        </span>
      ))}
    </div>
  )
}

// ── List (left pane) ─────────────────────────────────────────────────────────

function CustomerRow({
  customer,
  selected,
  onSelect,
}: Readonly<{
  customer: AdminCustomerListItem
  selected: boolean
  onSelect: (id: string) => void
}>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(customer.id)}
      aria-pressed={selected}
      className={`flex w-full flex-col gap-0.5 rounded-sm border px-3 py-2 text-left transition-colors ${
        selected
          ? 'border-charcoal-300 bg-white'
          : 'border-smoke-200 bg-smoke-50 hover:bg-smoke-100'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-charcoal-900">
          {orDash(customer.name)}
        </span>
        {customer.source ? (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-smoke-400">
            {sourceLabel(customer.source)}
          </span>
        ) : null}
      </div>
      <span className="text-xs tabular-nums text-smoke-500">{formatPhoneBR(customer.phone)}</span>
    </button>
  )
}

// ── Detail (right pane) ──────────────────────────────────────────────────────

function LoyaltyCard({ loyalty }: Readonly<Pick<AdminCustomerDetail, 'loyalty'>>): React.JSX.Element {
  if (!loyalty.exists) {
    return (
      <Card title="Fidelidade" icon={<Award className="h-3 w-3" aria-hidden />}>
        <p className="text-sm text-smoke-500">Sem programa de fidelidade ativo.</p>
      </Card>
    )
  }
  return (
    <Card title="Fidelidade" icon={<Award className="h-3 w-3" aria-hidden />}>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-charcoal-900">{loyalty.stamps}</span>
        <span className="text-sm text-smoke-500">de 10 selos</span>
      </div>
      <div className="flex flex-col gap-1 border-t border-smoke-100 pt-2">
        <Field label="Faltam para o prêmio" value={`${loyalty.stampsNeeded} selos`} />
        <Field label="Total acumulado" value={String(loyalty.totalEarned)} />
        <Field label="Resgatados" value={String(loyalty.redeemed)} />
      </div>
    </Card>
  )
}

function OrdersCard({
  recentOrders,
}: Readonly<Pick<AdminCustomerDetail, 'recentOrders'>>): React.JSX.Element {
  const { orders, count } = recentOrders
  return (
    <Card title={`Pedidos recentes (${count})`} icon={<ShoppingBag className="h-3 w-3" aria-hidden />}>
      {orders.length === 0 ? (
        <p className="text-sm text-smoke-500">Nenhum pedido registrado.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {orders.map((o) => (
            <div
              key={o.id}
              className="flex flex-col gap-1 rounded-sm border border-smoke-200 bg-white px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-charcoal-900">#{o.displayId}</span>
                <span className="text-sm font-semibold tabular-nums text-charcoal-900">
                  {formatCentavosBRL(o.totalInCentavos)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={statusVariant(o.fulfillmentStatus)}>
                  {orderStatusLabel(o.fulfillmentStatus)}
                </Badge>
                {o.paymentStatus ? (
                  <Badge variant={paymentVariant(o.paymentStatus)}>
                    {paymentStatusLabel(o.paymentStatus)}
                  </Badge>
                ) : null}
                <span className="text-xs text-smoke-500">
                  {deliveryTypeLabel(o.deliveryType)} · {paymentMethodLabel(o.paymentMethod)}
                </span>
                <span className="ml-auto text-xs tabular-nums text-smoke-400">
                  {formatDateBR(o.createdAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// Broadcast opt-out TOGGLE (BKL-097). Replaces the read-only opt-out badge with
// a governed switch that reuses the existing opt-out/opt-in admin endpoints. The
// switch is "on" when the customer RECEIVES marketing (opted-in). Turning it off
// (opt-out) fires directly; turning it on (opt-in) is a re-consent decision and
// opens a confirm dialog first. State flips optimistically and rolls back on a
// failed write (see useCustomerOptOut). Keyed on the customer id by the caller so
// a new selection re-seeds fresh.
function OptOutToggle({
  phone,
  initialOptedOut,
}: Readonly<{ phone: string; initialOptedOut: boolean }>): React.JSX.Element {
  const { optedOut, pending, confirmOpen, requestToggle, confirmToggle, cancelConfirm } =
    useCustomerOptOut(phone, initialOptedOut)
  const badge = optOutBadge(optedOut)
  const receivesMarketing = !optedOut

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={receivesMarketing}
        aria-label={optOutActionLabel(optedOut)}
        disabled={pending}
        onClick={requestToggle}
        className="group flex shrink-0 items-center gap-2 rounded-sm disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span
          aria-hidden
          className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
            receivesMarketing ? 'bg-charcoal-700' : 'bg-smoke-300'
          }`}
        >
          <span
            className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
              receivesMarketing ? 'translate-x-3.5' : 'translate-x-0.5'
            }`}
          />
        </span>
      </button>

      <Modal
        isOpen={confirmOpen}
        onClose={cancelConfirm}
        title={OPT_IN_CONFIRM.title}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={cancelConfirm} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="primary" size="sm" isLoading={pending} onClick={confirmToggle}>
              {OPT_IN_CONFIRM.confirmLabel}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-charcoal-700">{OPT_IN_CONFIRM.body}</p>
      </Modal>
    </>
  )
}

function CustomerDetail({ customer }: Readonly<{ customer: AdminCustomerDetail }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {/* Perfil */}
      <Card title="Perfil" icon={<Users className="h-3 w-3" aria-hidden />}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-charcoal-900">{orDash(customer.name)}</h3>
          <OptOutToggle
            key={customer.id}
            phone={customer.phone}
            initialOptedOut={customer.optedOutOfBroadcast}
          />
        </div>
        <div className="flex flex-col gap-1 border-t border-smoke-100 pt-2">
          <Field label="Telefone" value={formatPhoneBR(customer.phone)} />
          <Field label="E-mail" value={orDash(customer.email)} />
          <Field label="CPF" value={formatCpfMasked(customer.cpf)} />
          <Field label="Origem" value={sourceLabel(customer.source)} />
          <Field label="Cliente desde" value={formatDateBR(customer.createdAt)} />
          <Field label="Primeiro contato" value={formatDateBR(customer.firstContactAt)} />
        </div>
      </Card>

      {/* Preferências (quando houver) */}
      {customer.preferences &&
      (customer.preferences.dietaryRestrictions.length > 0 ||
        customer.preferences.allergenExclusions.length > 0 ||
        customer.preferences.favoriteCategories.length > 0) ? (
        <Card title="Preferências">
          {customer.preferences.allergenExclusions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-smoke-500">Alergênicos a evitar</span>
              <Chips values={customer.preferences.allergenExclusions} />
            </div>
          ) : null}
          {customer.preferences.dietaryRestrictions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-smoke-500">Restrições alimentares</span>
              <Chips values={customer.preferences.dietaryRestrictions} />
            </div>
          ) : null}
          {customer.preferences.favoriteCategories.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-smoke-500">Categorias favoritas</span>
              <Chips values={customer.preferences.favoriteCategories} />
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* Endereços */}
      <Card title={`Endereços (${customer.addresses.length})`} icon={<MapPin className="h-3 w-3" aria-hidden />}>
        {customer.addresses.length === 0 ? (
          <p className="text-sm text-smoke-500">Nenhum endereço salvo.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {customer.addresses.map((a) => (
              <div
                key={a.id}
                className="flex items-start justify-between gap-2 rounded-sm border border-smoke-200 bg-white px-3 py-2"
              >
                <span className="text-sm text-charcoal-800">{formatAddressLine(a)}</span>
                {a.isDefault ? (
                  <Badge variant="success" className="shrink-0">
                    Padrão
                  </Badge>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <LoyaltyCard loyalty={customer.loyalty} />
      <OrdersCard recentOrders={customer.recentOrders} />

      {/* WS4C — client summary cross-links: the customer's full order history and
          their conversations (both filtered by this customer id). */}
      <div className="flex flex-wrap gap-2 pt-1">
        <Link
          href={`/admin/pedidos?customerId=${encodeURIComponent(customer.id)}`}
          className="rounded-sm border border-smoke-200 bg-white px-3 py-1.5 text-[13px] font-medium text-blue-700 hover:bg-smoke-50"
        >
          Ver todos os pedidos →
        </Link>
        <Link
          href={`/admin/conversas?customerId=${encodeURIComponent(customer.id)}`}
          className="rounded-sm border border-smoke-200 bg-white px-3 py-1.5 text-[13px] font-medium text-blue-700 hover:bg-smoke-50"
        >
          Ver conversas →
        </Link>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ClientesPage(): React.JSX.Element {
  const { addToast } = useToast()
  const {
    query,
    setQuery,
    customers,
    count,
    page,
    setPage,
    totalPages,
    loading: listLoading,
    error: listError,
  } = useAdminCustomers()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { customer, loading: detailLoading, error: detailError, notFound } = useAdminCustomer(selectedId)

  useEffect(() => {
    if (listError) {
      addToast({ type: 'error', message: LIST_LOAD_FAILED, dedupeKey: 'customers-list-load' })
    }
  }, [listError, addToast])

  useEffect(() => {
    // A 404 (unknown id) renders its own inline state — only toast real failures.
    if (detailError && !notFound) {
      addToast({ type: 'error', message: DETAIL_LOAD_FAILED, dedupeKey: 'customer-detail-load' })
    }
  }, [detailError, notFound, addToast])

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-2.5">
        <Users className="mt-0.5 h-5 w-5 text-charcoal-700" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold text-charcoal-900">Clientes</h1>
          <p className="text-sm text-smoke-500">
            Consulta somente leitura — perfil, endereços, pedidos, fidelidade e opt-out.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
        {/* ── List pane ──────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-smoke-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nome, telefone ou e-mail"
              className="w-full rounded-sm border border-smoke-200 bg-white py-2 pl-8 pr-3 text-sm text-charcoal-900 placeholder:text-smoke-400 focus:border-charcoal-300 focus:outline-none"
            />
          </div>

          {listLoading && customers.length === 0 ? (
            <div className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-smoke-400">
              Carregando…
            </div>
          ) : customers.length === 0 ? (
            <div className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-smoke-400">
              Nenhum cliente encontrado.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {customers.map((c) => (
                <CustomerRow
                  key={c.id}
                  customer={c}
                  selected={c.id === selectedId}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          )}

          {/* Pagination */}
          {count > 0 ? (
            <div className="flex items-center justify-between gap-2 text-xs text-smoke-500">
              <span className="tabular-nums">{count} cliente(s)</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                  className="rounded-sm border border-smoke-200 bg-smoke-50 p-1 text-charcoal-700 hover:bg-smoke-100 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="tabular-nums">
                  {page + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                  disabled={page >= totalPages - 1}
                  className="rounded-sm border border-smoke-200 bg-smoke-50 p-1 text-charcoal-700 hover:bg-smoke-100 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Próxima página"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* ── Detail pane ────────────────────────────────────────────────────── */}
        <div>
          {!selectedId ? (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-sm border border-dashed border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-smoke-400">
              <Info className="h-5 w-5" aria-hidden />
              <p className="text-sm">Selecione um cliente para ver a ficha completa.</p>
            </div>
          ) : notFound ? (
            <div className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-smoke-400">
              Cliente não encontrado.
            </div>
          ) : detailLoading && !customer ? (
            <div className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-smoke-400">
              Carregando ficha…
            </div>
          ) : customer ? (
            <CustomerDetail customer={customer} />
          ) : (
            <div className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-smoke-400">
              Não foi possível carregar a ficha do cliente.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
