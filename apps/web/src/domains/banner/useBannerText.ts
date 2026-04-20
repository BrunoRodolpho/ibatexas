'use client'

import { useState, useEffect } from 'react'
import { useQuery } from '@/lib/useQuery'
import { apiFetch } from '@/lib/api'

interface BannerResponse {
  text: string | null
}

const POLL_INTERVAL_MS = 60_000

/**
 * Polls GET /api/banner/text every 60 s.
 * HTTP Cache-Control (30 s) prevents redundant network hits.
 */
export function useBannerText() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return useQuery<BannerResponse>(
    'banner-text',
    (signal) => apiFetch<BannerResponse>('/api/banner/text', { signal }),
    [tick],
  )
}
