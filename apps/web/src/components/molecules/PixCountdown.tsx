'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Clock } from 'lucide-react'

interface PixCountdownProps {
  /** ISO 8601 timestamp when the PIX QR expires */
  readonly expiresAt: string
  /** Called when countdown hits zero */
  readonly onExpired?: () => void
  readonly className?: string
}

function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export function PixCountdown({ expiresAt, onExpired, className = '' }: PixCountdownProps) {
  const t = useTranslations('payment')
  const [remaining, setRemaining] = useState<number>(() => {
    const diff = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
    return Math.max(0, diff)
  })

  useEffect(() => {
    if (remaining <= 0) {
      onExpired?.()
      return
    }

    const timer = setInterval(() => {
      setRemaining((prev) => {
        const next = prev - 1
        if (next <= 0) {
          clearInterval(timer)
          onExpired?.()
          return 0
        }
        return next
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [remaining <= 0, onExpired])

  if (remaining <= 0) {
    return (
      <span className={`text-xs text-accent-red font-medium ${className}`}>
        {t('pix_expired')}
      </span>
    )
  }

  const isUrgent = remaining <= 120 // < 2 min

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${isUrgent ? 'text-accent-red' : 'text-smoke-600'} ${className}`}>
      <Clock className={`w-3.5 h-3.5 ${isUrgent ? 'animate-pulse' : ''}`} />
      {t('pix_expires_in')} {formatRemaining(remaining)}
    </span>
  )
}
