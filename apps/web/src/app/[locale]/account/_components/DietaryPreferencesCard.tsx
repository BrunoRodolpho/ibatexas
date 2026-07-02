'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Salad } from 'lucide-react'
import {
  fetchPreferences,
  savePreferences,
  DIETARY_FLAGS,
  type CustomerPreferences,
} from '@/domains/account/preferences'

/**
 * CUS-062 (web view) — dietary-preferences form. Loads the full preference set,
 * lets the customer toggle dietary flags, and saves ALL fields (so the allergen
 * + favorite lists are preserved). Posts through the governed
 * POST /api/me/preferences (kernel-adjudicated).
 */
export function DietaryPreferencesCard(): React.JSX.Element {
  const t = useTranslations('account')
  const [prefs, setPrefs] = useState<CustomerPreferences | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    let alive = true
    fetchPreferences().then((p) => {
      if (alive) setPrefs(p)
    })
    return () => {
      alive = false
    }
  }, [])

  function toggleFlag(flag: string): void {
    setStatus('idle')
    setPrefs((prev) => {
      if (!prev) return prev
      const has = prev.dietaryRestrictions.includes(flag)
      return {
        ...prev,
        dietaryRestrictions: has
          ? prev.dietaryRestrictions.filter((f) => f !== flag)
          : [...prev.dietaryRestrictions, flag],
      }
    })
  }

  async function handleSave(): Promise<void> {
    if (!prefs) return
    setStatus('saving')
    try {
      await savePreferences(prefs)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium">
      <div className="flex items-center gap-2">
        <Salad className="w-4 h-4 text-smoke-400" />
        <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
          {t('preferences')}
        </h2>
      </div>
      <p className="mt-3 text-sm text-smoke-400">{t('dietary_prefs.description')}</p>
      <div className="mt-3 flex flex-col gap-2">
        {DIETARY_FLAGS.map((flag) => (
          <label key={flag} className="flex items-center gap-2 text-sm text-charcoal-700">
            <input
              type="checkbox"
              checked={prefs?.dietaryRestrictions.includes(flag) ?? false}
              disabled={prefs === null || status === 'saving'}
              onChange={() => toggleFlag(flag)}
            />
            {t(`dietary_prefs.flags.${flag}`)}
          </label>
        ))}
      </div>
      <button
        type="button"
        onClick={handleSave}
        disabled={prefs === null || status === 'saving'}
        className="mt-3 inline-block text-sm text-charcoal-700 hover:text-charcoal-900 font-medium transition-micro disabled:opacity-50"
      >
        {status === 'saving' ? t('dietary_prefs.saving') : `${t('dietary_prefs.save')} →`}
      </button>
      {status === 'saved' && <p className="mt-2 text-sm text-brand-600">{t('dietary_prefs.saved')}</p>}
      {status === 'error' && <p className="mt-2 text-sm text-accent-red">{t('dietary_prefs.error')}</p>}
    </div>
  )
}
