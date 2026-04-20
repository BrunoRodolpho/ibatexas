'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { usePathname } from 'next/navigation'
import { Container } from '@/components/atoms'

interface ShopLayoutContentProps {
  readonly children: React.ReactNode
}

const categories = [
  { handle: 'camisetas', label: 'shop.categories.camisetas' },
  { handle: 'acessorios', label: 'shop.categories.acessorios' },
  { handle: 'kits', label: 'shop.categories.kits' },
]

export default function ShopLayoutContent({ children }: ShopLayoutContentProps) {
  const t = useTranslations()
  const pathname = usePathname()

  // PDP routes (`/loja/produto/[id]`) are nested under this layout but own
  // their own page chrome. Skip the category nav and Container wrapper so the
  // PDP renders edge-to-edge without the catalog filter bar bleeding in.
  const isPDP = pathname?.includes('/loja/produto/')
  if (isPDP) {
    return <div className="min-h-screen bg-smoke-50">{children}</div>
  }

  return (
    <div className="min-h-screen bg-smoke-50">
      {/* Header with category navigation — sticky below header */}
      <div className="sticky top-[var(--header-height)] z-10 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200">
        <Container>
          {/* Category Filter Bar — typographic, no pills */}
          <div className="flex gap-6 pt-3 pb-3 overflow-x-auto scrollbar-hide">
            <Link href={"/loja"}>
              <span
                className={`text-xs font-medium uppercase tracking-editorial transition-micro cursor-pointer ${
                  pathname === "/loja"
                    ? "text-charcoal-900 border-b border-charcoal-900 pb-0.5"
                    : "text-smoke-400 hover:text-charcoal-900"
                }`}
              >
                {t('common.all')}
              </span>
            </Link>
            {categories.map((category) => (
              <Link key={category.handle} href={`/loja/${category.handle}`}>
                <span
                  className={`text-xs font-medium uppercase tracking-editorial transition-micro cursor-pointer ${
                    pathname === `/loja/${category.handle}`
                      ? "text-charcoal-900 border-b border-charcoal-900 pb-0.5"
                      : "text-smoke-400 hover:text-charcoal-900"
                  }`}
                >
                  {t(category.label)}
                </span>
              </Link>
            ))}
          </div>
        </Container>
      </div>

      {/* Content — padding-neutral wrapper. Children own their own vertical
          rhythm and width handling, matching the homepage pattern where
          `[locale]/layout.tsx` provides only chrome and each section sets its
          own padding. This prevents double-padding when child pages already
          wrap in `<section><Container className="py-16 lg:py-24">`. */}
      <main>{children}</main>
    </div>
  )
}
