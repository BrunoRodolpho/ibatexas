"use client"

import { Link } from '@/i18n/navigation'
import { useTranslations } from "next-intl"
import { useSessionStore } from "@/stores"

export default function AccountPage() {
  const t = useTranslations()
  const { customerId, userType, logout } = useSessionStore()

  if (!customerId) {
    return (
      <div className="mx-auto max-w-md px-4 py-12 text-center sm:px-6">
        <h1 className="text-3xl font-bold text-slate-900">{t("account.title")}</h1>
        <p className="mt-4 text-slate-600">{t("account.login_required")}</p>

        <button className="mt-8 w-full rounded-lg bg-brand-500 px-6 py-3 font-medium text-white hover:bg-brand-600 transition-colors duration-250">
          {t("checkout.login_button")}
        </button>

        <p className="mt-6">
          <Link
            href={"/search"}
            className="text-brand-500 hover:text-brand-600 transition-colors duration-250"
          >
            {t("cart.continue_shopping")} →
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-slate-900">{t("account.title")}</h1>
        <button
          onClick={() => logout()}
          className="text-red-600 hover:text-red-700 transition-colors duration-250"
        >
          {t("account.logout")}
        </button>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        {/* Profile */}
        <div className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-card-sm">
          <h2 className="text-lg font-bold text-slate-900">
            {t("account.profile")}
          </h2>
          <p className="mt-4 text-slate-600">
            {t("account.profile_description")}
          </p>
        </div>

        {/* Orders */}
        <div className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-card-sm">
          <h2 className="text-lg font-bold text-slate-900">
            {t("account.orders")}
          </h2>
          <p className="mt-4 text-slate-600">
            {t("account.orders_description")}
          </p>
        </div>

        {/* Reservations */}
        <div className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-card-sm">
          <h2 className="text-lg font-bold text-slate-900">
            {t("account.reservations")}
          </h2>
          <p className="mt-4 text-slate-600">
            {t("account.reservations_description")}
          </p>
          <Link
            href={"/account/reservations"}
            className="mt-4 inline-block text-brand-500 hover:text-brand-600 font-medium transition-colors duration-250"
          >
            {t("common.view_all")} →
          </Link>
        </div>

        {/* Preferences */}
        <div className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-card-sm">
          <h2 className="text-lg font-bold text-slate-900">
            {t("account.preferences")}
          </h2>
          <p className="mt-4 text-slate-600">
            {t("account.dietary_restrictions")} e {t("account.allergens")}
          </p>
        </div>

        {/* Saved Addresses */}
        <div className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-card-sm">
          <h2 className="text-lg font-bold text-slate-900">
            {t("account.saved_addresses")}
          </h2>
          <p className="mt-4 text-slate-600">
            {t("account.addresses_description")}
          </p>
        </div>

        {/* Payment Methods */}
        <div className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-card-sm">
          <h2 className="text-lg font-bold text-slate-900">
            {t("account.payment_methods")}
          </h2>
          <p className="mt-4 text-slate-600">
            {t("account.payment_description")}
          </p>
        </div>
      </div>
    </div>
  )
}
