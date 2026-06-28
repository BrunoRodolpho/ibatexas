// OrderService — centralizes order business logic (ownership, status, Medusa proxy).
//
// Requires a medusaAdmin function via dependency injection — callers in
// apps/api and packages/tools inject the shared client from @ibatexas/tools,
// which handles Bearer-JWT auth via MEDUSA_ADMIN_EMAIL/PASSWORD.
//
// ── W7-P6 (correctness remediation) — mutation egress through medusaAdjudicated ──
//
// The mutating sites in this file (cancelOrder POST, cancelItem POST/POST/
// DELETE/POST, capturePayment metadata POST — its v1 capture POST was removed
// as the dead `medusa-v2-capture-payment` gap, T2-1) historically went through the bare
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
// ── W8-V1 — hard-throw on missing adminAdjudicated ────────────────────────
//
// The W7-P6 closure left a silent fallback to bare `fetchAdmin` when
// `adminAdjudicated` was undefined, on the assumption that the remaining
// cart-tool callers would migrate in a follow-up. The verifier surfaced
// NEW-W7-V1: three callers (`cancel-order`, `amend-order`,
// `check-order-status` in `packages/tools/src/cart/`) silently bypassed
// the kernel for medusa egress because they never received the DI.
//
// W8 closes the seam: every cart-tool caller now goes through
// `createTooledOrderService()` (packages/tools/src/cart/_shared.ts), and
// the silent fallback is replaced by a hard `throw` at the first
// mutation attempt — so any future regression (a new caller that
// forgets the DI) fails loudly at call time rather than silently
// bypassing the kernel.
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
 * DI for createOrderService. The 6 mutating egresses route through the
 * `adminAdjudicated` wrapper (kernel + audit). Pre-W8 the option was
 * optional with a silent bare-`fetchAdmin` fallback; W8-V1 made the
 * option load-bearing — calling a mutation without it now throws (see
 * the `mutate()` helper below).
 *
 * For LLM-callable cart tools, use `createTooledOrderService()` from
 * `packages/tools/src/cart/_shared.ts` (the canonical wiring path).
 * For ad-hoc construction in tests, pass a vi.fn() stub for
 * `adminAdjudicated`.
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
  // Factory-scoped alias: capturePayment's own `options` param shadows the
  // factory's, so the injected logger needs a distinct name.
  const serviceLog = options?.log

  /**
   * Dispatch a mutation through the adjudicated wrapper. The wrapper is
   * required: callers that omit `adminAdjudicated` get a hard throw on
   * the first mutation attempt rather than a silent bypass.
   *
   * W8-V1 (NEW-W7-V1) removed the silent fallback to bare `fetchAdmin`
   * that masked the W7 P5↔P6 hand-off gap. The fallback existed so
   * cart-tool callers could remain on a legacy posture during the W7
   * closure cycle; once those callers migrated to
   * `createTooledOrderService()`, the fallback became a foot-gun for
   * any future regression. The throw is fail-loud and bounded to the
   * call-site that forgot the wiring.
   */
  async function mutate<P, R = unknown>(args: {
    path: string
    method: "POST" | "DELETE"
    payload?: P
    sourceSubject: string
    idempotencyKey?: string
  }): Promise<R> {
    if (!adminAdjudicated) {
      // W8-V1: hard fail rather than silently bypassing the kernel.
      throw new Error(
        "createOrderService called without adjudicated medusa client — " +
          "refusing to bypass kernel for mutation egress. " +
          "Construct the service via createTooledOrderService() " +
          "(packages/tools/src/cart/_shared.ts) or pass an adminAdjudicated " +
          "DI per the apps/api/src/routes/stripe-webhook.ts wiring example.",
      )
    }
    return adminAdjudicated<P, R>({
      method: args.method,
      path: args.path,
      ...(args.payload === undefined ? {} : { payload: args.payload }),
      sourceSubject: args.sourceSubject,
      ...(args.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: args.idempotencyKey }),
    })
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
        // Handle (rather than swallow) the order-edit failure: surface it on
        // the injected logger before escalating. Control flow is unchanged.
        serviceLog?.warn?.(
          { orderId, itemTitle, err },
          "[order-service] cancelItem order-edit flow failed — escalating",
        )
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
      // Medusa v2 dropped the v1 `expand` query param (it 400s "Unrecognized fields:
      // 'expand'"). Use the `fields` idiom: `*relation` expands a relation, bare names
      // select columns. With `expand` the order GET threw before any capture ran, so a
      // paid PIX order was stranded in `pending` (cart completed, capture never happened).
      const data = await fetchAdmin(`/admin/orders/${orderId}?fields=id,status,display_id,email,total,subtotal,shipping_total,customer_id,metadata,*items,*customer`) as { order: MedusaOrder }
      const order = data.order

      if (order.status !== "pending") return null
      if (order.metadata?.["stripePaymentIntentId"]) return null

      // Guard against stale PI from pre-amendment (total changed but old PI was captured).
      // order.total is reais (Medusa v2 — see the *InCentavos mapping below); options.amountInCentavos
      // is the Stripe minor unit. Compare in centavos, never reais-vs-centavos (CLAUDE.md rule #2):
      // the old `!== order.total` mismatched for every order > R$0,01, so capture silently no-op'd.
      if (options?.amountInCentavos != null && order.total != null) {
        if (options.amountInCentavos !== Math.round(order.total * 100)) {
          return null
        }
      }

      // ── PRODUCT GAP: medusa-v2-capture-payment (T2-1 live finding) ────────
      // `POST /admin/orders/:id/capture-payment` is a REMOVED Medusa v1
      // endpoint — it does not exist in @medusajs/medusa 2.13 (verified
      // against dist/api/admin/orders/[id]/: archive|cancel|changes|complete|
      // …, no capture-payment), the same dead-v1-endpoint class as the D-015
      // order-amend finding (medusa-v2-order-edit). The old mutate() here
      // audited a kernel EXECUTE for a mutation that 404'd on every call —
      // decision-vs-execution divergence — and the throw killed the whole
      // webhook job BEFORE order.placed/reconcile, so the Stripe paid path
      // never landed. Until the capture is ported to the v2 surface
      // (resolve the order's payment via *payment_collections.payments, then
      // POST /admin/payments/:payment_id/capture), the Medusa-side capture
      // bookkeeping is SKIPPED with a loud log; the domain plane's payment
      // truth lands via the kernel-audited payment.status.reconcile that
      // follows in the webhook handler. unblock = port to /admin/payments.
      serviceLog?.warn?.(
        { orderId, paymentIntentId, gap: "medusa-v2-capture-payment" },
        "[order-service] Medusa-side capture skipped — /admin/orders/:id/capture-payment does not exist in Medusa v2 (see gap medusa-v2-capture-payment)",
      )
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
