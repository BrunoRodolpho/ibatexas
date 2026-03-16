"use client"

import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api"

export function useShippingEstimate(cep?: string) {
  const [data, setData] = useState<{ options: Array<{ service: string; price: number; estimatedDays: number }> } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    // Only fire when CEP is exactly 8 digits
    if (cep?.length !== 8 || !/^\d{8}$/.test(cep)) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    
    apiFetch<{ data: { options: Array<{ service: string; price: number; estimatedDays: number }> } }>(`/api/shipping/estimate?cep=${encodeURIComponent(cep)}`)
      .then((response) => setData(response.data))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [cep])

  return { data, loading, error }
}
