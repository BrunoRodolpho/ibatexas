"use client"

import { Link, usePathname } from "@/i18n/navigation"
import { useTranslations } from "next-intl"
import { useCartStore } from '@/domains/cart'
import { useSessionStore } from '@/domains/session'
import { useUIStore } from '@/domains/ui'
import { useEffect, useRef, useState } from "react"
import { track } from '@/domains/analytics'

export function Header() {
  const t = useTranslations()
  const pathname = usePathname()
  const cartCount = useCartStore((s) => s.items.reduce((sum, i) => sum + i.quantity, 0))
  const userType = useSessionStore((s) => s.userType)
  const openCartDrawer = useUIStore((s) => s.openCartDrawer)

  const isHome = pathname === '/'

  // Nav link active state helper
  const isActive = (href: string) => {
    if (href === '/search') return pathname === '/search' || pathname.startsWith('/search')
    if (href === '/loja') return pathname.startsWith('/loja')
    if (href === '/account/reservations') return pathname.startsWith('/account/reservations')
    return false
  }

  // ── Cart badge bounce animation ─────────────────────────────────
  const [isBouncing, setIsBouncing] = useState(false)
  const prevCountRef = useRef(cartCount)

  useEffect(() => {
    if (cartCount > prevCountRef.current) {
      setIsBouncing(true)
      const timer = setTimeout(() => setIsBouncing(false), 600)
      return () => clearTimeout(timer)
    }
    prevCountRef.current = cartCount
  }, [cartCount])

  const handleCartClick = (e: React.MouseEvent) => {
    e.preventDefault()
    track('cart_drawer_opened', { source: 'header' })
    openCartDrawer()
  }

  return (
    <header className="sticky top-0 z-30 bg-smoke-50/95 backdrop-blur-sm">
      {/* ── Main nav bar — compact, refined ──────────────────── */}
      <div className="border-b border-smoke-150">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
          <div className="flex h-11 items-center justify-between">
            {/* Logo */}
            <Link href="/" className="flex items-center">
              <span className="font-display text-base font-bold tracking-wide text-charcoal-900">
                Ibate<span className="text-brand-500">X</span>as
              </span>
            </Link>

            {/* Nav — compact inline links */}
            <nav className="hidden items-center gap-5 sm:flex">
              {[
                { href: '/search' as const, label: 'nav.shop' },
                { href: '/loja' as const, label: 'nav.loja' },
                { href: '/account/reservations' as const, label: 'nav.reservations' },
              ].map(({ href, label }) => {
                const active = isActive(href)
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`relative text-[11px] font-medium uppercase tracking-[0.08em] transition-colors duration-300 group/nav ${
                      active ? 'text-charcoal-900' : 'text-smoke-400 hover:text-charcoal-700'
                    }`}
                  >
                    {t(label)}
                    <span className={`absolute -bottom-0.5 left-0 h-[1.5px] w-full origin-left bg-charcoal-900 transition-transform duration-300 ${
                      active ? 'scale-x-100' : 'scale-x-0 group-hover/nav:scale-x-100'
                    }`} />
                  </Link>
                )
              })}
              {userType === "staff" && (
                <Link
                  href="/admin"
                  className="text-[11px] font-medium uppercase tracking-[0.08em] text-charcoal-900"
                >
                  {t("nav.admin")}
                </Link>
              )}
            </nav>

            {/* Actions — tight icon row */}
            <div className="flex items-center">
              <Link
                href="/search"
                className="p-2 text-smoke-400 hover:text-charcoal-900 transition-colors duration-300"
                aria-label={t("common.search")}
              >
                <svg className="h-[15px] w-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </Link>

              <button
                onClick={handleCartClick}
                className="relative p-2 text-smoke-400 hover:text-charcoal-900 transition-colors duration-300"
                aria-label={t("nav.cart")}
              >
                <svg className="h-[15px] w-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                {cartCount > 0 && (
                  <span
                    className={`absolute right-0 top-0 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-charcoal-900 text-micro font-semibold text-white transition-transform ${
                      isBouncing ? 'animate-bounce-subtle' : ''
                    }`}
                  >
                    {cartCount}
                  </span>
                )}
              </button>

              <Link
                href="/account"
                className="p-2 text-smoke-400 hover:text-charcoal-900 transition-colors duration-300"
                aria-label={t("nav.account")}
              >
                <svg className="h-[15px] w-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
