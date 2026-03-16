"use client"

import { Link } from '@/i18n/navigation'
import { useTranslations } from "next-intl"
import { useSessionStore } from '@/domains/session'
import { Button } from "@/components/atoms"

export default function AccountPage() {
  const t = useTranslations()
  const { customerId, logout } = useSessionStore()

  if (!customerId) {
    return (
      <div className="min-h-screen bg-smoke-50 mx-auto max-w-md px-4 py-12 text-center sm:px-6">
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
            className="text-charcoal-700 hover:text-charcoal-900 transition-colors duration-500"
          >
            {t("cart.continue_shopping")} →
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-smoke-50 mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-display text-charcoal-900">{t("account.title")}</h1>
        <button
          onClick={() => logout()}
          className="text-accent-red hover:text-accent-red/80 transition-colors duration-500"
        >
          {t("account.logout")}
        </button>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        {/* Profile */}
        <div className="rounded-sm border border-smoke-200 bg-smoke-50 p-5 hover:bg-smoke-100 transition-all duration-500">
          <h2 className="text-[10px] font-semibold uppercase tracking-editorial text-smoke-400">
            {t("account.profile")}
          </h2>
          <p className="mt-3 text-sm text-smoke-400">
            {t("account.profile_description")}
          </p>
        </div>

        {/* Orders */}
        <div className="rounded-sm border border-smoke-200 bg-smoke-50 p-5 hover:bg-smoke-100 transition-all duration-500">
          <h2 className="text-[10px] font-semibold uppercase tracking-editorial text-smoke-400">
            {t("account.orders")}
          </h2>
          <p className="mt-3 text-sm text-smoke-400">
            {t("account.orders_description")}
          </p>
        </div>

        {/* Reservations */}
        <div className="rounded-sm border border-smoke-200 bg-smoke-50 p-5 hover:bg-smoke-100 transition-all duration-500">
          <h2 className="text-[10px] font-semibold uppercase tracking-editorial text-smoke-400">
            {t("account.reservations")}
          </h2>
          <p className="mt-3 text-sm text-smoke-400">
            {t("account.reservations_description")}
          </p>
          <Link
            href={"/account/reservations"}
            className="mt-3 inline-block text-sm text-charcoal-700 hover:text-charcoal-900 font-medium transition-colors duration-500"
          >
            {t("common.view_all")} →
          </Link>
        </div>

        {/* Preferences */}
        <div className="rounded-sm border border-smoke-200 bg-smoke-50 p-5 hover:bg-smoke-100 transition-all duration-500">
          <h2 className="text-[10px] font-semibold uppercase tracking-editorial text-smoke-400">
            {t("account.preferences")}
          </h2>
          <p className="mt-3 text-sm text-smoke-400">
            {t("account.dietary_restrictions")} e {t("account.allergens")}
          </p>
        </div>

        {/* Saved Addresses */}
        <div className="rounded-sm border border-smoke-200 bg-smoke-50 p-5 hover:bg-smoke-100 transition-all duration-500">
          <h2 className="text-[10px] font-semibold uppercase tracking-editorial text-smoke-400">
            {t("account.saved_addresses")}
          </h2>
          <p className="mt-3 text-sm text-smoke-400">
            {t("account.addresses_description")}
          </p>
        </div>
      </div>
    </div>
  )
}
