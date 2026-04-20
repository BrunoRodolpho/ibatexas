// OrderService — centralizes order business logic (ownership, status, Medusa proxy).
//
// Requires a medusaAdmin function via dependency injection — callers in
// apps/api and packages/tools inject the shared client from @ibatexas/tools,
// which handles Bearer-JWT auth via MEDUSA_ADMIN_EMAIL/PASSWORD.

export type MedusaFetch = (path: string, options?: RequestInit) => Promise<unknown>

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MedusaOrder {
  id: string
  status: string
  display_id?: number
  total?: number
  subtotal?: number
  shipping_total?: number
  customer_id?: string
  email?: string
  customer?: Record<string, unknown>
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
  title: string
  quantity: number
  priceInCentavos: number
}

// ── Service ───────────────────────────────────────────────────────────────────

export function createOrderService(medusaAdminFn: MedusaFetch) {
  const fetchAdmin = medusaAdminFn

  return {
    /**
     * Fetch an order from Medusa, optionally verifying ownership.
     * Throws if not found. Returns `null` ownership message if customer doesn't match.
     */
    async getOrder(
      orderId: string,
      customerId?: string,
    ): Promise<{ order: MedusaOrder; ownershipValid: boolean }> {
      const data = await fetchAdmin(`/admin/orders/${orderId}`) as { order: MedusaOrder }
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
     * Validates ownership and PONR window before cancelling.
     * Returns needsEscalation: true when PONR has expired (admin should be notified).
     */
    async cancelOrder(
      orderId: string,
      customerId: string,
      options?: { force?: boolean },
    ): Promise<{ success: boolean; message: string; needsEscalation?: boolean }> {
      const { order, ownershipValid } = await this.getOrder(orderId, customerId)

      if (!ownershipValid) {
        return { success: false, message: "Pedido não encontrado." }
      }

      const cancellableStatuses = ["pending", "requires_action"]
      if (!cancellableStatuses.includes(order.status)) {
        return {
          success: false,
          message: "Pedido em preparo — não pode ser cancelado automaticamente.",
          needsEscalation: true,
        }
      }

      // PONR check (whole-order = all items must still be within cancel window)
      if (!options?.force && order.created_at) {
        const { getEffectivePonr, isWithinPonr } = await import("./ponr.js")
        const items = order.items ?? []
        const anyPastPonr = items.some((item) => {
          const metadata = (item as unknown as { metadata?: Record<string, unknown> }).metadata
          const cancelMinutes = typeof metadata?.cancelPonrMinutes === "number"
            ? metadata.cancelPonrMinutes
            : undefined
          const ponr = getEffectivePonr({ cancelMinutes })
          return !isWithinPonr(new Date(order.created_at!), ponr.cancelMinutes)
        })
        if (anyPastPonr) {
          return {
            success: false,
            message: "Prazo para cancelamento automático já passou. Um atendente foi notificado e vai ajudar.",
            needsEscalation: true,
          }
        }
      }

      await fetchAdmin(`/admin/orders/${orderId}/cancel`, { method: "POST" })
      return { success: true, message: "Pedido cancelado com sucesso." }
    },

    /**
     * Cancel a single item from an order (within its PONR window).
     * Uses Medusa order edit API to remove the line item.
     */
    async cancelItem(
      orderId: string,
      customerId: string,
      itemTitle: string,
    ): Promise<{ success: boolean; message: string; needsEscalation?: boolean }> {
      const { order, ownershipValid } = await this.getOrder(orderId, customerId)

      if (!ownershipValid) {
        return { success: false, message: "Pedido não encontrado." }
      }

      // Find the item by title
      const item = (order.items ?? []).find(
        (i) => i.title.toLowerCase() === itemTitle.toLowerCase(),
      )
      if (!item) {
        return { success: false, message: `Item "${itemTitle}" não encontrado no pedido.` }
      }

      // PONR check for this specific item
      if (order.created_at) {
        const { getEffectivePonr, isWithinPonr } = await import("./ponr.js")
        const metadata = (item as unknown as { metadata?: Record<string, unknown> }).metadata
        const cancelMinutes = typeof metadata?.cancelPonrMinutes === "number"
          ? metadata.cancelPonrMinutes
          : undefined
        const ponr = getEffectivePonr({ cancelMinutes })
        if (!isWithinPonr(new Date(order.created_at), ponr.cancelMinutes)) {
          return {
            success: false,
            message: `Prazo para cancelar "${itemTitle}" já passou. Um atendente foi notificado.`,
            needsEscalation: true,
          }
        }
      }

      // If this is the only item, cancel the whole order
      if ((order.items ?? []).length === 1) {
        await fetchAdmin(`/admin/orders/${orderId}/cancel`, { method: "POST" })
        return { success: true, message: `"${itemTitle}" cancelado e pedido encerrado.` }
      }

      // Remove single item via order edit API
      try {
        const editData = await fetchAdmin(`/admin/orders/${orderId}/edits`, {
          method: "POST",
        }) as { order_edit: { id: string } }
        const editId = editData.order_edit.id

        await fetchAdmin(`/admin/orders/${orderId}/edits/${editId}/items/${item.id}`, {
          method: "DELETE",
        })

        await fetchAdmin(`/admin/orders/${orderId}/edits/${editId}/confirm`, {
          method: "POST",
        })

        return { success: true, message: `"${itemTitle}" removido do pedido.` }
      } catch (err) {
        return {
          success: false,
          message: `Erro ao remover "${itemTitle}". Um atendente foi notificado.`,
          needsEscalation: true,
        }
      }
    },

    /**
     * Capture payment and update order metadata after Stripe webhook confirmation.
     * Returns the order items for intelligence pipeline.
     * When `amountInCentavos` is provided, validates it matches the current order total
     * to prevent capturing stale PaymentIntents from before an amendment.
     */
    async capturePayment(
      orderId: string,
      paymentIntentId: string,
      options?: { amountInCentavos?: number },
    ): Promise<{
      customerId: string | undefined
      items: OrderItem[]
      displayId: number
      customerEmail: string | undefined
      customerName: string | undefined
      customerPhone: string | undefined
      totalInCentavos: number
      subtotalInCentavos: number
      shippingInCentavos: number
      deliveryType: string | null
      paymentMethod: string | null
      tipInCentavos: number
    } | null> {
      const data = await fetchAdmin(`/admin/orders/${orderId}?expand=items,customer`) as { order: MedusaOrder }
      const order = data.order

      if (order.status !== "pending") return null
      if (order.metadata?.["stripePaymentIntentId"]) return null

      // Guard against stale PI from pre-amendment (total changed but old PI was captured)
      if (options?.amountInCentavos != null && order.total != null) {
        if (options.amountInCentavos !== order.total) {
          return null
        }
      }

      await fetchAdmin(`/admin/orders/${orderId}/capture-payment`, { method: "POST" })
      await fetchAdmin(`/admin/orders/${orderId}`, {
        method: "POST",
        body: JSON.stringify({ metadata: { stripePaymentIntentId: paymentIntentId } }),
      })

      // Medusa v2 returns unit_price in reais — convert to centavos
      const items: OrderItem[] = (order.items ?? []).map((item) => ({
        productId: item.product_id ?? item.variant_id,
        variantId: item.variant_id,
        title: item.title ?? "",
        quantity: item.quantity,
        priceInCentavos: Math.round((item.unit_price ?? 0) * 100),
      }))

      const customerId = order.customer_id ?? order.metadata?.["customerId"]

      return {
        customerId,
        items,
        displayId: order.display_id ?? 0,
        customerEmail: order.email,
        customerName: (order.customer as { first_name?: string })?.first_name,
        customerPhone: order.metadata?.["customerPhone"],
        totalInCentavos: Math.round((order.total ?? 0) * 100),
        subtotalInCentavos: Math.round((order.subtotal ?? 0) * 100),
        shippingInCentavos: Math.round((order.shipping_total ?? 0) * 100),
        deliveryType: order.metadata?.["deliveryType"] ?? null,
        paymentMethod: order.metadata?.["paymentMethod"] ?? null,
        tipInCentavos: Number(order.metadata?.["tipInCentavos"]) || 0,
      }
    },
  }
}

export type OrderService = ReturnType<typeof createOrderService>
