'use client'

import { useConsentStore } from '@/domains/consent'

export function CookieConsentBanner() {
  const { hasConsented, accept, reject } = useConsentStore()

  if (hasConsented) return null

  return (
    <div className="fixed bottom-0 inset-x-0 z-30 border-t border-smoke-200 bg-smoke-50 px-4 py-3 shadow-lg sm:flex sm:items-center sm:justify-between sm:px-6">
      <p className="text-sm text-charcoal-900">
        Usamos cookies para melhorar sua experiência.{' '}
        <a href="/privacidade" className="underline text-brand-600 hover:text-brand-700">
          Saiba mais
        </a>
      </p>
      <div className="mt-2 flex gap-2 sm:mt-0 sm:ml-4 sm:flex-shrink-0">
        <button
          onClick={reject}
          className="rounded-sm border border-smoke-200 bg-white px-4 py-1.5 text-sm font-medium text-charcoal-900 hover:bg-smoke-100 transition-colors"
        >
          Recusar
        </button>
        <button
          onClick={accept}
          className="rounded-sm bg-brand-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 transition-colors"
        >
          Aceitar
        </button>
      </div>
    </div>
  )
}
