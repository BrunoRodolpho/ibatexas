// KernelExecutor — Layer 1 interface for the deterministic XState machine.
//
// Extracted from agent.ts. Processes OrderEvent[] through the XState machine,
// executing async side effects (search, cart, delivery, checkout, loyalty)
// between transitions. Returns the final machine state and context.
//
// The kernel runs perfectly without any LLM.

import { createActor } from "xstate"
import { orderMachine, getStateString, createDefaultContext, isCheckoutState } from "./machine/order-machine.js"
import type { OrderContext, KernelOutput } from "./machine/types.js"
import { extractIllusionContext } from "./machine/types.js"
import { routeMessage } from "./router.js"
import { persistMachineState } from "./machine/persistence.js"
import {
  searchProduct,
  ensureCart,
  addItemToCart,
  estimateDeliveryAction,
  processCheckout,
  fetchLoyaltyBalance,
  scheduleFollowUpAction,
  buildToolContext,
} from "./machine/actions.js"
import { cancelOrder, regeneratePix } from "@ibatexas/tools"

// Re-export for consumers that need these (agent.ts, orchestrator.ts)
export { createDefaultContext, isCheckoutState }

// ── Timeout constants for each async operation (ms) ──────────────────────────

export const SEARCH_TIMEOUT = 10_000
export const CART_TIMEOUT = 10_000
export const DELIVERY_TIMEOUT = 8_000
export const CHECKOUT_TIMEOUT = 30_000
export const LOYALTY_TIMEOUT = 5_000

// ── Async timeout helper ─────────────────────────────────────────────────────

/**
 * Race a promise against a timeout. Returns the fallback value on timeout
 * instead of leaving the caller hanging. Critical for preventing customer
 * stranding when upstream services (Medusa, Stripe, Typesense) are slow.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
  })
  try {
    const result = await Promise.race([promise, timeout])
    return result
  } catch (err) {
    console.error(`[machine:timeout] ${label}:`, (err as Error).message)
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Retry a factory function up to `maxAttempts` times with exponential backoff.
 * Each attempt is individually wrapped in `withTimeout`. Returns the fallback
 * only after all attempts are exhausted.
 *
 * Use for transient failures (network blips, rate limits). The factory must
 * return a fresh promise on each call — do NOT pass a pre-created promise.
 */
export async function withRetry<T>(
  factory: () => Promise<T>,
  opts: { maxAttempts: number; timeoutMs: number; fallback: T; label: string },
): Promise<T> {
  const { maxAttempts, timeoutMs, fallback, label } = opts
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await withTimeout(factory(), timeoutMs, "__RETRY_SENTINEL__" as unknown as T, `${label}:attempt${attempt}`)
    // withTimeout returns fallback on timeout/error. We use a sentinel to
    // distinguish "timeout → retry" from "success that happens to match fallback".
    if (result !== ("__RETRY_SENTINEL__" as unknown)) {
      return result
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)))
    }
  }
  console.error(`[machine:retry] ${label}: all ${maxAttempts} attempts failed`)
  return fallback
}

// ── Post-order action wrappers ────────────────────────────────────────────────
// These wrap @ibatexas/tools handlers into the format the kernel expects.
// The kernel executes these deterministically — the LLM never calls them directly.

async function cancelOrderAction(
  ctx: OrderContext,
  sessionId: string,
): Promise<{ success: boolean; message: string }> {
  if (!ctx.orderId) {
    return { success: false, message: "Pedido não encontrado." }
  }
  try {
    const toolCtx = buildToolContext(ctx, sessionId)
    const result = await cancelOrder(
      { orderId: ctx.orderId },
      toolCtx,
    )
    return { success: result.success, message: result.message }
  } catch (err) {
    console.error("[kernel:cancelOrder]", (err as Error).message)
    return { success: false, message: (err as Error).message }
  }
}

async function regeneratePixAction(
  ctx: OrderContext,
  sessionId: string,
): Promise<{ success: boolean; message: string; pixQrCodeText?: string; pixQrCodeUrl?: string }> {
  if (!ctx.orderId) {
    return { success: false, message: "Pedido não encontrado." }
  }
  try {
    const toolCtx = buildToolContext(ctx, sessionId)
    const result = await regeneratePix(
      { orderId: ctx.orderId },
      toolCtx,
    )
    return {
      success: result.success,
      message: result.message,
      pixQrCodeText: result.pixQrCodeText,
      pixQrCodeUrl: result.pixQrCodeUrl,
    }
  } catch (err) {
    console.error("[kernel:regeneratePix]", (err as Error).message)
    return { success: false, message: (err as Error).message }
  }
}

// ── Kernel executor ──────────────────────────────────────────────────────────

