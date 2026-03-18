// OrderService — centralizes order business logic (ownership, status, Medusa proxy).
//
// Accepts an optional medusaAdmin function for dependency injection.
// When called from apps/api or packages/tools, inject the shared client from @ibatexas/tools.
// Falls back to a built-in implementation when no client is injected (standalone usage).

export type MedusaFetch = (path: string, options?: RequestInit) => Promise<unknown>

// ── Default Medusa client (fallback when no injection) ───────────────────────

const MEDUSA_URL = process.env.MEDUSA_URL ?? "http://localhost:9000"

const defaultMedusaAdmin: MedusaFetch = async (path, options) => {
  const apiKey = process.env.MEDUSA_API_KEY ?? ""
  const res = await fetch(`${MEDUSA_URL}${path}`, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      "x-medusa-access-token": apiKey,
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Medusa admin ${res.status}: ${text}`)
  }
  return res.json()
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MedusaOrder {
  id: string
  status: string
  display_id?: number
  total?: number
  subtotal?: number
  shipping_total?: number
  customer_id?: string
  metadata?: Record<string, string>
  items?: Array<{
    id: string
    variant_id: string
    product_id?: string
    title: string
    quantity: number
    unit_price: number
    thumbnail?: string
  }>
  created_at?: string
}

export interface OrderItem {
  productId: string
  variantId: string
  quantity: number
  priceInCentavos: number
}

// ── Service ───────────────────────────────────────────────────────────────────

export function createOrderService(medusaAdminFn?: MedusaFetch) {
  const fetchAdmin = medusaAdminFn ?? defaultMedusaAdmin

  return {
    /**
     * Fetch an order from Medusa, optionally verifying ownership.
     * Throws if not found. Returns `null` ownership message if customer doesn't match.
     */
    async getOrder(
      orderId: string,
      customerId?: string,
    ): Promise<{ order: MedusaOrder; ownershipValid: boolean }> {
      const data = await fetchAdmin(`/admin/orders/${orderId}?expand=items`) as { order: MedusaOrder }
      const order = data.order

      if (customerId) {
        const orderCustomerId = order.customer_id ?? order.metadata?.["customerId"]
        if (orderCustomerId && orderCustomerId !== customerId) {
          return { order, ownershipValid: false }
        }
      }

      return { order, ownershipValid: true }
    },

    /**
     * Cancel an order if eligible (pending or requires_action).
     * Validates ownership before cancelling.
     */
    async cancelOrder(
      orderId: string,
      customerId: string,
    ): Promise<{ success: boolean; message: string }> {
      const { order, ownershipValid } = await this.getOrder(orderId, customerId)

      if (!ownershipValid) {
        return { success: false, message: "Pedido não encontrado." }
      }

      const cancellableStatuses = ["pending", "requires_action"]
      if (!cancellableStatuses.includes(order.status)) {
        return {
          success: false,
          message: `Pedido no status "${order.status}" não pode ser cancelado. Fale com nosso atendimento.`,
        }
      }

      await fetchAdmin(`/admin/orders/${orderId}/cancel`, { method: "POST" })
      return { success: true, message: "Pedido cancelado com sucesso." }
    },

    /**
     * Capture payment and update order metadata after Stripe webhook confirmation.
     * Returns the order items for intelligence pipeline.
     */
    async capturePayment(
      orderId: string,
      paymentIntentId: string,
    ): Promise<{ customerId: string | undefined; items: OrderItem[] } | null> {
      const data = await fetchAdmin(`/admin/orders/${orderId}?expand=items`) as { order: MedusaOrder }
      const order = data.order

      if (order.status !== "pending") return null
      if (order.metadata?.["stripePaymentIntentId"]) return null

      await fetchAdmin(`/admin/orders/${orderId}/capture-payment`, { method: "POST" })
      await fetchAdmin(`/admin/orders/${orderId}`, {
        method: "POST",
        body: JSON.stringify({ metadata: { stripePaymentIntentId: paymentIntentId } }),
      })

      const items: OrderItem[] = (order.items ?? []).map((item) => ({
        productId: item.product_id ?? item.variant_id,
        variantId: item.variant_id,
        quantity: item.quantity,
        priceInCentavos: item.unit_price ?? 0,
      }))

      const customerId = order.customer_id ?? order.metadata?.["customerId"]

      return { customerId, items }
    },
  }
}

export type OrderService = ReturnType<typeof createOrderService>
