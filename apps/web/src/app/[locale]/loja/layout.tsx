'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { usePathname } from 'next/navigation'

interface ShopLayoutProps {
  children: React.ReactNode
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
    <div className="min-h-screen bg-white">
      {/* Header with category navigation */}
      <div className="border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Breadcrumb */}
          <nav className="py-3" aria-label="Breadcrumb">
            <ol className="flex items-center space-x-2 text-[13px]">
              <li>
                <Link href={"/"} className="text-slate-400 hover:text-slate-600 transition-colors">
                  {t('common.home')}
                </Link>
              </li>
              <li>
                <svg className="w-3.5 h-3.5 text-slate-300" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 111.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                </svg>
              </li>
              <li className="text-slate-900 font-medium">
                {t('nav.loja')}
              </li>
            </ol>
          </nav>

          {/* Category Filter Bar */}
          <div className="flex gap-2 pb-4 overflow-x-auto">
            <Link href={"/loja"}>
              <span
                className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  pathname === "/loja"
                    ? "bg-slate-900 text-white"
                    : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                }`}
              >
                {t('common.all')}
              </span>
            </Link>
            {categories.map((category) => (
              <Link key={category.handle} href={`/loja/${category.handle}`}>
                <span
                  className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                    pathname === `/loja/${category.handle}`
                      ? "bg-slate-900 text-white"
                      : "bg-slate-50 text-slate-600 hover:bg-slate-100"
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
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  )
}