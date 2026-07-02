'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { UserPen } from 'lucide-react'
import { fetchProfile, saveProfile, isValidEmail, type EditableProfile } from '@/domains/account/profile'

/**
 * CUS-061 (web view) — edit name / email. Loads the current profile and saves
 * through the governed POST /api/me/profile (auth + PII scan + 1h rate-limit).
 * The email is validated client-side so the customer never hits a server 400;
 * the rate-limit REFUSE surfaces as the generic error message.
 */
type Status = 'idle' | 'saving' | 'saved' | 'error' | 'invalid'

export function EditProfileCard(): React.JSX.Element {
  const t = useTranslations('account')
  const [profile, setProfile] = useState<EditableProfile | null>(null)
  const [status, setStatus] = useState<Status>('idle')

  useEffect(() => {
    let alive = true
    fetchProfile().then((p) => {
      if (alive) setProfile(p)
    })
    return () => {
      alive = false
    }
  }, [])

  function patch(patchValue: Partial<EditableProfile>): void {
    setStatus('idle')
    setProfile((prev) => (prev ? { ...prev, ...patchValue } : prev))
  }

  async function handleSave(): Promise<void> {
    if (!profile) return
    if (!isValidEmail(profile.email)) {
      setStatus('invalid')
      return
    }
    setStatus('saving')
    try {
      await saveProfile(profile)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }

  const disabled = profile === null || status === 'saving'

  return (
    <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium">
      <div className="flex items-center gap-2">
        <UserPen className="w-4 h-4 text-smoke-400" />
        <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
          {t('edit_profile.title')}
        </h2>
      </div>
      <p className="mt-3 text-sm text-smoke-400">{t('edit_profile.description')}</p>
      <div className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm text-charcoal-700">
          {t('edit_profile.name_label')}
          <input
            type="text"
            value={profile?.name ?? ''}
            disabled={disabled}
            maxLength={120}
            onChange={(e) => patch({ name: e.target.value })}
            className="rounded-sm border border-smoke-200 bg-white p-2 text-sm disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal-700">
          {t('edit_profile.email_label')}
          <input
            type="email"
            value={profile?.email ?? ''}
            disabled={disabled}
            maxLength={254}
            onChange={(e) => patch({ email: e.target.value })}
            className="rounded-sm border border-smoke-200 bg-white p-2 text-sm disabled:opacity-50"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={handleSave}
        disabled={disabled}
        className="mt-3 inline-block text-sm text-charcoal-700 hover:text-charcoal-900 font-medium transition-micro disabled:opacity-50"
      >
        {status === 'saving' ? t('edit_profile.saving') : `${t('edit_profile.save')} →`}
      </button>
      {status === 'saved' && <p className="mt-2 text-sm text-brand-600">{t('edit_profile.saved')}</p>}
      {status === 'invalid' && <p className="mt-2 text-sm text-accent-red">{t('edit_profile.invalid_email')}</p>}
      {status === 'error' && <p className="mt-2 text-sm text-accent-red">{t('edit_profile.error')}</p>}
    </div>
  )
}
