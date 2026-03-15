'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { usePathname } from 'next/navigation'

interface ShopLayoutProps {
  readonly children: React.ReactNode
}

const categories = [
  { handle: 'camisetas', label: 'shop.categories.camisetas' },
  { handle: 'acessorios', label: 'shop.categories.acessorios' },
  { handle: 'kits', label: 'shop.categories.kits' },
]

export default function ShopLayout({ children }: ShopLayoutProps) {
  const t = useTranslations()
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-smoke-50">
      {/* Header with category navigation — sticky below header */}
      <div className="sticky top-[56px] z-10 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6">
          {/* Category Filter Bar — typographic, no pills */}
          <div className="flex gap-6 pt-3 pb-3 overflow-x-auto scrollbar-hide">
            <Link href={"/loja"}>
              <span
                className={`text-xs font-medium uppercase tracking-editorial transition-colors duration-500 ease-luxury cursor-pointer ${
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
                  className={`text-xs font-medium uppercase tracking-editorial transition-colors duration-500 ease-luxury cursor-pointer ${
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
        </div>
      </div>

      {/* Content */}
      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 py-8">
        {children}
      </main>
    </div>
  )
}