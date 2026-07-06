'use client'

import { useQuery } from '@/lib/useQuery'
import { apiFetch } from '@/lib/api'
import type { SpecialsResponse } from './specials'

/**
 * Fetch today's PUBLIC daily specials (GET /api/specials/today). The endpoint
 * sets a 30s HTTP Cache-Control, so a re-mount is served from cache. Mirrors
 * useBannerText — a thin useQuery over apiFetch.
 */
export function useSpecials() {
  return useQuery<SpecialsResponse>(
    'specials-today',
    (signal) => apiFetch<SpecialsResponse>('/api/specials/today', { signal }),
    [],
  )
}
