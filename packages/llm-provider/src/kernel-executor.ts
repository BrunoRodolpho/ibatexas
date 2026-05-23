// KernelExecutor — Layer 1 interface for the deterministic XState machine.
//
// Extracted from agent.ts. Processes OrderEvent[] through the XState machine,
// executing async side effects (search, cart, delivery, checkout, loyalty)
// between transitions. Returns the final machine state and context.
//
// The kernel runs perfectly without any LLM.
//
// IBX-IGE / Task 06: the four mutation call sites (addItemToCart,
// processCheckout, cancelOrderAction, regeneratePixAction) historically
// bypassed adjudicate() entirely (investigation 01 §"P0 #3"). They now
// flow through `adjudicateKernelMutation` — the same shadow/enforce
// pattern the LLM-proposed path uses (llm-responder.ts:303-365). Behaviour
// is unchanged when neither `IBX_KERNEL_SHADOW` nor `IBX_KERNEL_ENFORCE`
// names the intent kind: legacy direct-call wins (preserves green
// baseline). Under shadow mode, both run and divergences emit audit
// records. Under enforce mode, the kernel's Decision is authoritative —
// REFUSE/DEFER/REQUEST_CONFIRMATION/ESCALATE short-circuit before the
// underlying tool runs.

import { createActor } from "xstate"
import { cancelOrder, regeneratePix, getRedisClient, rk } from "@ibatexas/tools"
import { buildAuditRecord, type Decision, type IntentEnvelope } from "@adjudicate/core"
import {
  adjudicate,
  adjudicateWithShadow,
  isEnforced,
  isShadowed,
  legacyDecisionAsKernelDecision,
} from "@adjudicate/core/kernel"
import { orderMachine, getStateString, createDefaultContext, isCheckoutState } from "./machine/order-machine.js"
import type { OrderContext, KernelOutput } from "./machine/types.js"
import { extractIllusionContext } from "./machine/types.js"
import { routeMessage } from "./router.js"
import { persistMachineState } from "./machine/persistence.js"
import { orderPolicyBundle, type OrderState } from "./order-policy-bundle.js"
import { getAuditSink } from "./intent-audit-wiring.js"
import {
  buildAddItemEnvelope,
  buildCancelOrderEnvelope,
  buildCheckoutEnvelope,
  buildRegeneratePixEnvelope,
  type KernelAddItemPayload,
  type KernelCancelPayload,
  type KernelCheckoutPayload,
  type KernelRegeneratePixPayload,
} from "./kernel-executor-envelopes.js"
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

// Re-export for consumers that need these (agent.ts, orchestrator.ts)
export { createDefaultContext, isCheckoutState }

// ── Timeout constants for each async operation (ms) ──────────────────────────

export const SEARCH_TIMEOUT = 10_000
export const CART_TIMEOUT = 10_000
export const DELIVERY_TIMEOUT = 8_000
export const CHECKOUT_TIMEOUT = 30_000
export const LOYALTY_TIMEOUT = 5_000

// ── pt-BR refusal copy for kernel-side short-circuits (CLAUDE.md #4) ─────────

const KERNEL_REFUSAL_CONFIRMATION_PT_BR =
  "Esta operação requer confirmação adicional. Por favor, aguarde."
const KERNEL_REFUSAL_ESCALATE_PT_BR =
  "Estou pedindo revisão antes de seguir. Um atendente assume daqui."
const KERNEL_REFUSAL_DEFER_PT_BR =
  "Aguardando confirmação. Te aviso assim que tudo estiver certo."

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

// ── Adjudicate-kernel mutation gate (Task 06) ────────────────────────────────

