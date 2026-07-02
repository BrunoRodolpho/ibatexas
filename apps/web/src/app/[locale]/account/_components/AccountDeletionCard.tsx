'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Trash2 } from 'lucide-react'
import {
  isValidOtp,
  requestDeletionOtp,
  verifyDeletionOtp,
  initiateAccountDeletion,
  cancelAccountDeletion,
  type DeletionStep,
} from '@/domains/account/accountDeletion'

/**
 * CUS-065 (web view) — LGPD account deletion. Walks the built server flow:
 * send-otp → verify-otp (60s window) → initiate-deletion (24h grace DEFER) →
 * cancel-deletion. Every server guard (OTP freshness, brute-force lockout,
 * grace window) stays authoritative; this component only sequences the calls
 * and surfaces pt-BR status copy. Destructive, so it is OTP-gated end-to-end.
 */
export function AccountDeletionCard(): React.JSX.Element {
  const t = useTranslations('account')
  const [step, setStep] = useState<DeletionStep>('idle')
  const [otp, setOtp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<void>, next: DeletionStep): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setStep(next)
    } catch {
      setError(t('delete_account.error'))
    } finally {
      setBusy(false)
    }
  }

  function handleVerify(): void {
    if (!isValidOtp(otp)) {
      setError(t('delete_account.invalid_otp'))
      return
    }
    void run(() => verifyDeletionOtp(otp), 'verified')
  }

  return (
    <div className="rounded-sm shadow-card border border-accent-red/20 bg-smoke-50 p-5 hover:shadow-card-hover transition-premium">
      <div className="flex items-center gap-2">
        <Trash2 className="w-4 h-4 text-accent-red" />
        <h2 className="text-micro font-semibold uppercase tracking-editorial text-accent-red">
          {t('delete_account.title')}
        </h2>
      </div>
      <p className="mt-3 text-sm text-smoke-400">{t('delete_account.description')}</p>

      {step === 'idle' && (
        <button
          type="button"
          onClick={() => run(requestDeletionOtp, 'otp_sent')}
          disabled={busy}
          className="mt-3 inline-block text-sm text-accent-red hover:text-accent-red/80 font-medium transition-micro disabled:opacity-50"
        >
          {busy ? t('delete_account.sending') : `${t('delete_account.start')} →`}
        </button>
      )}

      {step === 'otp_sent' && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-charcoal-700">{t('delete_account.otp_sent')}</p>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otp}
            disabled={busy}
            onChange={(e) => {
              setError(null)
              setOtp(e.target.value)
            }}
            placeholder={t('delete_account.otp_placeholder')}
            className="w-40 rounded-sm border border-smoke-200 bg-white p-2 text-sm tracking-widest disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleVerify}
            disabled={busy}
            className="block text-sm text-accent-red hover:text-accent-red/80 font-medium transition-micro disabled:opacity-50"
          >
            {busy ? t('delete_account.verifying') : `${t('delete_account.verify')} →`}
          </button>
        </div>
      )}

      {step === 'verified' && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-charcoal-700">{t('delete_account.verified')}</p>
          <button
            type="button"
            onClick={() => run(initiateAccountDeletion, 'scheduled')}
            disabled={busy}
            className="block text-sm text-accent-red hover:text-accent-red/80 font-medium transition-micro disabled:opacity-50"
          >
            {busy ? t('delete_account.confirming') : `${t('delete_account.confirm')} →`}
          </button>
        </div>
      )}

      {step === 'scheduled' && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-charcoal-700">{t('delete_account.scheduled')}</p>
          <button
            type="button"
            onClick={() => run(cancelAccountDeletion, 'idle')}
            disabled={busy}
            className="block text-sm text-charcoal-700 hover:text-charcoal-900 font-medium transition-micro disabled:opacity-50"
          >
            {busy ? t('delete_account.canceling') : `${t('delete_account.cancel')} →`}
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-accent-red">{error}</p>}
    </div>
  )
}
