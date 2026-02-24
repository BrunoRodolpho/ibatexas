"use client"

import Link from "next/link"
import { useTranslations, useLocale } from "next-intl"
import { useSessionStore } from "@/stores"

export default function AccountPage() {
  const t = useTranslations()
  const locale = useLocale()
  const { customerId, userType, logout } = useSessionStore()

  if (!customerId) {
    return (
      <div className="mx-auto max-w-md px-4 py-12 text-center sm:px-6">
        <h1 className="text-3xl font-bold text-gray-900">{t("account.title")}</h1>
        <p className="mt-4 text-gray-600">{t("account.login_required")}</p>

        <button className="mt-8 w-full rounded-lg bg-orange-600 px-6 py-3 font-medium text-white hover:bg-orange-700">
          {t("checkout.login_button")}
        </button>

        <p className="mt-6">
          <Link
            href={`/${locale}/search`}
            className="text-orange-600 hover:text-orange-700"
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
        <h1 className="text-3xl font-bold text-gray-900">{t("account.title")}</h1>
        <button
          onClick={() => logout()}
          className="text-red-600 hover:text-red-700"
        >
          {t("account.logout")}
        </button>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        {/* Profile */}
        <div className="rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-bold text-gray-900">
            {t("account.profile")}
          </h2>
          <p className="mt-4 text-gray-600">
            Informações do seu perfil aparecem aqui
          </p>
          <Link
            href="#"
            className="mt-4 inline-block text-orange-600 hover:text-orange-700"
          >
            {t("common.view_all")} →
          </Link>
        </div>

        {/* Orders */}
        <div className="rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-bold text-gray-900">
            {t("account.orders")}
          </h2>
          <p className="mt-4 text-gray-600">Seu histórico de pedidos</p>
          <Link
            href="#"
            className="mt-4 inline-block text-orange-600 hover:text-orange-700"
          >
            {t("common.view_all")} →
          </Link>
        </div>

        {/* Reservations */}
        <div className="rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-bold text-gray-900">
            {t("account.reservations")}
          </h2>
          <p className="mt-4 text-gray-600">Suas reservas de mesa</p>
          <Link
            href={`/${locale}/account/reservations`}
            className="mt-4 inline-block text-orange-600 hover:text-orange-700"
          >
            {t("common.view_all")} →
          </Link>
        </div>

        {/* Preferences */}
        <div className="rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-bold text-gray-900">
            {t("account.preferences")}
          </h2>
          <p className="mt-4 text-gray-600">
            {t("account.dietary_restrictions")} e {t("account.allergens")}
          </p>
          <Link
            href="#"
            className="mt-4 inline-block text-orange-600 hover:text-orange-700"
          >
            {t("common.view_all")} →
          </Link>
        </div>

        {/* Saved Addresses */}
        <div className="rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-bold text-gray-900">
            {t("account.saved_addresses")}
          </h2>
          <p className="mt-4 text-gray-600">Endereços salvos para entrega</p>
          <Link
            href="#"
            className="mt-4 inline-block text-orange-600 hover:text-orange-700"
          >
            {t("common.view_all")} →
          </Link>
        </div>

        {/* Payment Methods */}
        <div className="rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-bold text-gray-900">
            {t("account.payment_methods")}
          </h2>
          <p className="mt-4 text-gray-600">Seus métodos de pagamento</p>
          <Link
            href="#"
            className="mt-4 inline-block text-orange-600 hover:text-orange-700"
          >
            {t("common.view_all")} →
          </Link>
        </div>
      </div>
    </div>
  )
}