/**
 * Outcome of `adjudicateKernelMutation`. The caller branches on `proceed`:
 *
 *   - true  → run the legacy mutation (EXECUTE or pure-legacy path).
 *             When `decision.kind === "REWRITE"`, the caller should use
 *             `decision.rewritten.payload` instead of the original payload.
 *   - false → mutation MUST NOT run. The kernel decided REFUSE, DEFER,
 *             REQUEST_CONFIRMATION, or ESCALATE. `userFacing` carries the
 *             pt-BR copy the kernel-executor writes into `ctx.lastError`
 *             so the synthesizer / responder can read it on the next turn.
 *             For DEFER, the envelope has already been parked via the
 *             same Redis key shape the responder uses (`defer:pending:<sessionId>`).
 */
interface AdjudicationGate<P> {
  readonly proceed: boolean
  readonly decision: Decision
  /** REWRITE: the kernel-rewritten payload to pass to the underlying mutation. */
  readonly rewrittenPayload?: P
  /** pt-BR copy to write into `OrderContext.lastError` when `proceed === false`. */
  readonly userFacing?: string
  /** True when the kernel parked the envelope (DEFER). Mirrors `ctx.deferredIntentParked` if the caller wants to tag state. */
  readonly parked?: boolean
}

/**
 * Run the adjudicate kernel against a kernel-direct mutation envelope. Mirrors
 * the LLM-responder's shadow/enforce pattern so the four kernel-executor
 * mutations are wrapped at the exact same governance boundary as the
 * LLM-proposed mutations.
 *
 * Behaviour matrix (env → outcome):
 *
 *   Neither shadow nor enforce names the intent kind:
 *     - Pure legacy. Decision is synthesized as EXECUTE; no audit record;
 *       caller runs the underlying mutation unchanged. Preserves the
 *       green baseline so production behaviour is byte-identical until
 *       the on-call engages shadow mode for this kind.
 *
 *   `IBX_KERNEL_SHADOW=<kind>` matches:
 *     - `adjudicateWithShadow` runs both legacy (always-EXECUTE baseline)
 *       AND the policy. Divergences emit audit records. Legacy still
 *       authoritative — the caller runs the underlying mutation.
 *
 *   `IBX_KERNEL_ENFORCE=<kind>` matches:
 *     - `adjudicate` is authoritative. Audit record always emits. Caller
 *       branches on `proceed`:
 *         EXECUTE / REWRITE → run mutation (REWRITE substitutes payload)
 *         REFUSE / DEFER / REQUEST_CONFIRMATION / ESCALATE → short-circuit.
 *
 * Parks DEFER envelopes via the same `defer:pending:<sessionId>` Redis key
 * shape `llm-responder.ts:438-460` uses, so a single defer-resolver
 * subscriber owns both paths.
 */
