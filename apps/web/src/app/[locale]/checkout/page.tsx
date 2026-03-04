"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useCartStore } from "@/stores/useCartStore"
import { useSessionStore } from "@/stores/useSessionStore"
import { Link } from "@/i18n/navigation"
import { getApiBase } from "@/lib/api"
import { track, getSessionId } from "@/lib/analytics"
import { Heading, Text, Button } from "@/components/atoms"
import Image from "next/image"
import { CheckCircle } from "lucide-react"

function formatPrice(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
}

type PaymentMethod = "pix" | "card" | "cash"
type Stage = "summary" | "payment" | "pix_waiting" | "confirmed"

interface DeliveryEstimate {
  feeInCentavos: number
  estimatedMinutes: number
  message: string
}

interface CheckoutResult {
  orderId?: string
  paymentMethod: string
  pixQrCode?: string
  pixCopyPaste?: string
  clientSecret?: string
  message: string
}

export default function CheckoutPage() {
  const router = useRouter()
  const { items, getTotal, cep, setCep, deliveryFee, estimatedDeliveryMinutes, setDeliveryEstimate, medusaCartId, clearCart } = useCartStore()
  const { customerId, isAuthenticated } = useSessionStore()

  const [stage, setStage] = useState<Stage>("summary")
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("pix")
  const [tipPercent, setTipPercent] = useState(0)
  const [deliveryType, setDeliveryType] = useState<"delivery" | "pickup" | "dine-in">("delivery")
  const [cepInput, setCepInput] = useState(cep ?? "")
  const [deliveryEstimate, setDeliveryEstimateLocal] = useState<DeliveryEstimate | null>(
    deliveryFee != null ? { feeInCentavos: deliveryFee, estimatedMinutes: estimatedDeliveryMinutes ?? 60, message: "" } : null
  )
  const [loadingEstimate, setLoadingEstimate] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CheckoutResult | null>(null)
  const checkoutStartedRef = useRef(false)
  const checkoutCompletedRef = useRef(false)

  const subtotal = getTotal()
  const deliveryFeeAmount = deliveryType === "delivery" ? (deliveryEstimate?.feeInCentavos ?? 0) : 0
  const tipAmount = Math.round(subtotal * tipPercent / 100)
  const total = subtotal + deliveryFeeAmount + tipAmount

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push(`/entrar?next=/checkout`)
    }
  }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Analytics: checkout_started on mount ──────────────────────────────
  useEffect(() => {
    if (checkoutStartedRef.current || items.length === 0) return
    checkoutStartedRef.current = true
    track('checkout_started', {
      cartTotal: subtotal,
      itemCount: items.length,
      deliveryType,
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Analytics: checkout_abandoned on page exit (supplementary signal) ──
  // Primary abandonment = PostHog funnel: checkout_started → checkout_completed drop-off
  // beforeunload is supplementary — fires on SPA navigation (false positives)
  useEffect(() => {
    if (stage === 'confirmed') return
    const handleBeforeUnload = () => {
      if (!checkoutCompletedRef.current) {
        track('checkout_abandoned', { step: stage, cartTotal: total })
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [stage, total])

  if (items.length === 0 && stage === "summary") {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center px-4">
        <div className="text-center">
          <Heading as="h1" variant="h2" className="mb-4">Seu carrinho está vazio</Heading>
          <Link href="/loja" className="text-brand-600 hover:underline text-sm">Continuar comprando →</Link>
        </div>
      </div>
    )
  }

  async function fetchDeliveryEstimate(cepValue: string) {
    if (cepValue.replace(/\D/g, "").length !== 8) return
    setLoadingEstimate(true)
    try {
      const res = await fetch(`${getApiBase()}/api/cart/delivery-estimate?cep=${encodeURIComponent(cepValue)}`, {
        credentials: "include",
      })
      if (res.ok) {
        const data = await res.json() as DeliveryEstimate
        setDeliveryEstimateLocal(data)
        setDeliveryEstimate(data.feeInCentavos, data.estimatedMinutes)
        setCep(cepValue)
        track('checkout_step_completed', { step: 'delivery', cep: cepValue })
      }
    } catch {
      // Non-critical
    } finally {
      setLoadingEstimate(false)
    }
  }

  async function handleCheckout() {
    if (!medusaCartId) {
      setError("Carrinho não encontrado. Por favor, adicione os itens novamente.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getApiBase()}/api/cart/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          cartId: medusaCartId,
          paymentMethod,
          tipInCentavos: tipAmount > 0 ? tipAmount : undefined,
          deliveryCep: deliveryType === "delivery" ? cepInput : undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string }
        throw new Error(data.message ?? "Erro ao processar pagamento.")
      }
      const data = await res.json() as CheckoutResult
      setResult(data)

      // Guarded: fire once per checkout attempt, only when orderId exists
      if (!checkoutCompletedRef.current && data?.orderId) {
        checkoutCompletedRef.current = true
        track('checkout_completed', {
          orderId: data.orderId,
          orderTotal: total,
          itemCount: items.length,
          paymentMethod,
          currency: 'BRL',
          ibx_session_id: getSessionId(),
        })
      }

      if (paymentMethod === "pix") {
        setStage("pix_waiting")
      } else if (paymentMethod === "cash") {
        clearCart()
        setStage("confirmed")
      } else {
        // Card: redirect to Stripe hosted
        if (data.orderId) {
          router.push(`/pedido/${data.orderId}`)
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Erro ao processar pagamento."
      track('checkout_error', {
        step: 'payment',
        errorType: 'checkout_failed',
        errorMessage,
        paymentMethod,
      })
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  if (stage === "confirmed") {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="flex justify-center mb-4">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle className="w-7 h-7 text-green-600" />
            </div>
          </div>
          <Heading as="h1" variant="h2" className="mb-2">Pedido confirmado!</Heading>
          <Text textColor="muted" className="mb-6">{result?.message}</Text>
          {result?.orderId && (
            <Link href={`/pedido/${result.orderId}`} className="text-brand-600 hover:underline text-sm">
              Acompanhar pedido →
            </Link>
          )}
        </div>
      </div>
    )
  }

  if (stage === "pix_waiting") {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <Heading as="h1" variant="h2">Pague via PIX</Heading>
          <Text textColor="muted" variant="small">Escaneie o QR Code abaixo ou copie a chave PIX</Text>
          {result?.pixQrCode && (
            <Image src={result.pixQrCode} alt="QR Code PIX" width={192} height={192} unoptimized className="mx-auto border border-smoke-200 rounded-sm" />
          )}
          {result?.pixCopyPaste && (
            <div className="bg-smoke-100 rounded-sm p-3 text-xs font-mono break-all text-charcoal-700 flex items-center gap-2">
              <span className="flex-1">{result.pixCopyPaste}</span>
              <Button
                variant="tertiary"
                size="sm"
                onClick={() => navigator.clipboard.writeText(result.pixCopyPaste!)}
              >
                Copiar
              </Button>
            </div>
          )}
          <Text variant="small" textColor="muted">O pedido será confirmado automaticamente após o pagamento.</Text>
          {result?.orderId && (
            <Link href={`/pedido/${result.orderId}`} className="block text-sm text-brand-600 hover:underline">
              Acompanhar pedido →
            </Link>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-smoke-50 py-8 px-4">
      <div className="mx-auto max-w-lg space-y-6">
        <Heading as="h1" variant="h1">Finalizar pedido</Heading>

        {/* Cart summary */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-3">Itens</h2>
          {items.map((item) => (
            <div key={item.id} className="flex justify-between text-sm text-charcoal-700">
              <span>{item.quantity}× {item.title}{item.variantTitle ? ` — ${item.variantTitle}` : ""}</span>
              <span>{formatPrice(item.price * item.quantity)}</span>
            </div>
          ))}
          <div className="border-t border-smoke-200 pt-2 mt-2 flex justify-between font-semibold text-charcoal-900">
            <span>Subtotal</span>
            <span>{formatPrice(subtotal)}</span>
          </div>
        </div>

        {/* Delivery type */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">Entrega</h2>
          <div className="flex gap-2">
            {(["delivery", "pickup", "dine-in"] as const).map((type) => (
              <button
                key={type}
                onClick={() => setDeliveryType(type)}
                className={`flex-1 rounded-sm border py-2 text-sm font-medium transition-colors ${deliveryType === type ? "border-brand-600 bg-brand-50 text-brand-700" : "border-smoke-200 text-smoke-400 hover:border-smoke-300"}`}
              >
                {type === "delivery" ? "Delivery" : type === "pickup" ? "Retirar" : "No restaurante"}
              </button>
            ))}
          </div>

          {deliveryType === "delivery" && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="CEP"
                  value={cepInput}
                  onChange={(e) => setCepInput(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  className="flex-1 rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
                <Button
                  onClick={() => fetchDeliveryEstimate(cepInput)}
                  disabled={loadingEstimate || cepInput.length < 8}
                  size="md"
                >
                  {loadingEstimate ? "…" : "Calcular"}
                </Button>
              </div>
              {deliveryEstimate && (
                <p className="text-sm text-charcoal-700">{deliveryEstimate.message} · {formatPrice(deliveryEstimate.feeInCentavos)}</p>
              )}
            </div>
          )}
        </div>

        {/* Gorjeta */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">Gorjeta (opcional)</h2>
          <div className="flex gap-2">
            {[0, 10, 15, 20].map((pct) => (
              <button
                key={pct}
                onClick={() => setTipPercent(pct)}
                className={`flex-1 rounded-sm border py-2 text-sm font-medium transition-colors ${tipPercent === pct ? "border-brand-600 bg-brand-50 text-brand-700" : "border-smoke-200 text-smoke-400 hover:border-smoke-300"}`}
              >
                {pct === 0 ? "Nenhuma" : `${pct}%`}
              </button>
            ))}
          </div>
          {tipPercent > 0 && <p className="text-sm text-charcoal-700">Gorjeta: {formatPrice(tipAmount)}</p>}
        </div>

        {/* Payment method */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">Pagamento</h2>
          <div className="flex gap-2">
            {(["pix", "card", "cash"] as const).map((method) => (
              <button
                key={method}
                onClick={() => setPaymentMethod(method)}
                className={`flex-1 rounded-sm border py-2 text-sm font-medium transition-colors ${paymentMethod === method ? "border-brand-600 bg-brand-50 text-brand-700" : "border-smoke-200 text-smoke-400 hover:border-smoke-300"}`}
              >
                {method === "pix" ? "PIX" : method === "card" ? "Cartão" : "Dinheiro"}
              </button>
            ))}
          </div>
        </div>

        {/* Total */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-2">
          {deliveryFeeAmount > 0 && (
            <div className="flex justify-between text-sm text-smoke-400">
              <span>Taxa de entrega</span><span>{formatPrice(deliveryFeeAmount)}</span>
            </div>
          )}
          {tipAmount > 0 && (
            <div className="flex justify-between text-sm text-smoke-400">
              <span>Gorjeta</span><span>{formatPrice(tipAmount)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-charcoal-900 text-lg border-t border-smoke-200 pt-2">
            <span>Total</span><span>{formatPrice(total)}</span>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <Button
          variant="brand"
          size="lg"
          className="w-full"
          onClick={handleCheckout}
          disabled={loading || (deliveryType === "delivery" && !deliveryEstimate)}
        >
          {loading ? "Processando…" : `Confirmar pedido · ${formatPrice(total)}`}
        </Button>
      </div>
    </div>
  )
}
