"use client"

import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api"
import type { ProductDTO } from "@ibatexas/types"

// ── Product Hooks ───────────────────────────────────────────────────────

export interface ProductsResponse {
  items: import('@ibatexas/types').ProductDTO[]
  total: number
  searchModel?: string
  facetCounts?: Record<string, Array<{ value: string; count: number }>>
}

interface UseProductsOptions {
  query?: string
  tags?: string[]
  limit?: number
  productType?: "food" | "frozen" | "merchandise"
  categoryHandle?: string
  sort?: string
  minPrice?: number
  maxPrice?: number
  minRating?: number
  offset?: number
  excludeAllergens?: string[]
  availableNow?: boolean
}

/** Build the products API endpoint from filter options. Pure function. */
function buildProductsEndpoint(opts: UseProductsOptions & { limit: number }): string {
  const params = new URLSearchParams()
  if (opts.query) params.set("query", opts.query)
  if (opts.tags?.length) params.set("tags", opts.tags.join(","))
  if (opts.productType) params.set("productType", opts.productType)
  if (opts.categoryHandle) params.set("categoryHandle", opts.categoryHandle)
  if (opts.sort && opts.sort !== "relevance") params.set("sort", opts.sort)
  if (opts.minPrice != null) params.set("minPrice", String(opts.minPrice))
  if (opts.maxPrice != null) params.set("maxPrice", String(opts.maxPrice))
  if (opts.minRating != null) params.set("minRating", String(opts.minRating))
  if (opts.offset != null && opts.offset > 0) params.set("offset", String(opts.offset))
  if (opts.excludeAllergens?.length) params.set("excludeAllergens", opts.excludeAllergens.join(","))
  if (opts.availableNow) params.set("availableNow", "true")
  params.set("limit", String(opts.limit))

  const qs = params.toString()
  return qs ? `/api/products?${qs}` : "/api/products"
}

/** Map the raw API response to our normalized ProductsResponse shape. */
function transformProductResponse(res: Record<string, unknown>): ProductsResponse {
  return {
    items: (res.items ?? res.products ?? []) as ProductDTO[],
    total: (res.total ?? res.totalFound ?? 0) as number,
    searchModel: res.searchModel as string | undefined,
    facetCounts: res.facetCounts as ProductsResponse['facetCounts'],
  }
}

export function useProducts({
  query,
  tags,
  limit = 5,
  productType,
  categoryHandle,
  sort,
  minPrice,
  maxPrice,
  minRating,
  offset,
  excludeAllergens,
  availableNow,
}: UseProductsOptions = {}) {
  const [data, setData] = useState<ProductsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const tagsKey = tags?.join(",") ?? ""
  const allergensKey = excludeAllergens?.join(",") ?? ""

  useEffect(() => {
    const controller = new AbortController()
    const endpoint = buildProductsEndpoint({
      query, tags, limit, productType, categoryHandle,
      sort, minPrice, maxPrice, minRating, offset, excludeAllergens, availableNow,
    })

    setLoading(true)
    apiFetch(endpoint, { signal: controller.signal })
      .then((res: Record<string, unknown>) => {
        if (!controller.signal.aborted) setData(transformProductResponse(res))
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return
        setError(err)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [query, tagsKey, limit, productType, categoryHandle, sort, minPrice, maxPrice, minRating, offset, allergensKey, availableNow, tags, excludeAllergens])

  return { data, loading, error }
}

export function useProductDetail(id: string) {
  const [data, setData] = useState<ProductDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    apiFetch(`/api/products/${id}`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setData(res)
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return
        setError(err)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [id])

  return { data, loading, error }
}

export function useCategories() {
  const [data, setData] = useState<unknown[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    apiFetch("/api/categories")
      .then((res) => setData(res.categories))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  return { data, loading, error }
}

/**
 * Recently viewed products — persisted in sessionStorage.
 * Stores last 10 viewed product IDs for the current browser session.
 */

const STORAGE_KEY = 'ibx_recently_viewed'
const MAX_ITEMS = 10

/**
 * Hook to manage recently viewed products.
 * Uses sessionStorage so the list persists within a tab but resets on close.
 */
export function useRecentlyViewed() {
  const [items, setItems] = useState<string[]>([])

  // Load from sessionStorage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY)
      if (stored) {
        setItems(JSON.parse(stored))
      }
    } catch {
      // Silent fail
    }
  }, [])

  const addProduct = (productId: string) => {
    setItems((prev) => {
      const filtered = prev.filter((id) => id !== productId)
      const updated = [productId, ...filtered].slice(0, MAX_ITEMS)
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
      } catch {
        // Storage full — ignore
      }
      return updated
    })
  }

  const getIds = (exclude?: string) => items.filter((id) => id !== exclude)

  return { items, addProduct, getIds }
}
