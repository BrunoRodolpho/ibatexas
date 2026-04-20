"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { loadStripe } from "@stripe/stripe-js"
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js"
import { useCartStore, hasKitchenOnlyFood, getKitchenItems } from '@/domains/cart'
import { useSessionStore } from '@/domains/session'
import { useKitchenStatus } from '@/domains/schedule'
import { Link } from "@/i18n/navigation"
import { getApiBase } from "@/lib/api"
import { formatBRL } from '@/lib/format'
import { track, getSessionId } from '@/domains/analytics'
import { Heading, Text, Button, Checkbox, ErrorBoundary, Container, ScrollReveal } from "@/components/atoms"
import { KitchenClosedBanner } from "@/components/molecules/KitchenClosedBanner"
import Image from "next/image"
import { Flame, Lock, ShieldCheck } from "lucide-react"
import { useOrderHistory } from "@/domains/cart/useOrderHistory"
import InlineCardInput from "./_components/InlineCardInput"

const stripePromise = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
  : null

type PaymentMethod = "pix" | "card" | "cash"
type Stage = "checkout" | "pix_waiting" | "confirmed"

interface DeliveryEstimate {
  feeInCentavos: number
  estimatedMinutes: number
  message: string
  isLocalZone?: boolean
}

interface CheckoutResult {
  orderId?: string
  paymentMethod: string
  pixQrCode?: string
  pixCopyPaste?: string
  stripeClientSecret?: string
  message: string
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

// ── Inner checkout form (needs Stripe hooks) ─────────────────────────────────

function CheckoutForm() {
  const t = useTranslations('checkout')
  const tCart = useTranslations('cart')
  const router = useRouter()
  const stripe = useStripe()
  const elements = useElements()
  const { items, getTotal, cep, setCep, deliveryFee, estimatedDeliveryMinutes, setDeliveryEstimate: persistDeliveryEstimate, medusaCartId, setMedusaCartId, clearCart, termsAccepted, setTermsAccepted, removeItem } = useCartStore()
  const { customerId, isAuthenticated } = useSessionStore()
  const { saveOrder } = useOrderHistory()
  const { data: kitchenStatus } = useKitchenStatus()
  const isKitchenClosed = kitchenStatus?.mealPeriod === 'closed'
  const cartHasKitchenFood = hasKitchenOnlyFood(items)
  const kitchenItems = getKitchenItems(items)

  const [stage, setStage] = useState<Stage>("checkout")
  const [notes, setNotes] = useState("")
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("pix")
  const [tipPercent, setTipPercent] = useState(0)
  const [deliveryType, setDeliveryType] = useState<"delivery" | "pickup" | "dine-in">("delivery")
  const [cepInput, setCepInput] = useState(cep ?? "")
  const [deliveryEstimate, setDeliveryEstimate] = useState<DeliveryEstimate | null>(
    deliveryFee == null ? null : { feeInCentavos: deliveryFee, estimatedMinutes: estimatedDeliveryMinutes ?? 60, message: "" }
  )
  const [loadingEstimate, setLoadingEstimate] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CheckoutResult | null>(null)
  const checkoutStartedRef = useRef(false)
  const checkoutCompletedRef = useRef(false)
  const [pixName, setPixName] = useState("")
  const [pixEmail, setPixEmail] = useState("")
  const [pixCpf, setPixCpf] = useState("")
  const [pixCpfMasked, setPixCpfMasked] = useState(false)
  const [deliveryError, setDeliveryError] = useState<string | null>(null)
  const pixDetailsFetched = useRef(false)

  const subtotal = getTotal()
  const deliveryFeeAmount = deliveryType === "delivery" ? (deliveryEstimate?.feeInCentavos ?? 0) : 0
  const tipAmount = Math.round(subtotal * tipPercent / 100)
  const total = subtotal + deliveryFeeAmount + tipAmount

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push(`/entrar?next=/checkout`)
    }
  }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Kitchen closed: auto-switch from pickup/dine-in to delivery ──────
  useEffect(() => {
    if (isKitchenClosed && (deliveryType === 'pickup' || deliveryType === 'dine-in')) {
      setDeliveryType('delivery')
    }
  }, [isKitchenClosed, deliveryType])

  // ── Kitchen closed: track + remove helper ──────────────────────────────
  const kitchenBannerTrackedRef = useRef(false)
  useEffect(() => {
    if (isKitchenClosed && cartHasKitchenFood && !kitchenBannerTrackedRef.current) {
      kitchenBannerTrackedRef.current = true
      track('kitchen_closed_checkout_blocked', { kitchenItemCount: kitchenItems.length })
    }
  }, [isKitchenClosed, cartHasKitchenFood, kitchenItems.length])

  const handleRemoveKitchenItems = () => {
    for (const item of kitchenItems) {
      removeItem(item.id)
    }
    track('kitchen_closed_items_removed', { count: kitchenItems.length })
  }

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

  // ── Analytics: checkout_abandoned on page exit ──
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

  // ── Load cached PIX details for authenticated customers ──────────────
  useEffect(() => {
    if (paymentMethod !== "pix" || !isAuthenticated() || pixDetailsFetched.current) return
    pixDetailsFetched.current = true
    fetch(`${getApiBase()}/api/cart/pix-details`, { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<{ name?: string; email?: string; cpf?: string }> : null)
      .then((data) => {
        if (data?.name && !pixName) setPixName(data.name)
        if (data?.email && !pixEmail) setPixEmail(data.email)
        if (data?.cpf && !pixCpf) {
          setPixCpf(formatCpf(data.cpf))
          setPixCpfMasked(true)
        }
      })
      .catch(() => { /* non-critical */ })
  }, [paymentMethod]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch from cash when entering shipping mode
  const isShippingFlag = deliveryType === 'delivery' && deliveryEstimate?.isLocalZone === false
  useEffect(() => {
    if (isShippingFlag && paymentMethod === 'cash') {
      setPaymentMethod('pix')
    }
  }, [isShippingFlag, paymentMethod])

  if (items.length === 0 && stage === "checkout") {
    return (
      <div className="min-h-screen bg-smoke-50 flex items-center justify-center px-4">
        <div className="text-center">
          <Heading as="h1" variant="h2" className="mb-4">{t('empty_cart')}</Heading>
          <Link href="/search" className="text-brand-600 hover:underline text-sm">{t('continue_shopping')}</Link>
        </div>
      </div>
    )
  }

  // Cart composition flags
  const hasFoodItems = items.some(i => i.productType === 'food')
  const hasFrozenItems = items.some(i => i.productType === 'frozen')
  const isMerchandiseOnly = items.length > 0 && items.every(i => i.productType === 'merchandise')
  const isShipping = isShippingFlag

  async function fetchDeliveryEstimate(cepValue: string) {
    if (cepValue.replaceAll(/\D/g, "").length !== 8) return
    setLoadingEstimate(true)
    setDeliveryError(null)
    try {
      const res = await fetch(`${getApiBase()}/api/cart/delivery-estimate?cep=${encodeURIComponent(cepValue)}`, {
        credentials: "include",
      })
      if (res.ok) {
        const data = await res.json() as DeliveryEstimate
        setDeliveryEstimate({ ...data, isLocalZone: true })
        persistDeliveryEstimate(data.feeInCentavos, data.estimatedMinutes)
        setCep(cepValue)
        track('checkout_step_completed', { step: 'delivery', cep: cepValue })
      } else if (isMerchandiseOnly) {
        // Merchandise-only: allow shipping outside delivery zone
        setDeliveryEstimate({ feeInCentavos: 0, estimatedMinutes: 0, message: '', isLocalZone: false })
        persistDeliveryEstimate(0, 0)
        setCep(cepValue)
      } else if (hasFrozenItems && !hasFoodItems) {
        // Frozen items cannot be shipped — specific error
        setDeliveryEstimate(null)
        setDeliveryError(t('delivery_shipping_frozen_blocked'))
      } else {
        setDeliveryEstimate(null)
        setDeliveryError(t('delivery_out_of_zone'))
      }
    } catch {
      setDeliveryError(t('delivery_estimate_error'))
    } finally {
      setLoadingEstimate(false)
    }
  }

  function formatCpf(value: string): string {
    const digits = value.replace(/\D/g, "").slice(0, 11)
    if (digits.length <= 3) return digits
    if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`
    if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`
  }

  function isValidCpf(cpf: string): boolean {
    const digits = cpf.replace(/\D/g, "")
    if (digits.length !== 11) return false
    if (/^(\d)\1+$/.test(digits)) return false
    let sum = 0
    for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i)
    let check = 11 - (sum % 11)
    if (check >= 10) check = 0
    if (check !== Number(digits[9])) return false
    sum = 0
    for (let i = 0; i < 10; i++) sum += Number(digits[i]) * (11 - i)
    check = 11 - (sum % 11)
    if (check >= 10) check = 0
    return check === Number(digits[10])
  }

  const pixFieldsValid = paymentMethod !== "pix" || (
    pixName.trim().split(/\s+/).length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pixEmail) &&
    isValidCpf(pixCpf)
  )

  async function handleCheckout() {
    setLoading(true)
    setError(null)
    try {
      // Fallback: create Medusa cart if needed
      let cartId = medusaCartId
      if (!cartId) {
        try {
          const createRes = await fetch(`${getApiBase()}/api/cart`, {
            method: "POST",
            credentials: "include",
          })
          if (createRes.ok) {
            const createData = await createRes.json() as { cart?: { id: string } }
            if (createData.cart?.id) {
              cartId = createData.cart.id
              setMedusaCartId(cartId)
            }
          }
        } catch {
          // fall through to error below
        }
      }
      if (!cartId) {
        setError(t('cart_not_found'))
        setLoading(false)
        return
      }

      const res = await fetch(`${getApiBase()}/api/cart/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          cartId,
          paymentMethod,
          deliveryType: isShipping ? 'shipping' : deliveryType === 'dine-in' ? 'dine_in' : deliveryType,
          tipInCentavos: tipAmount > 0 ? tipAmount : undefined,
          deliveryCep: deliveryType === "delivery" ? cepInput : undefined,
          notes: notes.trim() || undefined,
          items: items.filter((i) => i.variantId).map((i) => ({ variantId: i.variantId!, quantity: i.quantity, productType: i.productType })),
          ...(paymentMethod === "pix" ? {
            pixName: pixName.trim() || undefined,
            pixEmail: pixEmail.trim() || undefined,
            pixCpf: pixCpf.replace(/\D/g, "") || undefined,
          } : {}),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string }
        throw new Error(data.message ?? t('payment_error'))
      }
      const data = await res.json() as CheckoutResult
      setResult(data)

      // ── PIX ──
      if (paymentMethod === "pix") {
        clearCart()
        setStage("pix_waiting")
        return
      }

      // ── Cash ──
      if (paymentMethod === "cash") {
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
        clearCart()
        setStage("confirmed")
        return
      }

      // ── Card: confirm payment inline ──
      if (paymentMethod === "card" && data.stripeClientSecret) {
        if (!stripe || !elements) {
          setError(t('stripe_unavailable'))
          return
        }
        const cardElement = elements.getElement(CardElement)
        if (!cardElement) {
          setError(t('payment_error'))
          return
        }

        const { error: stripeError, paymentIntent } = await stripe.confirmCardPayment(
          data.stripeClientSecret,
          { payment_method: { card: cardElement } }
        )

        if (stripeError) {
          setError(stripeError.message ?? t('payment_error'))
          return
        }

        if (paymentIntent && paymentIntent.status === "succeeded") {
          checkoutCompletedRef.current = true
          track('checkout_completed', {
            orderId: paymentIntent.id,
            orderTotal: total,
            itemCount: items.length,
            paymentMethod: 'card',
            currency: 'BRL',
            ibx_session_id: getSessionId(),
          })
          clearCart()
          router.push(`/pedido/${paymentIntent.id}`)
          return
        }

        // 3DS: Stripe handles the redirect automatically
        // The stripe-return page handles the callback
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

  // ── Confirmed screen — brand ceremony ───────────────────────────────────
  if (stage === "confirmed") {
    return (
      <div className="min-h-screen bg-charcoal-900 grain-overlay flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          {/* Flame icon — brand mark at the emotional peak (smoke-reveal signature) */}
          <ScrollReveal animation="smoke-reveal" delay={0}>
            <div className="flex justify-center mb-6">
              <div className="w-16 h-16 rounded-full bg-brand-500/10 flex items-center justify-center">
                <Flame className="w-8 h-8 text-brand-500" strokeWidth={1.5} />
              </div>
            </div>
          </ScrollReveal>

          {/* Title — dramatic reveal */}
          <ScrollReveal animation="fade-up" delay={200}>
            <Heading as="h1" className="font-display text-display-sm text-smoke-50 mb-3">
              {t('order_confirmation')}
            </Heading>
          </ScrollReveal>

          {/* Mythology copy — smoke clears to reveal the brand manifesto */}
          <ScrollReveal animation="smoke-reveal" delay={400}>
            <Text className="font-display italic text-smoke-300 text-lg leading-relaxed mb-8 max-w-xs mx-auto">
              {t('order_confirmed_mythology')}
            </Text>
          </ScrollReveal>

          {/* Actions */}
          <ScrollReveal animation="fade-up" delay={600}>
            <div className="space-y-3">
              {result?.orderId && (
                <Link href={`/pedido/${result.orderId}`} className="text-brand-400 hover:text-brand-300 text-sm transition-colors duration-[200ms] ease-luxury">
                  {t('order_confirmed_subtitle')} →
                </Link>
              )}
              {process.env.NEXT_PUBLIC_WHATSAPP_URL && (() => {
                const orderSuffix = result?.orderId ? " #" + result.orderId : ""
                const whatsappMsg = t('whatsapp_order_msg') + orderSuffix
                const whatsappHref = process.env.NEXT_PUBLIC_WHATSAPP_URL + "?text=" + encodeURIComponent(whatsappMsg)
                return (
                  <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-2 text-sm text-smoke-400 hover:text-smoke-200 transition-colors duration-[200ms] ease-luxury"
                  >
                    {t('whatsapp_track')}
                  </a>
                )
              })()}
            </div>
          </ScrollReveal>
        </div>
      </div>
    )
  }

  // ── PIX waiting screen — atmospheric anticipation ──────────────────────
  if (stage === "pix_waiting") {
    return (
      <div className="min-h-screen bg-charcoal-900 grain-overlay flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center space-y-5">
          <ScrollReveal animation="smoke-reveal" delay={0}>
            <Heading as="h1" className="font-display text-display-xs text-smoke-50">{t('pix_title')}</Heading>
            <Text className="mt-2 text-smoke-400 text-sm">{t('pix_subtitle')}</Text>
          </ScrollReveal>

          {result?.pixQrCode && (
            <ScrollReveal animation="scale-up" delay={200}>
              <div className="animate-pulse-once">
                <Image src={result.pixQrCode} alt="QR Code PIX" width={192} height={192} unoptimized className="mx-auto bg-white rounded-sm shadow-elevated p-2" />
              </div>
            </ScrollReveal>
          )}

          {result?.pixCopyPaste && (
            <ScrollReveal animation="fade-up" delay={400}>
              <div className="bg-charcoal-800 rounded-sm p-3 text-xs font-mono break-all text-smoke-200 flex items-center gap-2">
                <span className="flex-1">{result.pixCopyPaste}</span>
                <Button
                  variant="tertiary"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(result.pixCopyPaste!)}
                >
                  {t('pix_copy')}
                </Button>
              </div>
            </ScrollReveal>
          )}

          <ScrollReveal animation="fade-up" delay={600}>
            <Text className="font-display italic text-smoke-400 text-sm">{t('pix_auto_confirm')}</Text>
            {result?.orderId && (
              <Link href={`/pedido/${result.orderId}`} className="mt-3 block text-sm text-brand-400 hover:text-brand-300 transition-colors duration-[200ms] ease-luxury">
                {t('track_order')}
              </Link>
            )}
          </ScrollReveal>
        </div>
      </div>
    )
  }

  // ── Main checkout page (single page) ───────────────────────────────────
  return (
    <ErrorBoundary>
    <div className="min-h-screen bg-smoke-100 py-12 lg:py-16">
      <Container size="narrow" className="space-y-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Flame className="w-4 h-4 text-brand-500 flex-shrink-0" strokeWidth={1.5} />
            <div className="h-px flex-1 bg-smoke-200/60" />
          </div>
          <Heading as="h1" variant="h1">{t('title')}</Heading>
        </div>

        {/* Step indicator */}
        <nav aria-label="Checkout steps" className="flex items-center justify-center gap-0">
          {[
            { num: 1, label: t('step_delivery', { fallback: 'Entrega' }), active: true },
            { num: 2, label: t('step_payment', { fallback: 'Pagamento' }), active: true },
            { num: 3, label: t('step_confirmation', { fallback: 'Confirmação' }), active: false },
          ].map((step, i) => (
            <div key={step.num} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                    step.active
                      ? "bg-brand-500 text-white"
                      : "bg-smoke-200 text-smoke-400"
                  }`}
                >
                  {step.num}
                </div>
                <span className={`text-xs mt-1 ${step.active ? "text-charcoal-700" : "text-smoke-400"}`}>
                  {step.label}
                </span>
              </div>
              {i < 2 && (
                <div
                  className={`w-10 h-0.5 mx-1 mb-4 ${
                    i === 0 ? "bg-brand-500" : "bg-smoke-200"
                  }`}
                />
              )}
            </div>
          ))}
        </nav>

        {/* Kitchen closed banner */}
        {isKitchenClosed && cartHasKitchenFood && kitchenStatus?.nextOpenDay && (
          <KitchenClosedBanner
            nextOpenDay={kitchenStatus.nextOpenDay}
            kitchenItems={kitchenItems}
            onRemoveKitchenItems={items.length > kitchenItems.length ? handleRemoveKitchenItems : undefined}
          />
        )}

        {/* Cart summary */}
        <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-6 space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-3">{t('items_label')}</h2>
          {items.map((item) => {
            const isUnavailable = isKitchenClosed && item.productType === 'food'
            return (
              <div key={item.id} className={`flex justify-between text-sm ${isUnavailable ? 'text-smoke-400 line-through' : 'text-charcoal-700'}`}>
                <span>{item.quantity}&times; {item.title}{item.variantTitle ? ` — ${item.variantTitle}` : ""}{isUnavailable ? ` (${tCart('item_unavailable').toLowerCase()})` : ""}</span>
                <span className="tabular-nums">{formatBRL(item.price * item.quantity)}</span>
              </div>
            )
          })}
          <div className="border-t border-smoke-200 pt-3 mt-3 flex justify-between font-semibold text-charcoal-900">
            <span>{tCart('subtotal')}</span>
            <span className="tabular-nums">{formatBRL(subtotal)}</span>
          </div>
        </div>

        {/* Delivery type */}
        <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-6 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">{t('delivery_label')}</h2>
          <div className="flex gap-2" role="radiogroup" aria-label={t('delivery_label')}>
            {(["delivery", "pickup", "dine-in"] as const)
              .filter((type) => {
                // Dine-in only for carts with food items
                if (type === 'dine-in' && !hasFoodItems) return false
                return true
              })
              .map((type) => {
                const disabledByClosed = isKitchenClosed && (type === 'pickup' || type === 'dine-in')
                return (
                  <button
                    key={type}
                    role="radio"
                    aria-checked={deliveryType === type}
                    onClick={() => !disabledByClosed && setDeliveryType(type)}
                    disabled={disabledByClosed}
                    title={disabledByClosed ? t('delivery_type_disabled_closed') : undefined}
                    className={`flex-1 rounded-sm border min-h-[44px] py-2 text-sm font-medium transition-colors ${
                      disabledByClosed
                        ? "border-smoke-100 text-smoke-300 cursor-not-allowed bg-smoke-50"
                        : deliveryType === type
                          ? "border-brand-600 bg-brand-50 text-brand-700"
                          : "border-smoke-200 text-smoke-400 hover:border-smoke-300"
                    }`}
                  >
                    {getDeliveryTypeLabel(type, t)}
                  </button>
                )
              })}
          </div>

          {deliveryType === "delivery" && (
            <div className="space-y-2">
              <div className="relative">
                <input
                  type="text"
                  placeholder={t('cep_placeholder')}
                  aria-label={t('cep_placeholder')}
                  value={cepInput}
                  onChange={(e) => setCepInput(e.target.value.replaceAll(/\D/g, "").slice(0, 8))}
                  className="w-full border-0 border-b border-smoke-300 bg-transparent rounded-none px-1 py-3 text-sm focus:border-charcoal-900 focus:outline-none transition-[border-color] duration-[200ms] ease-luxury"
                />
                {loadingEstimate && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
              </div>
              {deliveryEstimate && deliveryEstimate.isLocalZone && (
                <p className="text-sm text-charcoal-700">{deliveryEstimate.message}{deliveryEstimate.feeInCentavos > 0 ? ` · ${formatBRL(deliveryEstimate.feeInCentavos)}` : ''}</p>
              )}
              {deliveryEstimate && deliveryEstimate.isLocalZone === false && (
                <div className="rounded-sm border border-brand-200 bg-brand-50/30 p-3 space-y-1">
                  <p className="text-sm font-medium text-charcoal-900">{t('delivery_shipping_title')}</p>
                  <p className="text-xs text-smoke-500">{t('delivery_shipping_desc', { cep: cepInput })}</p>
                </div>
              )}
              {deliveryError && (
                <p className="text-sm text-accent-red">{deliveryError}</p>
              )}
            </div>
          )}
        </div>

        {/* Gorjeta */}
        <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-6 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">{t('tip_label')}</h2>
          <div className="flex gap-2">
            {[0, 10, 15, 20].map((pct) => (
              <button
                key={pct}
                onClick={() => setTipPercent(pct)}
                className={`flex-1 rounded-sm border min-h-[44px] py-2 text-sm font-medium transition-colors ${tipPercent === pct ? "border-brand-600 bg-brand-50 text-brand-700" : "border-smoke-200 text-smoke-400 hover:border-smoke-300"}`}
              >
                {pct === 0 ? t('tip_none') : `${pct}%`}
              </button>
            ))}
          </div>
          {tipPercent > 0 && <p className="text-sm text-charcoal-700">{t('tip_value', { value: formatBRL(tipAmount) })}</p>}
        </div>

        {/* Observações */}
        <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-6 space-y-2">
          <label htmlFor="checkout-notes" className="text-sm font-medium text-smoke-700">
            {t('notes_label')}
          </label>
          <textarea
            id="checkout-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder={t('notes_placeholder')}
            className="w-full rounded-sm border border-smoke-200/60 shadow-xs bg-smoke-50 px-3 py-3 text-sm focus:border-charcoal-900 focus:outline-none transition-[border-color] duration-[200ms] ease-luxury resize-none"
          />
        </div>

        {/* Payment method */}
        <div className="bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-6 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-editorial text-smoke-400">{t('payment_label')}</h2>
          <div className="flex gap-2" role="radiogroup" aria-label={t('payment_label')}>
            {(["pix", "card", "cash"] as const)
              .filter((method) => {
                // Cash not available for shipping (outside delivery zone)
                if (method === 'cash' && isShipping) return false
                return true
              })
              .map((method) => (
                <button
                  key={method}
                  role="radio"
                  aria-checked={paymentMethod === method}
                  onClick={() => setPaymentMethod(method)}
                  className={`flex-1 rounded-sm border min-h-[44px] py-2 text-sm font-medium transition-colors ${paymentMethod === method ? "border-brand-600 bg-brand-50 text-brand-700" : "border-smoke-200 text-smoke-400 hover:border-smoke-300"}`}
                >
                  {getPaymentMethodLabel(method, t)}
                </button>
              ))}
          </div>
          {isShipping && (
            <p className="text-xs text-smoke-400">{t('payment_cash_unavailable')}</p>
          )}

          {/* PIX billing fields */}
          {paymentMethod === "pix" && (
            <div className="space-y-2 mt-3 pt-3 border-t border-smoke-200">
              <p className="text-xs font-medium text-[var(--color-text-secondary)]">{t('pix_billing_label')}</p>
              <input
                type="text"
                placeholder={t('pix_name_placeholder')}
                aria-label={t('pix_name_placeholder')}
                value={pixName}
                onChange={(e) => setPixName(e.target.value)}
                className="w-full border-0 border-b border-smoke-300 bg-transparent rounded-none px-1 py-3 text-sm focus:border-charcoal-900 focus:outline-none transition-[border-color] duration-[200ms] ease-luxury"
              />
              <input
                type="email"
                placeholder={t('pix_email_placeholder')}
                aria-label={t('pix_email_placeholder')}
                value={pixEmail}
                onChange={(e) => setPixEmail(e.target.value)}
                className="w-full border-0 border-b border-smoke-300 bg-transparent rounded-none px-1 py-3 text-sm focus:border-charcoal-900 focus:outline-none transition-[border-color] duration-[200ms] ease-luxury"
              />
              <input
                type="text"
                placeholder={t('pix_cpf_placeholder')}
                aria-label={t('pix_cpf_placeholder')}
                value={pixCpfMasked ? `***.${pixCpf.slice(-6)}` : pixCpf}
                onFocus={() => setPixCpfMasked(false)}
                onChange={(e) => { setPixCpfMasked(false); setPixCpf(formatCpf(e.target.value)) }}
                className="w-full border-0 border-b border-smoke-300 bg-transparent rounded-none px-1 py-3 text-sm focus:border-charcoal-900 focus:outline-none transition-[border-color] duration-[200ms] ease-luxury"
              />
              {pixCpf.replace(/\D/g, "").length === 11 && !isValidCpf(pixCpf) && (
                <p className="text-xs text-accent-red">{t('pix_cpf_invalid')}</p>
              )}
            </div>
          )}

          {/* Card input (inline Stripe CardElement) */}
          {paymentMethod === "card" && <InlineCardInput />}
        </div>

        {/* Total */}
        <div className="relative bg-smoke-50 shadow-card border border-smoke-200/40 rounded-sm p-6 space-y-2 overflow-hidden" aria-live="polite" aria-atomic="true">
          {/* Atmospheric warmth on the total panel */}
          <div className="absolute inset-0 warm-glow pointer-events-none opacity-50" />
          <div className="relative space-y-2">
            {deliveryFeeAmount > 0 && (
              <div className="flex justify-between text-sm text-smoke-400">
                <span>{t('fee_delivery')}</span><span>{formatBRL(deliveryFeeAmount)}</span>
              </div>
            )}
            {tipAmount > 0 && (
              <div className="flex justify-between text-sm text-smoke-400">
                <span>{t('fee_tip')}</span><span>{formatBRL(tipAmount)}</span>
              </div>
            )}
            <div className="flex justify-between items-baseline font-bold text-charcoal-900 font-display text-display-2xs border-t border-smoke-200 pt-4">
              <span>{t('total')}</span><span className="tabular-nums">{formatBRL(total)}</span>
            </div>
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

        {/* Terms acceptance */}
        <div className="flex items-start gap-3">
          <Checkbox
            id="checkout-terms"
            checked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
          />
          <label htmlFor="checkout-terms" className="text-sm text-charcoal-700 cursor-pointer select-none">
            Li e aceito os{" "}
            <Link href="/termos" className="text-brand-600 hover:underline" target="_blank" onClick={(e) => e.stopPropagation()}>
              termos de uso
            </Link>
          </label>
        </div>

        {/* Inline validation hints */}
        {!loading && deliveryType === "delivery" && !deliveryEstimate && !deliveryError && cepInput.length >= 8 && (
          <p className="text-xs text-smoke-400 text-center">{t('delivery_estimate_error')}</p>
        )}

        <Button
          variant="brand"
          size="lg"
          className="w-full min-h-[44px]"
          onClick={handleCheckout}
          disabled={loading || !termsAccepted || (deliveryType === "delivery" && !deliveryEstimate) || !pixFieldsValid || (isKitchenClosed && cartHasKitchenFood)}
        >
          {loading ? t('processing') : t('confirm_order', { total: formatBRL(total) })}
        </Button>
      </Container>
    </div>
    </ErrorBoundary>
  )
}

// ── Exported wrapper with Elements provider ──────────────────────────────────

export default function CheckoutContent() {
  if (!stripePromise) {
    // Stripe not configured — render without Elements (card payments disabled)
    return <CheckoutForm />
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#E85D04",
            borderRadius: "2px",
          },
        },
        locale: "pt-BR",
      }}
    >
      <CheckoutForm />
    </Elements>
  )
}
