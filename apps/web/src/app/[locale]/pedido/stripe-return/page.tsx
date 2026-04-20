"use client"

import { useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useCartStore } from "@/domains/cart"
import { track, getSessionId } from "@/domains/analytics"

export default function StripeReturnPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const clearCart = useCartStore((s) => s.clearCart)

  useEffect(() => {
    const paymentIntent = searchParams.get("payment_intent")
    const status = searchParams.get("redirect_status")

    if (paymentIntent && status === "succeeded") {
      clearCart()
      track("checkout_completed", {
        orderId: paymentIntent,
        paymentMethod: "card",
        currency: "BRL",
        ibx_session_id: getSessionId(),
      })
      router.replace(`/pedido/${paymentIntent}`)
    } else {
      router.replace("/checkout")
    }
  }, [searchParams, router, clearCart])

  return (
    <div className="min-h-screen bg-smoke-50 flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
