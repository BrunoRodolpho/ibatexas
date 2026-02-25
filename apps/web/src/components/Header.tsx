"use client"

import { Link } from "@/i18n/navigation"
import { useTranslations } from "next-intl"
import { useCartStore, useSessionStore } from "@/stores"

export function Header() {
  const t = useTranslations()
  const cartCount = useCartStore((s) => s.items.reduce((sum, i) => sum + i.quantity, 0))
  const userType = useSessionStore((s) => s.userType)

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/60 bg-white/80 backdrop-blur-header shadow-header transition-all duration-250">
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-4">
          {/* Logo */}
          <Link href={"/"} className="flex items-center gap-3 group">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 shadow-glow-brand group-hover:shadow-glow-brand-lg transition-all duration-250">
              <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2C10.5 5.5 7 7.5 6 10.5c-1 3 .5 5.5 2 7a5 5 0 002 1.5c-.5-1.5-.5-3 .5-4.5.5 1.5 1.5 2.5 2.5 3 0-2 1-4 2-5 .5 2 2 3.5 2 5.5a5 5 0 001.5-2c1-1.5 1.5-4 .5-6C18 7.5 14.5 5.5 12 2z" />
              </svg>
            </div>
            <span className="hidden font-display font-bold text-xl text-slate-900 tracking-tight sm:inline">
              IbateXas
            </span>
          </Link>

          {/* Nav */}
          <nav className="hidden gap-6 sm:flex">
            <Link
              href={"/search"}
              className="text-sm font-medium text-slate-600 hover:text-brand-500 transition-colors duration-250"
            >
              {t("nav.shop")}
            </Link>
            <Link
              href={"/loja"}
              className="text-sm font-medium text-slate-600 hover:text-brand-500 transition-colors duration-250"
            >
              {t("nav.loja")}
            </Link>
            <Link
              href={"/account/reservations"}
              className="text-sm font-medium text-slate-600 hover:text-brand-500 transition-colors duration-250"
            >
              {t("nav.reservations")}
            </Link>
            {userType === "staff" && (
              <Link
                href={"/admin"}
                className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-600 shadow-glow-brand hover:shadow-glow-brand-lg transition-all duration-250"
              >
                {t("nav.admin")}
              </Link>
            )}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Link
              href={"/search"}
              className="rounded-xl p-2 text-slate-600 hover:bg-smoke-100 hover:text-brand-500 transition-all duration-250"
              aria-label={t("common.search")}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </Link>

            <Link
              href={"/cart"}
              className="relative rounded-xl p-2 text-slate-600 hover:bg-smoke-100 hover:text-brand-500 transition-all duration-250"
              aria-label={t("nav.cart")}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              {cartCount > 0 && (
                <span className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">
                  {cartCount}
                </span>
              )}
            </Link>

            <Link
              href={"/account"}
              className="rounded-xl p-2 text-slate-600 hover:bg-smoke-100 hover:text-brand-500 transition-all duration-250"
              aria-label={t("nav.account")}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </Link>
          </div>
        </div>
      </div>
    </header>
  )
}
