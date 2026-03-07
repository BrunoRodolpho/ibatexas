"use client"

import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api"
import type { ProductDTO } from "@ibatexas/types"

// ── Types ────────────────────────────────────────────────────────────────

export interface Category {
  id: string
  name: string
  handle: string
}

/** Shape the API may return before normalization. */
interface RawProductsResponse {
  items?: ProductDTO[]
  products?: ProductDTO[]
  total?: number
  totalFound?: number
  searchModel?: string
  facetCounts?: Record<string, Array<{ value: string; count: number }>>
}

export interface ProductsResponse {
  items: ProductDTO[]
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

// ── Helpers ──────────────────────────────────────────────────────────────

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

  return `/api/products?${params.toString()}`
}

/** Map the raw API response to our normalized ProductsResponse shape. */
function transformProductResponse(res: RawProductsResponse): ProductsResponse {
  return {
    items: res.items ?? res.products ?? [],
    total: res.total ?? res.totalFound ?? 0,
    searchModel: res.searchModel,
    facetCounts: res.facetCounts,
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────

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
    apiFetch<RawProductsResponse>(endpoint, { signal: controller.signal })
      .then((res) => {
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
  }, [query, tagsKey, limit, productType, categoryHandle, sort, minPrice, maxPrice, minRating, offset, allergensKey, availableNow])

  return { data, loading, error }
}

export function useProductDetail(id: string) {
  const [data, setData] = useState<ProductDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    apiFetch<ProductDTO>(`/api/products/${id}`, { signal: controller.signal })
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
  const [data, setData] = useState<Category[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    apiFetch<{ categories: Category[] }>("/api/categories")
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

function loadRecentlyViewed(): string[] {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * Hook to manage recently viewed products.
 * Uses sessionStorage so the list persists within a tab but resets on close.
 */
export function useRecentlyViewed() {
  const [items, setItems] = useState<string[]>([])

  // Load from sessionStorage on mount
  useEffect(() => {
    setItems(loadRecentlyViewed())
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
