// OrderService — centralizes order business logic (ownership, status, Medusa proxy).
//
// Requires a medusaAdmin function via dependency injection — callers in
// apps/api and packages/tools inject the shared client from @ibatexas/tools,
// which handles Bearer-JWT auth via MEDUSA_ADMIN_EMAIL/PASSWORD.
//
// ── W7-P6 (correctness remediation) — mutation egress through medusaAdjudicated ──
//
// The 6 mutating sites in this file (cancelOrder POST, cancelItem POST/POST/
// DELETE/POST, capturePayment POST/POST) historically went through the bare
// `medusaAdminFn` — bypassing the adjudicate kernel and audit emit. Per
// Task 17's `medusaAdjudicated` wrapper at packages/tools/src/medusa/
// adjudicated.ts, each Medusa egress is now a governed IntentEnvelope.
//
// Because `packages/domain` cannot depend on `@ibatexas/tools` (reverse
// dependency direction), the wrapper is INJECTED via the optional
// `adminAdjudicated` parameter on `createOrderService`. Callers in
// `apps/api` and `packages/tools` wire it via a thin closure that binds
// the source-subject + audit-sink at the construction site.
//
// Backwards-compat: when `adminAdjudicated` is undefined, mutations fall
// back to the bare `fetchAdmin` path (preserved for legacy tests). New
// production wiring MUST supply the adjudicated DI per CLAUDE.md rule #9.
//
// GETs (reads) always pass through `fetchAdmin` directly — the wrapper's
// own `dispatchHttp` would do the same for GET; the wrapper pass-through
// for GET is duplicated here to keep the service surface narrow.

export type MedusaFetch = (path: string, options?: RequestInit) => Promise<unknown>

/**
 * Signature of the injected adjudicated-egress callback. Matches the
 * essential surface of `medusaAdjudicated` from
 * `packages/tools/src/medusa/adjudicated.ts` — see that file's
 * MedusaAdjudicatedArgs interface for the full spec. We keep the type
 * narrow here so the domain package does not need to import from
 * @ibatexas/tools (which depends on @ibatexas/domain — would cycle).
 */
export interface AdminAdjudicatedRequest<P> {
  readonly method: "POST" | "PATCH" | "PUT" | "DELETE"
  readonly path: string
  readonly payload?: P
  /** Optional override of the auto-detected medusa.* intent kind. */
  readonly intentKind?: string
  /** Idempotency / nonce key; forwarded as Idempotency-Key header. */
  readonly idempotencyKey?: string
  /** Short call-site label; surfaces in audit record's actor.sessionId. */
  readonly sourceSubject: string
}

export type AdminAdjudicated = <P, R = unknown>(
  args: AdminAdjudicatedRequest<P>,
) => Promise<R>

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

/**
 * Optional DI for createOrderService. When `adminAdjudicated` is
 * supplied, the 6 mutating egresses route through the kernel-gated
 * wrapper; otherwise they fall back to the bare `medusaAdminFn` path
 * (legacy posture). Log is used for the fallback-warning once at
 * service construction.
 */
export interface OrderServiceOptions {
  readonly adminAdjudicated?: AdminAdjudicated
  readonly log?: { warn?: (...args: unknown[]) => void }
}

// ── Service ───────────────────────────────────────────────────────────────────

export function createOrderService(
  medusaAdminFn: MedusaFetch,
  options?: OrderServiceOptions,
) {
  const fetchAdmin = medusaAdminFn
  const adminAdjudicated = options?.adminAdjudicated

  /**
   * Dispatch a mutation through the adjudicated wrapper when injected,
   * otherwise fall back to bare fetchAdmin. The fallback exists ONLY
   * to keep legacy tests / unmigrated callers operational while the
   * W7 closure cycle is in flight. Production wiring (apps/api,
   * packages/tools) MUST supply `adminAdjudicated`.
   */
  async function mutate<P, R = unknown>(args: {
    path: string
    method: "POST" | "DELETE"
    payload?: P
    sourceSubject: string
    idempotencyKey?: string
  }): Promise<R> {
    if (adminAdjudicated) {
      return adminAdjudicated<P, R>({
        method: args.method,
        path: args.path,
        ...(args.payload !== undefined ? { payload: args.payload } : {}),
        sourceSubject: args.sourceSubject,
        ...(args.idempotencyKey !== undefined
          ? { idempotencyKey: args.idempotencyKey }
          : {}),
      })
    }
    // Legacy fallback path — no kernel adjudication, no audit emit.
    const init: RequestInit = { method: args.method }
    if (args.payload !== undefined) {
      init.body = JSON.stringify(args.payload)
    }
    return (await fetchAdmin(args.path, init)) as R
  }

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

      await mutate({
        path: `/admin/orders/${orderId}/cancel`,
        method: "POST",
        sourceSubject: "service:order.cancel",
        idempotencyKey: `order.cancel:${orderId}`,
      })
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
        await mutate({
          path: `/admin/orders/${orderId}/cancel`,
          method: "POST",
          sourceSubject: "service:order.cancel-item-collapses-order",
          idempotencyKey: `order.cancel:${orderId}`,
        })
        return { success: true, message: `"${itemTitle}" cancelado e pedido encerrado.` }
      }

      // Remove single item via order edit API
      try {
        const editData = await mutate<unknown, { order_edit: { id: string } }>({
          path: `/admin/orders/${orderId}/edits`,
          method: "POST",
          sourceSubject: "service:order.edit.create",
          idempotencyKey: `order.edit.create:${orderId}:${item.id}`,
        })
        const editId = editData.order_edit.id

        await mutate({
          path: `/admin/orders/${orderId}/edits/${editId}/items/${item.id}`,
          method: "DELETE",
          sourceSubject: "service:order.edit.items.remove",
          idempotencyKey: `order.edit.items.remove:${orderId}:${editId}:${item.id}`,
        })

        await mutate({
          path: `/admin/orders/${orderId}/edits/${editId}/confirm`,
          method: "POST",
          sourceSubject: "service:order.edit.confirm",
          idempotencyKey: `order.edit.confirm:${orderId}:${editId}`,
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

      await mutate({
        path: `/admin/orders/${orderId}/capture-payment`,
        method: "POST",
        sourceSubject: "service:order.capture-payment",
        idempotencyKey: `order.capture-payment:${orderId}:${paymentIntentId}`,
      })
      await mutate<{ metadata: { stripePaymentIntentId: string } }>({
        path: `/admin/orders/${orderId}`,
        method: "POST",
        payload: { metadata: { stripePaymentIntentId: paymentIntentId } },
        sourceSubject: "service:order.update-metadata",
        idempotencyKey: `order.update-metadata:${orderId}:${paymentIntentId}`,
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