/**
 * Process events through the XState machine, executing async side effects
 * between transitions. Returns the final machine context.
 *
 * The orchestrator pattern:
 * 1. Send event to machine → machine transitions to a "waiting" state
 * 2. Execute the appropriate async action (tool call)
 * 3. Feed result back as an internal event → machine transitions to next state
 */
export async function executeKernel(
  events: ReturnType<typeof routeMessage>,
  machineContext: OrderContext,
  sessionId: string,
  snapshot: unknown | null,
  onStatus?: (message: string) => void,
): Promise<KernelOutput> {
  // Create or restore the actor
  const actorOptions = snapshot
    ? { snapshot: snapshot as Parameters<typeof createActor>[1] extends infer O ? O extends { snapshot?: infer S } ? S : never : never }
    : { input: machineContext }

  const actor = createActor(orderMachine, actorOptions as { input: OrderContext })
  actor.start()

  const initialState = getStateString(actor.getSnapshot())
  console.info("[kernel] initial_state=%s snapshot=%s", initialState, !!snapshot)
  let lastEventType = ""

  const addItemCount = events.filter(e => e.type === "ADD_ITEM").length
  const isMultiProductBatch = addItemCount > 1

  for (let event of events) {
    lastEventType = event.type

    // Resolve __last_pending__ for UPDATE_QTY to the last cart item
    if (event.type === "UPDATE_QTY" && (event as { productName?: string }).productName === "__last_pending__") {
      const lastItem = actor.getSnapshot().context.items.at(-1)
      if (lastItem) {
        event = { ...event, productName: lastItem.name } as typeof event
      }
    }

    // Send the user event
    const preState = getStateString(actor.getSnapshot())
    actor.send(event)

    let currentState = actor.getSnapshot()
    let stateStr = getStateString(currentState)
    const ctx = currentState.context

    console.info("[kernel] event=%s pre=%s post=%s cartId=%s items=%d",
      event.type, preState, stateStr, ctx.cartId ?? "null", ctx.items?.length ?? 0,
    )

    // ── Execute async side effects based on the state we landed in ──────

    // VALIDATING_ITEM → needs search result
    if (stateStr === "ordering.validating_item" && ctx.pendingProduct) {
      // setPendingProduct resolves "__last_pending__" to the actual product name.
      // Safety net: if it somehow slips through, treat as empty.
      const searchTerm = ctx.pendingProduct === "__last_pending__"
        ? ""
        : ctx.pendingProduct

      if (!searchTerm) {
        // No product to search — send not-found
        actor.send({
          type: "SEARCH_RESULT",
          found: false,
          products: [],
          alternatives: [],
        })
      } else {
        const searchStatusTimer = setTimeout(() => onStatus?.("Deixa eu procurar no cardápio…"), 1500)
        const searchResult = await withRetry(
          () => searchProduct(searchTerm, ctx, sessionId),
          { maxAttempts: 2, timeoutMs: SEARCH_TIMEOUT, fallback: { found: false, products: [], alternatives: [] } as Awaited<ReturnType<typeof searchProduct>>, label: "searchProduct" },
        )
        clearTimeout(searchStatusTimer)
        actor.send({
          type: "SEARCH_RESULT",
          found: searchResult.found,
          products: searchResult.products,
          alternatives: searchResult.alternatives,
          availableProduct: searchResult.found && searchResult.products.length > 0
            ? {
                variantId: searchResult.products[0].variantId,
                name: searchResult.products[0].name,
                priceInCentavos: searchResult.products[0].priceInCentavos,
                category: searchResult.products[0].category,
              }
            : undefined,
        })

        // If search found an available product and we're now in adding_to_cart
        currentState = actor.getSnapshot()
        stateStr = getStateString(currentState)

        if (stateStr === "ordering.adding_to_cart" && searchResult.found && searchResult.products.length > 0) {
          const eventVariantHint = (event as { variantHint?: string }).variantHint

          // If multiple variants and no hint, DON'T auto-add — let LLM present options
          if ((searchResult.products.length > 1 && !eventVariantHint) || isMultiProductBatch) {
            actor.send({
              type: "CART_UPDATED",
              success: true,
              cartId: currentState.context.cartId ?? "",
              items: currentState.context.items,
              totalInCentavos: currentState.context.totalInCentavos,
            })
          } else {
            // Single variant or hint provided — auto-add
            const product = eventVariantHint
              ? searchResult.products.find((p) => p.name.toLowerCase().includes(eventVariantHint)) ?? searchResult.products[0]
              : searchResult.products[0]

            // Guard: skip add if variant already exists in cart (prevents duplication
            // from session recovery + kernel re-processing race condition)
            const alreadyInCart = currentState.context.items.some(
              (item) => item.variantId === product.variantId,
            )
            if (alreadyInCart) {
              actor.send({
                type: "CART_UPDATED",
                success: true,
                cartId: currentState.context.cartId ?? "",
                items: currentState.context.items,
                totalInCentavos: currentState.context.totalInCentavos,
              })
            } else {

            const cartResult = await withRetry(
              () => ensureCart(currentState.context, sessionId),
              { maxAttempts: 2, timeoutMs: CART_TIMEOUT, fallback: { success: false, cartId: "", items: [], totalInCentavos: 0, error: "Timeout ao criar carrinho" } as Awaited<ReturnType<typeof ensureCart>>, label: "ensureCart" },
            )
            if (cartResult.success && cartResult.cartId) {
              let addResult = await withRetry(
                () => addItemToCart(
                  cartResult.cartId,
                  product.variantId,
                  (event as { quantity?: number }).quantity ?? 1,
                  { ...currentState.context, cartId: cartResult.cartId },
                  sessionId,
                ),
                { maxAttempts: 2, timeoutMs: CART_TIMEOUT, fallback: { success: false, cartId: cartResult.cartId, items: currentState.context.items, totalInCentavos: currentState.context.totalInCentavos, error: "Timeout ao adicionar item" } as Awaited<ReturnType<typeof addItemToCart>>, label: "addItemToCart" },
              )

              // Stale variant: cache was invalidated — re-search with fresh data and retry
              if (!addResult.success && addResult.staleVariant && searchTerm) {
                const freshSearch = await withRetry(
                  () => searchProduct(searchTerm, currentState.context, sessionId),
                  { maxAttempts: 1, timeoutMs: SEARCH_TIMEOUT, fallback: { found: false, products: [], alternatives: [] } as Awaited<ReturnType<typeof searchProduct>>, label: "searchProduct:retry" },
                )
                if (freshSearch.found && freshSearch.products.length > 0) {
                  const freshProduct = freshSearch.products[0]
                  addResult = await withRetry(
                    () => addItemToCart(
                      cartResult.cartId,
                      freshProduct.variantId,
                      (event as { quantity?: number }).quantity ?? 1,
                      { ...currentState.context, cartId: cartResult.cartId },
                      sessionId,
                    ),
                    { maxAttempts: 1, timeoutMs: CART_TIMEOUT, fallback: addResult, label: "addItemToCart:retry" },
                  )
                }
              }

              actor.send({
                type: "CART_UPDATED",
                success: addResult.success,
                cartId: addResult.cartId,
                items: addResult.items,
                totalInCentavos: addResult.totalInCentavos,
                error: addResult.error,
              })
            } else {
              actor.send({
                type: "CART_UPDATED",
                success: false,
                cartId: "",
                items: [],
                totalInCentavos: 0,
                error: cartResult.error ?? "Erro ao criar carrinho",
              })
            }

            } // end: else (!alreadyInCart)
          }
        }
      }
    }

    // ESTIMATING_DELIVERY → needs delivery estimate
    currentState = actor.getSnapshot()
    stateStr = getStateString(currentState)
    if (stateStr === "checkout.estimating_delivery") {
      const deliveryCtx = currentState.context
      const deliveryStatusTimer = setTimeout(() => onStatus?.("Verificando o CEP…"), 1500)
      const deliveryResult = await withTimeout(
        estimateDeliveryAction(deliveryCtx.deliveryCep ?? undefined),
        DELIVERY_TIMEOUT,
        { success: false, inZone: false, feeInCentavos: 0, etaMinutes: 0, error: "Timeout ao verificar CEP" } as Awaited<ReturnType<typeof estimateDeliveryAction>>,
        "estimateDelivery",
      )
      clearTimeout(deliveryStatusTimer)
      actor.send({
        type: "DELIVERY_RESULT",
        inZone: deliveryResult.inZone,
        feeInCentavos: deliveryResult.feeInCentavos,
        etaMinutes: deliveryResult.etaMinutes,
        error: deliveryResult.error,
      })
    }

    // PROCESSING_PAYMENT → needs checkout
    currentState = actor.getSnapshot()
    stateStr = getStateString(currentState)
    if (stateStr === "checkout.processing_payment") {
      const checkoutStatusTimer = setTimeout(() => onStatus?.("Fechando seu pedido…"), 1500)
      const checkoutResult = await withTimeout(
        processCheckout(currentState.context, sessionId),
        CHECKOUT_TIMEOUT,
        { success: false, paymentMethod: currentState.context.paymentMethod ?? "unknown", message: "Timeout ao processar pagamento. Tente novamente." } as Awaited<ReturnType<typeof processCheckout>>,
        "processCheckout",
      )
      clearTimeout(checkoutStatusTimer)
      actor.send({
        type: "CHECKOUT_RESULT",
        success: checkoutResult.success,
        paymentMethod: checkoutResult.paymentMethod,
        checkoutData: checkoutResult,
      })

      // After successful checkout, fetch loyalty
      currentState = actor.getSnapshot()
      stateStr = getStateString(currentState)
      if (stateStr === "checkout.order_placed") {
        const stamps = await withTimeout(
          fetchLoyaltyBalance(currentState.context, sessionId),
          LOYALTY_TIMEOUT,
          null,
          "fetchLoyalty:postCheckout",
        )
        actor.send({ type: "LOYALTY_LOADED", stamps })
      }
    }

    // LOYALTY_CHECK → fetch balance
    currentState = actor.getSnapshot()
    stateStr = getStateString(currentState)
    if (stateStr === "loyalty_check") {
      const stamps = await withTimeout(
        fetchLoyaltyBalance(currentState.context, sessionId),
        LOYALTY_TIMEOUT,
        null,
        "fetchLoyalty:check",
      )
      actor.send({ type: "LOYALTY_LOADED", stamps })
    }

    // POST_ORDER + CANCEL_ORDER → PONR-aware cancel via orchestrator
    currentState = actor.getSnapshot()
    stateStr = getStateString(currentState)
    if (stateStr === "post_order" && event.type === "CANCEL_ORDER" && currentState.context.orderId) {
      // The cancel_order and amend_order tools are in the LLM's tool set for post_order.
      // The LLM will present the order status and options. No machine-level cancel here —
      // the LLM calls cancel_order tool which handles PONR internally.
      // Just ensure context has orderId for the synthesizer prompt.
    }

    // ── POST_ORDER sub-states — execute mutating tools deterministically ──
    // When the machine enters a post_order sub-state (cancelling, amending,
    // regenerating_pix), the kernel executes the actual tool. The LLM proposed
    // the action via an intent; the machine validated and transitioned here.
    currentState = actor.getSnapshot()
    stateStr = getStateString(currentState)

    if (stateStr === "post_order.cancelling" && currentState.context.orderId) {
      const cancelResult = await withTimeout(
        cancelOrderAction(currentState.context, sessionId),
        CART_TIMEOUT,
        { success: false, message: "Timeout ao cancelar pedido" },
        "cancelOrder",
      )
      actor.send({
        type: "CANCEL_ORDER_RESULT",
        success: cancelResult.success,
        message: cancelResult.message ?? "",
      })
    }

    if (stateStr === "post_order.amending" && currentState.context.orderId) {
      // Amend is complex — for now, inform the customer to contact staff
      actor.send({
        type: "AMEND_ORDER_RESULT",
        success: false,
        message: "Alteração de pedido deve ser feita pelo atendente.",
      })
    }

    if (stateStr === "post_order.regenerating_pix" && currentState.context.orderId) {
      const pixResult = await withTimeout(
        regeneratePixAction(currentState.context, sessionId),
        CART_TIMEOUT,
        { success: false, message: "Timeout ao regenerar PIX" },
        "regeneratePix",
      )
      actor.send({
        type: "PIX_REGENERATED",
        success: pixResult.success,
        pixQrCodeText: pixResult.pixQrCodeText,
        pixQrCodeUrl: pixResult.pixQrCodeUrl,
      })
    }

    // OBJECTION with "thinking" → schedule follow-up
    if (event.type === "OBJECTION" && event.subtype === "thinking") {
      void scheduleFollowUpAction(actor.getSnapshot().context, sessionId, "thinking", 4)
    }
  }

  // CHECKOUT_START dominance: if the event batch included CHECKOUT_START but
  // the machine didn't reach checkout (e.g., swallowed by always guard),
  // force-send it so "costela 500g retirada pix" completes in one turn.
  const finalStateStr = getStateString(actor.getSnapshot())
  if (
    events.some((e) => e.type === "CHECKOUT_START") &&
    !finalStateStr.startsWith("checkout") &&
    !finalStateStr.startsWith("post_order")
  ) {
    actor.send({ type: "CHECKOUT_START" })
  }

  const finalSnapshot = actor.getSnapshot()
  const finalState = getStateString(finalSnapshot)
  const finalContext = finalSnapshot.context as OrderContext

  // Persist machine state for next message
  await persistMachineState(sessionId, finalSnapshot)

  // Pre-warm cart on early states so ADD_ITEM is faster on next message
  if ((finalState === "first_contact" || finalState === "browsing") && !finalContext.cartId) {
    void ensureCart(finalContext, sessionId).catch(() => {/* fire-and-forget */})
  }

  actor.stop()

  return {
    stateValue: finalState,
    context: finalContext,
    illusionContext: extractIllusionContext(finalContext),
    pendingAction: null, // All side effects already executed inline
    transitionMetadata: {
      fromState: initialState,
      toState: finalState,
      eventType: lastEventType,
      timestamp: Date.now(),
    },
  }
}
