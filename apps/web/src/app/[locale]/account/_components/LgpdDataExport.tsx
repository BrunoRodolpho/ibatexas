'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import { fetchMyData, downloadAsJson } from '@/domains/account/lgpd'

/**
 * CUS-064 — LGPD data-export card. Fetches the customer's data from the
 * complete `GET /api/me/data` API and downloads it as JSON. Read-only.
 */
export function LgpdDataExport(): React.JSX.Element {
  const t = useTranslations('account')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  async function handleExport(): Promise<void> {
    setStatus('loading')
    try {
      const data = await fetchMyData()
      downloadAsJson(data)
      setStatus('idle')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium">
      <div className="flex items-center gap-2">
        <Download className="w-4 h-4 text-smoke-400" />
        <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
          {t('data_export.title')}
        </h2>
      </div>
      <p className="mt-3 text-sm text-smoke-400">{t('data_export.description')}</p>
      <button
        type="button"
        onClick={handleExport}
        disabled={status === 'loading'}
        className="mt-3 inline-block text-sm text-charcoal-700 hover:text-charcoal-900 font-medium transition-micro disabled:opacity-50"
      >
        {status === 'loading' ? t('data_export.loading') : `${t('data_export.button')} →`}
      </button>
      {status === 'error' && (
        <p className="mt-2 text-sm text-accent-red">{t('data_export.error')}</p>
      )}
    </div>
  )
}
