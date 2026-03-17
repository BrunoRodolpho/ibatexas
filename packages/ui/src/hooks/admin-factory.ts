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

// ── Standalone effect helpers (avoid nesting >4 levels) ─────────────────────

function fetchResource<T, TRaw>(
  fetcher: Fetcher,
  endpoint: string,
  select: ((raw: TRaw) => T) | undefined,
  setData: (d: T) => void,
  setError: (e: Error) => void,
  setLoading: (l: boolean) => void,
) {
  setLoading(true)
  fetcher<TRaw>(endpoint)
    .then((res) => {
      setData(select ? select(res) : res as unknown as T)
    })
    .catch(setError)
    .finally(() => setLoading(false))
}

interface ListSetters<T> {
  setData: (d: T) => void
  setCount: (c: number) => void
  setError: (e: Error) => void
  setLoading: (l: boolean) => void
}

function fetchList<TFilters, TRaw, T>(
  fetcher: Fetcher,
  baseEndpoint: string,
  filters: TFilters,
  options: FilterableOptions<TFilters, TRaw, T>,
  setters: ListSetters<T>,
) {
  const params = options.buildParams(filters)
  setters.setLoading(true)
  fetcher<TRaw>(`${baseEndpoint}?${params}`)
    .then((res) => {
      const result = options.select(res)
      setters.setData(result.data)
      setters.setCount(result.count)
    })
    .catch(setters.setError)
    .finally(() => setters.setLoading(false))
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
        fetchResource<T, TRaw>(fetcher, endpoint, options?.select, setData, setError, setLoading)
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
        fetchList(fetcher, baseEndpoint, filters, options, { setData, setCount, setError, setLoading })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [deps])

      return { data, count, loading, error }
    }
  }

  return { createAdminHook, createAdminListHook }
}
