'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'

type Period = 'morning' | 'lunch' | 'afternoon' | 'evening'

function getPeriod(): Period {
  const hour = new Date().getHours()
  if (hour >= 6 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 14) return 'lunch'
  if (hour >= 14 && hour < 18) return 'afternoon'
  return 'evening'
}

export function HomeGreeting() {
  const t = useTranslations('greeting')
  const [period, setPeriod] = useState<Period | null>(null)

  useEffect(() => {
    setPeriod(getPeriod()) // eslint-disable-line react-hooks/set-state-in-effect -- client-only value, avoids hydration mismatch
  }, [])

  if (!period) return null

  return (
    <p className="text-xs text-smoke-400 uppercase tracking-editorial mb-2 animate-fade-in">
      {t(`${period}_title`)}
    </p>
  )
}
