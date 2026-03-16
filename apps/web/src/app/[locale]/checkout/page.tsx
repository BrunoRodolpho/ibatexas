"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useCartStore } from '@/domains/cart'
import { useSessionStore } from '@/domains/session'
import { Link } from "@/i18n/navigation"
import { getApiBase } from "@/lib/api"
import { track, getSessionId } from '@/domains/analytics'
import { Heading, Text, Button } from "@/components/atoms"
import Image from "next/image"
import { CheckCircle, Lock, ShieldCheck } from "lucide-react"
import { useOrderHistory } from "@/domains/cart/useOrderHistory"

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

function getStageIndex(stage: Stage): number {
  if (stage === "summary") return 0
  if (stage === "confirmed") return 2
  return 1
}

function getStepClasses(isActive: boolean, isPast: boolean): string {
  if (isActive || isPast) return "bg-brand-500 text-white"
  return "bg-smoke-200 text-smoke-400"
}

function getDeliveryTypeLabel(
  type: "delivery" | "pickup" | "dine-in",
  t: (key: string) => string,
): string {
  if (type === "delivery") return t('delivery_type_delivery')
  if (type === "pickup") return t('delivery_type_pickup')
  return t('delivery_type_dinein')
}

function getPaymentMethodLabel(
  method: PaymentMethod,
  t: (key: string) => string,
): string {
  if (method === "pix") return t('pix')
  if (method === "card") return t('card')
  return t('cash')
}

