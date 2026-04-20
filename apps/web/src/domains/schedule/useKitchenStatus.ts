'use client'

import { useState, useEffect } from 'react'
import { useQuery } from '@/lib/useQuery'
import { apiFetch } from '@/lib/api'

export interface KitchenStatus {
  mealPeriod: 'lunch' | 'dinner' | 'closed'
  nextOpenDay: string | null
}

const POLL_INTERVAL_MS = 60_000

/**
 * Polls GET /api/schedule/status every 60 s.
 * HTTP Cache-Control (30 s) prevents redundant network hits.
 */
export function useKitchenStatus() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return useQuery<KitchenStatus>(
    'kitchen-status',
    (signal) => apiFetch<KitchenStatus>('/api/schedule/status', { signal }),
    [tick],
  )
}
