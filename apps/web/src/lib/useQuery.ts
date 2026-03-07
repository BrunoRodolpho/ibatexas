/**
 * Generic data-fetching hook that eliminates boilerplate from useProducts,
 * useProductDetail, useCategories, etc.
 *
 * @example
 *   const { data, loading, error } = useQuery('products', () => apiFetch('/api/products'), [])
 */
'use client'

import { useEffect, useState, useRef } from 'react'

export interface QueryResult<T> {
  data: T | null
  loading: boolean
  error: Error | null
}

export function useQuery<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  { enabled = true }: { enabled?: boolean } = {},
): QueryResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setData(null)
      setError(null)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)

    fetcher(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && mountedRef.current) {
          setData(result)
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return
        if (mountedRef.current) setError(err)
      })
      .finally(() => {
        if (!controller.signal.aborted && mountedRef.current) {
          setLoading(false)
        }
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])

  return { data, loading, error }
}
