'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Star } from 'lucide-react'
import { fetchLoyaltyBalance, STAMPS_FOR_REWARD, type LoyaltyBalance } from '@/domains/account/loyalty'

/**
 * CUS-067 (web view) — read-only loyalty stamp-balance card for the account page.
 * The web sibling of the WhatsApp `fidelidade` shortcut.
 */
export function LoyaltyBalanceCard(): React.JSX.Element {
  const t = useTranslations('account')
  const [balance, setBalance] = useState<LoyaltyBalance | null>(null)

  useEffect(() => {
    let alive = true
    fetchLoyaltyBalance()
      .then((b) => {
        if (alive) setBalance(b)
      })
      .catch(() => {
        /* leave null → the description copy shows */
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium">
      <div className="flex items-center gap-2">
        <Star className="w-4 h-4 text-smoke-400" />
        <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
          {t('loyalty.title')}
        </h2>
      </div>
      <p className="mt-3 text-sm text-smoke-400">
        {balance
          ? balance.stampsNeeded === 0
            ? t('loyalty.reward_ready')
            : t('loyalty.progress', { stamps: balance.stamps, total: STAMPS_FOR_REWARD, needed: balance.stampsNeeded })
          : t('loyalty.description')}
      </p>
    </div>
  )
}
