'use client'

/**
 * Recommendations domain — hooks.
 *
 * Data-fetching hooks that connect the frontend to the
 * intelligence API endpoints. Gated behind the `recommendation_engine`
 * feature flag — falls back to empty results when disabled.
 */

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { flag } from '@/domains/experimentation'
import type { HookResult } from '@/domains/shared.types'
import type {
  RecommendedProduct,
  RecommendationsResponse,
  AlsoAddedResponse,
} from './recommendations.types'

const EMPTY: RecommendedProduct[] = []

/**
 * Fetch "Clientes também adicionam" for a product.
 * Works for guests — no auth required.
 *
 * @example
 *   const { data, loading } = useAlsoAdded('prod_123')
 */
export function useAlsoAdded(productId: string | undefined): HookResult<RecommendedProduct[]> {
  const [data, setData] = useState<RecommendedProduct[]>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const enabled = !!productId && flag('recommendation_engine')

  useEffect(() => {
    if (!enabled || !productId) {
      setData(EMPTY) // eslint-disable-line react-hooks/set-state-in-effect -- reset when disabled
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)

    apiFetch<AlsoAddedResponse>(`/api/recommendations/also-added?productId=${encodeURIComponent(productId)}`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setData(res.products)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [enabled, productId])

  return { data, loading, error }
}

/**
 * Fetch personalized recommendations for the current customer.
 * Falls back to global bestsellers for guests.
 *
 * @example
 *   const { data, loading } = useRecommendations(6)
 */
export function useRecommendations(limit = 6): HookResult<RecommendedProduct[]> {
  const [data, setData] = useState<RecommendedProduct[]>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const enabled = flag('recommendation_engine')

  useEffect(() => {
    if (!enabled) {
      setData(EMPTY) // eslint-disable-line react-hooks/set-state-in-effect -- reset when disabled
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)

    apiFetch<RecommendationsResponse>(`/api/recommendations?limit=${limit}`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setData(res.products)
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [enabled, limit])

  return { data, loading, error }
}
