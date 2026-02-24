"use client"

import Link from "next/link"
import { useTranslations, useLocale } from "next-intl"
import { useCartStore } from "@/stores"

export function Header() {
  const t = useTranslations()
  const locale = useLocale()
  const cartCount = useCartStore((s) => s.items.length)

  return (
    <header className="border-b bg-white">
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-4">
          {/* Logo */}
          <Link href={`/${locale}`} className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-orange-600" />
            <span className="hidden font-bold text-orange-900 sm:inline">
              IbateXas
            </span>
          </Link>

          {/* Nav */}
          <nav className="hidden gap-6 sm:flex">
            <Link
              href={`/${locale}/search`}
              className="text-sm font-medium text-gray-700 hover:text-orange-600"
            >
              {t("nav.shop")}
            </Link>
            <Link
              href={`/${locale}/loja`}
              className="text-sm font-medium text-gray-700 hover:text-orange-600"
            >
              {t("nav.loja")}
            </Link>
            <Link
              href={`/${locale}/account/reservations`}
              className="text-sm font-medium text-gray-700 hover:text-orange-600"
            >
              {t("nav.reservations")}
            </Link>
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <Link
              href={`/${locale}/search`}
              className="rounded-lg p-2 text-gray-700 hover:bg-gray-100"
              aria-label={t("common.search")}
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </Link>

            <Link
              href={`/${locale}/cart`}
              className="relative rounded-lg p-2 text-gray-700 hover:bg-gray-100"
              aria-label={t("nav.cart")}
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
              {cartCount > 0 && (
                <span className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-orange-600 text-xs font-bold text-white">
                  {cartCount}
                </span>
              )}
            </Link>

            <Link
              href={`/${locale}/account`}
              className="rounded-lg p-2 text-gray-700 hover:bg-gray-100"
              aria-label={t("nav.account")}
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            </Link>
          </div>
        </div>
      </div>
    </header>
  )
}