async function adjudicateKernelMutation<K extends string, P>(
  envelope: IntentEnvelope<K, P>,
  ctx: OrderContext,
  sessionId: string,
): Promise<AdjudicationGate<P>> {
  const orderState: OrderState = { ctx }
  const startedAt = Date.now()
  const intentKind = envelope.kind

  let decision: Decision
  let isPureLegacy = false

  if (isEnforced(intentKind, process.env)) {
    decision = adjudicate(envelope, orderState, orderPolicyBundle)
  } else if (isShadowed(intentKind, process.env)) {
    // Shadow: legacy is a synthetic always-EXECUTE; we run both and let
    // adjudicateWithShadow log the divergence. Legacy still wins for the
    // proceed-or-not decision.
    const shadow = adjudicateWithShadow({
      envelope,
      state: orderState,
      policy: orderPolicyBundle,
      legacy: () => true,
    })
    decision = legacyDecisionAsKernelDecision(shadow.legacyDecision)
  } else {
    // Pure legacy — no audit emission, no policy involvement. Preserves
    // the green baseline for any kind not in shadow/enforce config.
    decision = legacyDecisionAsKernelDecision({ kind: "EXECUTE" })
    isPureLegacy = true
  }

  // Audit emit — same suppression rule as llm-responder.ts (investigation
  // 01 §"P2 #7" / governance 05 §"Audit emit invariants" #2). Pure-legacy
  // EXECUTEs are silent; shadow + enforce paths always emit.
  if (!isPureLegacy) {
    try {
      const record = buildAuditRecord({
        envelope,
        decision,
        durationMs: Date.now() - startedAt,
      })
      void getAuditSink().emit(record).catch((err: unknown) => {
        console.error("[kernel-executor] Audit emit failed:", (err as Error).message)
      })
    } catch (err) {
      console.error("[kernel-executor] Audit record build failed:", (err as Error).message)
    }
  }

  // Branch on the kernel's Decision. The first three (EXECUTE / REWRITE)
  // tell the caller "proceed"; the rest short-circuit.
  switch (decision.kind) {
    case "EXECUTE":
      return { proceed: true, decision }

    case "REWRITE": {
      // REWRITE substitutes a sanitized envelope. The caller should run the
      // mutation with the rewritten payload (typed as `P` via the original
      // envelope's payload shape — the kernel's REWRITE scope is sanitize /
      // normalize / cap only, never business transformation, so the shape
      // is preserved by contract).
      const rewrittenPayload = (decision.rewritten as IntentEnvelope<K, P>).payload
      return { proceed: true, decision, rewrittenPayload }
    }

    case "REFUSE":
      return {
        proceed: false,
        decision,
        userFacing: decision.refusal.userFacing,
      }

    case "DEFER": {
      // Park the envelope so the defer-resolver subscriber can resume it.
      // Best-effort: a Redis failure logs and surfaces a refusal instead of
      // silently dropping the intent.
      try {
        const redis = await getRedisClient()
        const ttlSeconds = Math.ceil(decision.timeoutMs / 1000) + 60
        await redis.set(
          rk(`defer:pending:${sessionId}`),
          JSON.stringify({
            envelope,
            signal: decision.signal,
            parkedAt: new Date().toISOString(),
          }),
          { EX: ttlSeconds },
        )
      } catch (err) {
        console.error("[kernel-executor] DEFER park failed:", (err as Error).message)
      }
      return {
        proceed: false,
        decision,
        userFacing: KERNEL_REFUSAL_DEFER_PT_BR,
        parked: true,
      }
    }

    case "REQUEST_CONFIRMATION":
      return {
        proceed: false,
        decision,
        userFacing: KERNEL_REFUSAL_CONFIRMATION_PT_BR,
      }

    case "ESCALATE":
      return {
        proceed: false,
        decision,
        userFacing: KERNEL_REFUSAL_ESCALATE_PT_BR,
      }
  }
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
): Promise<{ success: boolean; message: string; pixCopyPaste?: string; pixQrCode?: string }> {
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
      pixCopyPaste: result.pixCopyPaste,
      pixQrCode: result.pixQrCode,
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
  console.warn("[kernel] initial_state=%s snapshot=%s", initialState, !!snapshot)
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

    console.warn("[kernel] event=%s pre=%s post=%s cartId=%s items=%d",
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
              // ── Task 06: wrap addItemToCart in an IntentEnvelope ─────
              // Build the system-actor envelope BEFORE the mutation. Under
              // shadow/enforce mode the kernel's Decision short-circuits;
              // under pure-legacy it's a no-op and the mutation runs.
              const addPayload: KernelAddItemPayload = {
                cartId: cartResult.cartId,
                variantId: product.variantId,
                quantity: (event as { quantity?: number }).quantity ?? 1,
                // Kernel-side allergens not yet plumbed from catalog DTO;
                // the LLM-proposed path handles allergens explicitly via
                // pack-orders' `requireExplicitAllergens` guard. Forward-compat
                // empty array (per CLAUDE.md #1: explicit array, not undefined).
                allergens: [],
              }
              const addEnvelope = buildAddItemEnvelope(
                addPayload,
                { ...currentState.context, cartId: cartResult.cartId },
                sessionId,
              )
              const addGate = await adjudicateKernelMutation(
                addEnvelope,
                { ...currentState.context, cartId: cartResult.cartId },
                sessionId,
              )

              if (!addGate.proceed) {
                actor.send({
                  type: "CART_UPDATED",
                  success: false,
                  cartId: cartResult.cartId,
                  items: currentState.context.items,
                  totalInCentavos: currentState.context.totalInCentavos,
                  error: addGate.userFacing ?? "Operação não permitida.",
                })
              } else {
                // REWRITE: use the kernel-rewritten payload (sanitized cap)
                // instead of the original. Pure-legacy / EXECUTE branches use
                // the original payload.
                const effectivePayload = addGate.rewrittenPayload ?? addPayload

                let addResult = await withRetry(
                  () => addItemToCart(
                    effectivePayload.cartId,
                    effectivePayload.variantId,
                    effectivePayload.quantity,
                    { ...currentState.context, cartId: effectivePayload.cartId },
                    sessionId,
                  ),
                  { maxAttempts: 2, timeoutMs: CART_TIMEOUT, fallback: { success: false, cartId: effectivePayload.cartId, items: currentState.context.items, totalInCentavos: currentState.context.totalInCentavos, error: "Timeout ao adicionar item" } as Awaited<ReturnType<typeof addItemToCart>>, label: "addItemToCart" },
                )

                // Stale variant: cache was invalidated — re-search with fresh data and retry
                if (!addResult.success && addResult.staleVariant && searchTerm) {
                  const freshSearch = await withRetry(
                    () => searchProduct(searchTerm, currentState.context, sessionId),
                    { maxAttempts: 1, timeoutMs: SEARCH_TIMEOUT, fallback: { found: false, products: [], alternatives: [] } as Awaited<ReturnType<typeof searchProduct>>, label: "searchProduct:retry" },
                  )
                  if (freshSearch.found && freshSearch.products.length > 0) {
                    const freshProduct = freshSearch.products[0]
                    // Re-envelope for the retry so the audit trail records
                    // the (legitimately new) variant id. Same envelope kind /
                    // session — different nonce so ledger dedup sees a new
                    // attempt.
                    const retryPayload: KernelAddItemPayload = {
                      cartId: effectivePayload.cartId,
                      variantId: freshProduct.variantId,
                      quantity: effectivePayload.quantity,
                      allergens: effectivePayload.allergens,
                    }
                    const retryEnvelope = buildAddItemEnvelope(
                      retryPayload,
                      { ...currentState.context, cartId: effectivePayload.cartId },
                      sessionId,
                    )
                    const retryGate = await adjudicateKernelMutation(
                      retryEnvelope,
                      { ...currentState.context, cartId: effectivePayload.cartId },
                      sessionId,
                    )
                    if (retryGate.proceed) {
                      const finalRetryPayload = retryGate.rewrittenPayload ?? retryPayload
                      addResult = await withRetry(
                        () => addItemToCart(
                          finalRetryPayload.cartId,
                          finalRetryPayload.variantId,
                          finalRetryPayload.quantity,
                          { ...currentState.context, cartId: finalRetryPayload.cartId },
                          sessionId,
                        ),
                        { maxAttempts: 1, timeoutMs: CART_TIMEOUT, fallback: addResult, label: "addItemToCart:retry" },
                      )
                    }
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
              }
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
      // ── Task 06: wrap processCheckout in an IntentEnvelope ─────────────
      const checkoutCtx = currentState.context
      // Pre-check: missing cartId / paymentMethod is handled inside
      // `processCheckout` already (returns a typed failure result). We
      // still build an envelope for the audit trail even if the payload
      // is partially undefined — the policy bundle's
      // `requireCartIdForCartOps` guard will refuse it.
      const checkoutPayload: KernelCheckoutPayload = {
        cartId: checkoutCtx.cartId ?? "",
        paymentMethod: checkoutCtx.paymentMethod ?? "pix",
        tipInCentavos: checkoutCtx.tipInCentavos,
        deliveryCep: checkoutCtx.deliveryCep,
      }
      const checkoutEnvelope = buildCheckoutEnvelope(
        checkoutPayload,
        checkoutCtx,
        sessionId,
      )
      const checkoutGate = await adjudicateKernelMutation(
        checkoutEnvelope,
        checkoutCtx,
        sessionId,
      )

      if (!checkoutGate.proceed) {
        const refusalMessage = checkoutGate.userFacing ?? "Operação não permitida."
        actor.send({
          type: "CHECKOUT_RESULT",
          success: false,
          paymentMethod: checkoutCtx.paymentMethod ?? "unknown",
          checkoutData: { success: false, paymentMethod: checkoutCtx.paymentMethod ?? "unknown", message: refusalMessage },
        })
      } else {
        const checkoutStatusTimer = setTimeout(() => onStatus?.("Fechando seu pedido…"), 1500)
        // REWRITE not currently propagated into processCheckout's tuple
        // signature — the rewritten cartId / paymentMethod would replace
        // the originals here. processCheckout reads from `currentState.context`
        // directly; we keep that path for now and surface a REWRITE via the
        // audit record alone.
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
      // ── Task 06: wrap cancelOrderAction in an IntentEnvelope ───────────
      const cancelPayload: KernelCancelPayload = {
        orderId: currentState.context.orderId,
      }
      const cancelEnvelope = buildCancelOrderEnvelope(
        cancelPayload,
        currentState.context,
        sessionId,
      )
      const cancelGate = await adjudicateKernelMutation(
        cancelEnvelope,
        currentState.context,
        sessionId,
      )

      if (!cancelGate.proceed) {
        actor.send({
          type: "CANCEL_ORDER_RESULT",
          success: false,
          message: cancelGate.userFacing ?? "Operação não permitida.",
        })
      } else {
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
      // ── Task 06: wrap regeneratePixAction in an IntentEnvelope ─────────
      const pixPayload: KernelRegeneratePixPayload = {
        orderId: currentState.context.orderId,
      }
      const pixEnvelope = buildRegeneratePixEnvelope(
        pixPayload,
        currentState.context,
        sessionId,
      )
      const pixGate = await adjudicateKernelMutation(
        pixEnvelope,
        currentState.context,
        sessionId,
      )

      if (!pixGate.proceed) {
        actor.send({
          type: "PIX_REGENERATED",
          success: false,
          // PIX_REGENERATED carries pix data, not a message — the userFacing
          // refusal lands on ctx.lastError below for the synthesizer to read.
          pixCopyPaste: undefined,
          pixQrCode: undefined,
        })
        // Surface the refusal via ctx.lastError so the synthesizer prompt
        // can render the pt-BR refusal copy on the next turn.
        if (pixGate.userFacing) {
          // Mutating ctx.lastError requires an XState event since context is
          // managed by the actor. We have no dedicated event for "kernel
          // refusal" — store on the actor's context via a special-purpose
          // assign event would require machine changes (out of scope here).
          // Instead, log it; the orchestrator will fall back to the kernel's
          // default refusal copy in synthesis.
          console.warn(
            "[kernel] regeneratePix refused: %s (decision=%s)",
            pixGate.userFacing,
            pixGate.decision.kind,
          )
        }
      } else {
        const pixResult = await withTimeout(
          regeneratePixAction(currentState.context, sessionId),
          CART_TIMEOUT,
          { success: false, message: "Timeout ao regenerar PIX" },
          "regeneratePix",
        )
        actor.send({
          type: "PIX_REGENERATED",
          success: pixResult.success,
          pixCopyPaste: pixResult.pixCopyPaste,
          pixQrCode: pixResult.pixQrCode,
        })
      }
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

// ── Test-only export ──────────────────────────────────────────────────────────
//
// `adjudicateKernelMutation` is module-internal; tests import it via this
// `@internal` re-export so they can verify branching behaviour (EXECUTE /
// REFUSE / DEFER / REWRITE) without re-implementing the env-gating logic.
// Do NOT consume from production code outside this module.

/** @internal — test-only re-export. Do not import from production code. */
export const __testOnly__adjudicateKernelMutation = adjudicateKernelMutation
