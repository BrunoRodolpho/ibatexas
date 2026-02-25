"use client"

import { Link } from "@/i18n/navigation"
import { useTranslations } from "next-intl"
import { useCartStore, useSessionStore } from "@/stores"

export function Header() {
  const t = useTranslations()
  const cartCount = useCartStore((s) => s.items.reduce((sum, i) => sum + i.quantity, 0))
  const userType = useSessionStore((s) => s.userType)

  return (
    <header className="sticky top-0 z-30 bg-white">
      {/* ── Announcement strip ─────────────────────────────────── */}
      <div className="border-b border-slate-200 bg-slate-900">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
          <p className="py-1.5 text-center text-[11px] font-medium tracking-wide text-slate-300">
            {t("home.announcement")}
          </p>
        </div>
      </div>

      {/* ── Main nav bar ──────────────────────────────────────── */}
      <div className="border-b border-slate-200">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
          <div className="flex h-11 items-center justify-between gap-4">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-1.5">
              <span className="text-[13px] font-bold uppercase tracking-wider text-slate-900">
                IbateXas
              </span>
            </Link>

            {/* Nav — compact inline links */}
            <nav className="hidden items-center gap-1 sm:flex">
              <Link
                href="/search"
                className="rounded px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
              >
                {t("nav.shop")}
              </Link>
              <Link
                href="/loja"
                className="rounded px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
              >
                {t("nav.loja")}
              </Link>
              <Link
                href="/account/reservations"
                className="rounded px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
              >
                {t("nav.reservations")}
              </Link>
              {userType === "staff" && (
                <Link
                  href="/admin"
                  className="rounded bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-slate-800 transition-colors"
                >
                  {t("nav.admin")}
                </Link>
              )}
            </nav>

            {/* Actions — tight icon row */}
            <div className="flex items-center gap-0.5">
              <Link
                href="/search"
                className="rounded p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors"
                aria-label={t("common.search")}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </Link>

              <Link
                href="/cart"
                className="relative rounded p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors"
                aria-label={t("nav.cart")}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                {cartCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-900 text-[9px] font-semibold text-white">
                    {cartCount}
                  </span>
                )}
              </Link>

              <Link
                href="/account"
                className="rounded p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors"
                aria-label={t("nav.account")}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}
