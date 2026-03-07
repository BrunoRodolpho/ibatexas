/**
 * Admin resource hook factory.
 *
 * Eliminates the repetitive useState/useEffect/apiFetch pattern
 * that every admin hook follows. Each specific hook becomes a
 * one-liner that provides the endpoint and optional mapper.
 *
 * @example
 *   const useDashboard = createAdminHook<AdminDashboardMetrics>('/api/admin/dashboard')
 */
'use client'

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

export interface AdminHookResult<T> {
  data: T
  loading: boolean
  error: Error | null
}

interface CreateAdminHookOptions<TRaw, T> {
  /** Extract the desired data from the raw API response */
  select?: (raw: TRaw) => T
}

/**
 * Factory: create a simple admin data-fetching hook.
 *
 * Returns a React hook that fetches from `endpoint` on mount,
 * manages loading/error state, and optionally maps the response.
 */
export function createAdminHook<T, TRaw = T>(
  endpoint: string,
  options?: CreateAdminHookOptions<TRaw, T>,
) {
  return function useAdminResource(): AdminHookResult<T | null> {
    const [data, setData] = useState<T | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)

    useEffect(() => {
      setLoading(true)
      apiFetch(endpoint)
        .then((res: TRaw) => {
          setData(options?.select ? options.select(res) : (res as unknown as T))
        })
        .catch(setError)
        .finally(() => setLoading(false))
    }, [])

    return { data, loading, error }
  }
}

interface FilterableOptions<TFilters, TRaw, T> {
  /** Build URLSearchParams from the filters object */
  buildParams: (filters: TFilters) => URLSearchParams
  /** Extract the desired data from the raw API response */
  select: (raw: TRaw) => { data: T; count: number }
}

export interface AdminListResult<T> {
  data: T
  count: number
  loading: boolean
  error: Error | null
}

/**
 * Factory: create a filterable admin list hook with pagination.
 *
 * @example
 *   const useOrders = createAdminListHook<Filters, RawRes, OrderSummary[]>(
 *     '/api/admin/orders',
 *     { buildParams: ..., select: ... },
 *   )
 */
export function createAdminListHook<TFilters, TRaw, T>(
  baseEndpoint: string,
  options: FilterableOptions<TFilters, TRaw, T>,
) {
  return function useAdminList(filters: TFilters): AdminListResult<T | null> {
    const [data, setData] = useState<T | null>(null)
    const [count, setCount] = useState(0)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)

    const deps = JSON.stringify(filters)

    useEffect(() => {
      const params = options.buildParams(filters as TFilters)
      setLoading(true)
      apiFetch(`${baseEndpoint}?${params}`)
        .then((res: TRaw) => {
          const result = options.select(res)
          setData(result.data)
          setCount(result.count)
        })
        .catch(setError)
        .finally(() => setLoading(false))
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deps])

    return { data, count, loading, error }
  }
}
