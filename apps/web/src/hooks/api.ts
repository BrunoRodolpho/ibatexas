"use client"

import { useEffect, useState } from "react"
import { apiFetch, apiStream } from "@/lib/api"
import { useChatStore, useSessionStore } from "@/stores"
import type { ProductDTO, SearchProductsOutput } from "@ibatexas/types"

// ── Product Hooks ───────────────────────────────────────────────────────

export function useProducts(query?: string, tags?: string[], limit = 5, productType?: "food" | "frozen" | "merchandise", categoryHandle?: string) {
  const [data, setData] = useState<SearchProductsOutput | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const params = new URLSearchParams()
    if (query) params.set("query", query)
    if (tags?.length) params.set("tags", tags.join(","))
    if (productType) params.set("productType", productType)
    if (categoryHandle) params.set("categoryHandle", categoryHandle)
    params.set("limit", String(limit))

    const qs = params.toString()
    const endpoint = qs ? `/api/products?${qs}` : "/api/products"

    setLoading(true)
    apiFetch(endpoint)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false))
  }, [query, tags?.join(","), limit, productType, categoryHandle])

  return { data, loading, error }
}

export function useProductDetail(id: string) {
  const [data, setData] = useState<ProductDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    apiFetch(`/api/products/${id}`)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false))
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

export function useShippingEstimate(cep?: string) {
  const [data, setData] = useState<{ options: Array<{ service: string; price: number; estimatedDays: number }> } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    // Only fire when CEP is exactly 8 digits
    if (!cep || cep.length !== 8 || !/^\d{8}$/.test(cep)) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    
    apiFetch(`/api/shipping/estimate?cep=${cep}`)
      .then((response) => setData(response.data))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [cep])

  return { data, loading, error }
}

// ── Chat Hook ───────────────────────────────────────────────────────────

export function useChat() {
  const addMessage = useChatStore((s) => s.addMessage)
  const updateLastMessage = useChatStore((s) => s.updateLastMessage)
  const setLoading = useChatStore((s) => s.setLoading)
  const setError = useChatStore((s) => s.setError)
  const sessionId = useSessionStore((s) => s.sessionId)

  const sendMessage = async (content: string) => {
    if (!sessionId) {
      setError("Sessão não inicializada")
      return
    }

    // Add user message
    addMessage({
      id: `msg_${Date.now()}_user`,
      role: "user",
      content,
      timestamp: new Date(),
    })

    setLoading(true)
    setError(undefined)

    try {
      // Send message to API
      const response = await apiFetch("/api/chat/messages", {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          message: content,
          channel: "web",
        }),
      })

      // Add empty assistant message to be streamed into
      const assistantId = `msg_${Date.now()}_assistant`
      addMessage({
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: new Date(),
      })

      // Stream response
      await apiStream(`/api/chat/stream/${sessionId}`, (chunk: any) => {
        if (chunk.type === "text_delta") {
          updateLastMessage(chunk.delta)
        } else if (chunk.type === "error") {
          setError(chunk.message)
        } else if (chunk.type === "done") {
          setLoading(false)
        }
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Erro desconhecido"
      setError(errorMsg)
      setLoading(false)
    }
  }

  return { sendMessage }
}