export default function CheckoutPage() {
  const t = useTranslations('checkout')
  const tCart = useTranslations('cart')
  const router = useRouter()
  const { items, getTotal, cep, setCep, deliveryFee, estimatedDeliveryMinutes, setDeliveryEstimate, medusaCartId, clearCart } = useCartStore()
  const { customerId, isAuthenticated } = useSessionStore()
  const { saveOrder } = useOrderHistory()

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

  // ── Auto-calculate CEP on 8 digits ──────────────────────────────────
  useEffect(() => {
    const digits = cepInput.replaceAll(/\D/g, "")
    if (digits.length === 8 && deliveryType === "delivery" && !loadingEstimate) {
      const timer = setTimeout(() => fetchDeliveryEstimate(digits), 500)
      return () => clearTimeout(timer)
    }
  }, [cepInput, deliveryType]) // eslint-disable-line react-hooks/exhaustive-deps

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
    globalThis.addEventListener('beforeunload', handleBeforeUnload)
    return () => globalThis.removeEventListener('beforeunload', handleBeforeUnload)
  }, [stage, total])

  if (items.length === 0 && stage === "summary") {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center px-4">
        <div className="text-center">
          <Heading as="h1" variant="h2" className="mb-4">{t('empty_cart')}</Heading>
          <Link href="/loja" className="text-brand-600 hover:underline text-sm">{t('continue_shopping')}</Link>
        </div>
      </div>
    )
  }

  async function fetchDeliveryEstimate(cepValue: string) {
    if (cepValue.replaceAll(/\D/g, "").length !== 8) return
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
      setError(t('cart_not_found'))
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
        throw new Error(data.message ?? t('payment_error'))
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

        // Persist last order for reorder card
        saveOrder({
          items: items.map((item) => ({
            productId: item.productId,
            title: item.title,
            price: item.price,
            imageUrl: item.imageUrl ?? undefined,
            quantity: item.quantity,
            variantId: item.variantId ?? undefined,
            variantTitle: item.variantTitle ?? undefined,
          })),
          total,
          orderId: data.orderId,
          date: new Date().toISOString(),
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
      const errorMessage = err instanceof Error ? err.message : t('payment_error')
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
            <div className="w-14 h-14 rounded-full bg-accent-green/10 flex items-center justify-center">
              <CheckCircle className="w-7 h-7 text-accent-green" />
            </div>
          </div>
          <Heading as="h1" variant="h2" className="mb-2">{t('order_confirmation')}</Heading>
          <Text textColor="muted" className="mb-6">{result?.message}</Text>
          {result?.orderId && (
            <Link href={`/pedido/${result.orderId}`} className="text-brand-600 hover:underline text-sm">
              {t('track_order')}
            </Link>
          )}
          {process.env.NEXT_PUBLIC_WHATSAPP_URL && (
            <a
              href={`${process.env.NEXT_PUBLIC_WHATSAPP_URL}?text=${encodeURIComponent(`${t('whatsapp_order_msg')} ${result?.orderId ? `#${result.orderId}` : ''}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-2 text-sm text-accent-green hover:underline"
            >
              {t('whatsapp_track')}
            </a>
          )}
        </div>
      </div>
    )
  }

  if (stage === "pix_waiting") {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <Heading as="h1" variant="h2">{t('pix_title')}</Heading>
          <Text textColor="muted" variant="small">{t('pix_subtitle')}</Text>
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
                {t('pix_copy')}
              </Button>
            </div>
          )}
          <Text variant="small" textColor="muted">{t('pix_auto_confirm')}</Text>
          {result?.orderId && (
            <Link href={`/pedido/${result.orderId}`} className="block text-sm text-brand-600 hover:underline">
              {t('track_order')}
            </Link>
          )}
        </div>
      </div>
    )
  }

  const stepLabels = [t('step_summary'), t('step_payment'), t('step_confirmation')]

  return (
    <div className="min-h-screen bg-smoke-50 py-8 px-4">
      <div className="mx-auto max-w-lg space-y-6">
        <Heading as="h1" variant="h1">{t('title')}</Heading>

        {/* ── Progress indicator ─────────────────────────────────────── */}
        <div className="flex items-center justify-between max-w-xs mx-auto">
          {(["summary", "payment", "confirmed"] as const).map((step, i) => {
            const stageIndex = getStageIndex(stage)
            const isActive = i === stageIndex
            const isPast = i < stageIndex
            return (
              <div key={step} className="flex items-center">
                {i > 0 && (
                  <div className={`w-8 h-px mx-1 ${isPast ? "bg-brand-500" : "bg-smoke-200"}`} />
                )}
                <div className="flex flex-col items-center gap-1">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold transition-colors ${getStepClasses(isActive, isPast)}`}>
                    {isPast ? "✓" : i + 1}
                  </div>
                  <span className={`text-[10px] ${isActive ? "text-brand-600 font-semibold" : "text-smoke-400"}`}>
                    {stepLabels[i]}
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        {/* Cart summary */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-3">{t('items_label')}</h2>
          {items.map((item) => (
            <div key={item.id} className="flex justify-between text-sm text-charcoal-700">
              <span>{item.quantity}× {item.title}{item.variantTitle ? ` — ${item.variantTitle}` : ""}</span>
              <span>{formatPrice(item.price * item.quantity)}</span>
            </div>
          ))}
          <div className="border-t border-smoke-200 pt-2 mt-2 flex justify-between font-semibold text-charcoal-900">
            <span>{tCart('subtotal')}</span>
            <span>{formatPrice(subtotal)}</span>
          </div>
        </div>

        {/* Delivery type */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">{t('delivery_label')}</h2>
          <div className="flex gap-2">
            {(["delivery", "pickup", "dine-in"] as const).map((type) => (
              <button
                key={type}
                onClick={() => setDeliveryType(type)}
                className={`flex-1 rounded-sm border py-2 text-sm font-medium transition-colors ${deliveryType === type ? "border-brand-600 bg-brand-50 text-brand-700" : "border-smoke-200 text-smoke-400 hover:border-smoke-300"}`}
              >
                {getDeliveryTypeLabel(type, t)}
              </button>
            ))}
          </div>

          {deliveryType === "delivery" && (
            <div className="space-y-2">
              <div className="relative">
                <input
                  type="text"
                  placeholder={t('cep_placeholder')}
                  value={cepInput}
                  onChange={(e) => setCepInput(e.target.value.replaceAll(/\D/g, "").slice(0, 8))}
                  className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
                {loadingEstimate && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
              </div>
              {deliveryEstimate && (
                <p className="text-sm text-charcoal-700">{deliveryEstimate.message} · {formatPrice(deliveryEstimate.feeInCentavos)}</p>
              )}
            </div>
          )}
        </div>

        {/* Gorjeta */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">{t('tip_label')}</h2>
          <div className="flex gap-2">
            {[0, 10, 15, 20].map((pct) => (
              <button
                key={pct}
                onClick={() => setTipPercent(pct)}
                className={`flex-1 rounded-sm border py-2 text-sm font-medium transition-colors ${tipPercent === pct ? "border-brand-600 bg-brand-50 text-brand-700" : "border-smoke-200 text-smoke-400 hover:border-smoke-300"}`}
              >
                {pct === 0 ? t('tip_none') : `${pct}%`}
              </button>
            ))}
          </div>
          {tipPercent > 0 && <p className="text-sm text-charcoal-700">{t('tip_value', { value: formatPrice(tipAmount) })}</p>}
        </div>

        {/* Payment method */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">{t('payment_label')}</h2>
          <div className="flex gap-2">
            {(["pix", "card", "cash"] as const).map((method) => (
              <button
                key={method}
                onClick={() => setPaymentMethod(method)}
                className={`flex-1 rounded-sm border py-2 text-sm font-medium transition-colors ${paymentMethod === method ? "border-brand-600 bg-brand-50 text-brand-700" : "border-smoke-200 text-smoke-400 hover:border-smoke-300"}`}
              >
                {getPaymentMethodLabel(method, t)}
              </button>
            ))}
          </div>
        </div>

        {/* Total */}
        <div className="bg-smoke-50 border border-smoke-200 rounded-sm p-5 space-y-2">
          {deliveryFeeAmount > 0 && (
            <div className="flex justify-between text-sm text-smoke-400">
              <span>{t('fee_delivery')}</span><span>{formatPrice(deliveryFeeAmount)}</span>
            </div>
          )}
          {tipAmount > 0 && (
            <div className="flex justify-between text-sm text-smoke-400">
              <span>{t('fee_tip')}</span><span>{formatPrice(tipAmount)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-charcoal-900 text-lg border-t border-smoke-200 pt-2">
            <span>{t('total')}</span><span>{formatPrice(total)}</span>
          </div>
        </div>

        {error && <p className="text-sm text-accent-red">{error}</p>}

        {/* Trust badges */}
        <div className="flex items-center justify-center gap-6 text-smoke-400">
          <div className="flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" />
            <span className="text-xs">{t('trust_secure')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span className="text-xs">{t('trust_guarantee')}</span>
          </div>
        </div>

        <Button
          variant="brand"
          size="lg"
          className="w-full"
          onClick={handleCheckout}
          disabled={loading || (deliveryType === "delivery" && !deliveryEstimate)}
        >
          {loading ? t('processing') : t('confirm_order', { total: formatPrice(total) })}
        </Button>
      </div>
    </div>
  )
}
