'use client'

import { useEffect, useState } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

export type Fetcher = <T = unknown>(endpoint: string) => Promise<T>

export interface AdminHookResult<T> {
  data: T
  loading: boolean
  error: Error | null
}

export interface AdminListResult<T> {
  data: T
  count: number
  loading: boolean
  error: Error | null
}

export interface CreateAdminHookOptions<TRaw, T> {
  select: (raw: TRaw) => T
}

export interface FilterableOptions<TFilters, TRaw, T> {
  buildParams: (filters: TFilters) => URLSearchParams
  select: (raw: TRaw) => { data: T; count: number }
  initialData: T
}

// ── Factory creator ──────────────────────────────────────────────────────────

export function createAdminHookFactory(fetcher: Fetcher) {
  function createAdminHook<T>(endpoint: string): () => AdminHookResult<T | null>
  function createAdminHook<T, TRaw>(endpoint: string, options: CreateAdminHookOptions<TRaw, T>): () => AdminHookResult<T | null>
  function createAdminHook<T, TRaw = T>(
    endpoint: string,
    options?: CreateAdminHookOptions<TRaw, T>,
  ) {
    return function useAdminResource(): AdminHookResult<T | null> {
      const [data, setData] = useState<T | null>(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState<Error | null>(null)

      useEffect(() => {
        setLoading(true)
        fetcher<TRaw>(endpoint)
          .then((res) => {
            setData(options?.select ? options.select(res) : res as unknown as T)
          })
          .catch(setError)
          .finally(() => setLoading(false))
      }, [])

      return { data, loading, error }
    }
  }

  function createAdminListHook<TFilters, TRaw, T>(
    baseEndpoint: string,
    options: FilterableOptions<TFilters, TRaw, T>,
  ) {
    return function useAdminList(filters: TFilters): AdminListResult<T> {
      const [data, setData] = useState<T>(options.initialData)
      const [count, setCount] = useState(0)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState<Error | null>(null)

      const deps = JSON.stringify(filters)

      useEffect(() => {
        const params = options.buildParams(filters)
        setLoading(true)
        fetcher<TRaw>(`${baseEndpoint}?${params}`)
          .then((res) => {
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

  return { createAdminHook, createAdminListHook }
}
