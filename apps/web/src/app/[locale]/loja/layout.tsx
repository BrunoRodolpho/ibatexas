'use client'

import { useTranslations, useLocale } from 'next-intl'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Badge } from '@/components/atoms'

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
  const locale = useLocale()
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header with category navigation */}
      <div className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Breadcrumb */}
          <nav className="py-4" aria-label="Breadcrumb">
            <ol className="flex items-center space-x-2 text-sm">
              <li>
                <Link href={`/${locale}`} className="text-gray-500 hover:text-gray-700">
                  Início
                </Link>
              </li>
              <li>
                <svg className="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 111.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                </svg>
              </li>
              <li className="text-gray-900 font-medium">
                {t('nav.loja')}
              </li>
            </ol>
          </nav>

          {/* Category Filter Bar */}
          <div className="flex gap-3 pb-6 overflow-x-auto">
            <Link href={`/${locale}/loja`}>
              <Badge 
                variant={pathname === `/${locale}/loja` ? 'primary' : 'default'}
                className="cursor-pointer"
              >
                Todos
              </Badge>
            </Link>
            {categories.map((category) => (
              <Link key={category.handle} href={`/${locale}/loja/${category.handle}`}>
                <Badge 
                  variant={pathname === `/${locale}/loja/${category.handle}` ? 'primary' : 'default'}
                  className="cursor-pointer"
                >
                  {t(category.label)}
                </Badge>
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