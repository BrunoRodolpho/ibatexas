"use client"

import { useEffect, useState } from "react"
import { Link } from '@/i18n/navigation'
import { useTranslations } from "next-intl"
import { useSessionStore } from '@/domains/session'
import { apiFetch } from '@/lib/api'
import { Button, Container } from "@/components/atoms"
import { Flame, Heart, Package, User } from 'lucide-react'

interface CustomerProfile {
  id: string
  phone?: string
  name?: string
  email?: string
}

interface OrderSummary {
  id: string
  display_id: number
  status: string
  total: number
  created_at: string
}

export default function AccountPage() {
  const t = useTranslations()
  const { customerId, logout } = useSessionStore()
  const [profile, setProfile] = useState<CustomerProfile | null>(null)
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [reservationCount, setReservationCount] = useState(0)

  useEffect(() => {
    if (!customerId) return
    apiFetch<CustomerProfile>('/api/auth/me')
      .then(setProfile)
      .catch(() => {})
    apiFetch<{ orders: OrderSummary[] }>('/api/customer/orders')
      .then((data) => setOrders(data.orders ?? []))
      .catch(() => {})
    apiFetch<{ reservations: unknown[] }>('/api/reservations')
      .then((data) => setReservationCount(data.reservations?.length ?? 0))
      .catch(() => {})
  }, [customerId])

  if (!customerId) {
    return (
      <div className="min-h-screen bg-smoke-50 mx-auto max-w-md px-4 py-16 lg:py-24 text-center sm:px-6">
        <h1 className="text-3xl font-display text-charcoal-900">{t("account.title")}</h1>
        <p className="mt-4 text-smoke-400">{t("account.login_required")}</p>

        <Link href="/entrar?next=/account">
          <Button variant="brand" size="lg" className="mt-8 w-full">
            {t("checkout.login_button")}
          </Button>
        </Link>

        <p className="mt-6">
          <Link
            href={"/search"}
            className="text-charcoal-700 hover:text-charcoal-900 transition-micro"
          >
            {t("cart.continue_shopping")} →
          </Link>
        </p>
      </div>
    )
  }

  return (
    <Container size="xl" className="min-h-screen bg-smoke-50 py-16 lg:py-24">
      <div className="flex items-center gap-3 mb-2">
        <Flame className="w-4 h-4 text-brand-500 flex-shrink-0" strokeWidth={1.5} />
        <div className="h-px flex-1 bg-smoke-200/60" />
      </div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-display text-charcoal-900">{t("account.title")}</h1>
        <button
          onClick={() => logout()}
          className="text-accent-red hover:text-accent-red/80 transition-micro"
        >
          {t("account.logout")}
        </button>
      </div>

      <div className="mt-12 grid gap-8 md:grid-cols-2">
        {/* Profile */}
        <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-smoke-400" />
            <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
              {t("account.profile")}
            </h2>
          </div>
          {profile ? (
            <div className="mt-3 space-y-1 text-sm text-charcoal-700">
              {profile.name && <p className="font-medium">{profile.name}</p>}
              {profile.phone && <p className="text-smoke-400">{profile.phone}</p>}
              {profile.email && <p className="text-smoke-400">{profile.email}</p>}
              {!profile.name && !profile.phone && !profile.email && (
                <p className="text-smoke-400">{t("account.profile_description")}</p>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-smoke-400">{t("account.profile_description")}</p>
          )}
        </div>

        {/* Orders */}
        <Link
          href="/account/orders"
          className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium block"
        >
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-smoke-400" />
            <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
              {t("account.orders")}
            </h2>
          </div>
          <p className="mt-3 text-sm text-smoke-400">
            {orders.length > 0
              ? t("account.orders_count", { count: orders.length })
              : t("account.orders_description")}
          </p>
          <span className="mt-3 inline-block text-sm text-charcoal-700 font-medium">
            {t("account.view_orders")} →
          </span>
        </Link>

        {/* Reservations */}
        <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium">
          <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
            {t("account.reservations")}
          </h2>
          <p className="mt-3 text-sm text-smoke-400">
            {reservationCount > 0
              ? t("account.reservations_count", { count: reservationCount })
              : t("account.no_reservations")}
          </p>
          {reservationCount > 0 && (
            <Link
              href={"/account/reservations"}
              className="mt-3 inline-block text-sm text-charcoal-700 hover:text-charcoal-900 font-medium transition-micro"
            >
              {t("common.view_all")} →
            </Link>
          )}
        </div>

        {/* Preferences */}
        <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium">
          <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
            {t("account.preferences")}
          </h2>
          <p className="mt-3 text-sm text-smoke-400">
            {t("account.dietary_restrictions")} e {t("account.allergens")}
          </p>
        </div>

        {/* Wishlist */}
        <Link
          href="/lista-desejos"
          className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium block"
        >
          <div className="flex items-center gap-2">
            <Heart className="w-4 h-4 text-smoke-400" />
            <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
              {t("account.wishlist")}
            </h2>
          </div>
          <p className="mt-3 text-sm text-smoke-400">
            {t("account.wishlist_description")}
          </p>
        </Link>

        {/* Saved Addresses */}
        <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium">
          <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
            {t("account.saved_addresses")}
          </h2>
          <p className="mt-3 text-sm text-smoke-400">
            {t("account.addresses_description")}
          </p>
        </div>
      </div>
    </Container>
  )
}
