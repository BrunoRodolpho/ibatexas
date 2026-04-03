// AgentOrchestrator — Hybrid State-Flow pipeline for IbateXas.
//
// 4-phase pipeline per message:
//   1. ROUTER:      keyword regex → structured OrderEvent[]
//   2. KERNEL:      XState processes events → guards, context mutations, async side effects
//   3. SYNTHESIZER: state + context → tiny system prompt + filtered tools
//   4. LLM:        synthesized prompt + message → natural language response
//
// The LLM NEVER makes business decisions (auth, availability, payment).
// It only generates customer-facing text from the synthesized prompt.
//
// Info-only tools (search, details, nutritional) are still available to the LLM
// per state, but cart/checkout tools are machine-controlled.

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js"
import { Channel, type AgentContext, type AgentMessage, type StreamChunk } from "@ibatexas/types"
import { loadSchedule } from "@ibatexas/tools"

// Machine imports
import { extractIllusionContext, createLatencyEnvelope, ALLOWED_POST_LLM_EVENTS } from "./machine/types.js"
import type { OrderContext } from "./machine/types.js"
import { routeMessage, extractCustomerName } from "./router.js"
import { synthesizePrompt } from "./prompt-synthesizer.js"
import type { SupervisorModifiers } from "./prompt-synthesizer.js"
import { loadMachineState, persistMachineState } from "./machine/persistence.js"
import { fetchCustomerProfile, ensureCart, estimateDeliveryAction, loadCachedPixDetails } from "./machine/actions.js"
import { createActor } from "xstate"
import { orderMachine } from "./machine/order-machine.js"

// Layer 3: Supervisor
import { evaluateSupervisor } from "./supervisor.js"

// Layer 1: Kernel executor
import {
  executeKernel,
  createDefaultContext,
  isCheckoutState,
  withTimeout,
  CART_TIMEOUT,
  DELIVERY_TIMEOUT,
  LOYALTY_TIMEOUT,
} from "./kernel-executor.js"

// Layer 2: LLM responder
import {
  generateResponse,
  getSessionTokenCount,
  SESSION_TOKEN_BUDGET,
  _resetClient,
} from "./llm-responder.js"

// Re-export for backward compatibility
export { _resetClient }

// ── Main agent loop ───────────────────────────────────────────────────────────

/**
 * Run the 4-phase Hybrid State-Flow pipeline:
 *   1. Router:      message → OrderEvent[]
 *   2. Kernel:      events → state transitions + async side effects
 *   3. Synthesizer: state + context → tiny system prompt + filtered tools
 *   4. LLM:        synthesized prompt + message → natural language response
 */
export async function* runAgent(
  message: string,
  history: AgentMessage[],
  context: AgentContext,
): AsyncGenerator<StreamChunk> {
  // ── Load persisted machine state early (needed for budget bypass) ────────
  const loadResult = await loadMachineState(context.sessionId)
  let snapshot = loadResult?.snapshot ?? null

  console.info("[agent] snapshot_loaded=%s stale=%s reason=%s state=%s",
    !!snapshot,
    loadResult?.isStale ?? "n/a",
    loadResult?.staleReason ?? "none",
    snapshot ? (snapshot as { value?: unknown }).value : "null",
  )

  // ── Phase 1: ROUTER (run early so we can use events for stale detection) ──
  // Pass machine state to router so it can use authoritative checkout detection
  // instead of fragile history keyword matching
  let snapshotStateStr: string | undefined
  if (snapshot) {
    const sv = (snapshot as { value?: unknown }).value
    if (typeof sv === "string") snapshotStateStr = sv
    else if (typeof sv === "object" && sv !== null) {
      // Compound state like { checkout: "confirming" } → "checkout.confirming"
      const [parent, child] = Object.entries(sv)[0] ?? []
      snapshotStateStr = child ? `${parent}.${child}` : parent
    }
  }
  const events = routeMessage(message, history, snapshotStateStr)

  console.info("[agent] router_events=%s", JSON.stringify(events.map(e => ({ type: e.type, confidence: (e as { confidence?: number }).confidence }))))

  // ── Stale session detection (triple-expiry) ────────────────────────────
  if (loadResult?.isStale) {
    console.info("[agent] Discarding stale snapshot — reason: %s", loadResult.staleReason)
    snapshot = null
  } else if (snapshot) {
    // Legacy check: discard checkout snapshot on GREETING
    const snapshotValue = (snapshot as { value?: unknown }).value
    const isStaleCheckout = isCheckoutState(snapshotValue)
    const hasGreeting = events.some((e) => e.type === "GREETING")
    if (isStaleCheckout && hasGreeting) {
      console.info("[agent] Discarding stale checkout snapshot — GREETING in checkout state")
      snapshot = null
    }
  }

  // Recovery UX: if stale snapshot had cart items, inform the customer
  if (loadResult?.isStale && loadResult.snapshot) {
    const staleCtx = (loadResult.snapshot as { context?: { items?: unknown[] } })?.context
    const hadItems = Array.isArray(staleCtx?.items) && staleCtx.items.length > 0
    if (hadItems) {
      const reason = loadResult.staleReason
      const recoveryMsg = reason === "expired" || reason === "idle"
        ? "Sua sessão anterior expirou, mas estou aqui pra te ajudar de novo! O que vai ser hoje? 🍖"
        : "Tive que recomeçar aqui, mas estou pronto! O que posso fazer por você? 🍖"
      yield { type: "text_delta", delta: recoveryMsg }
      yield { type: "done", inputTokens: 0, outputTokens: 0 }
      return
    }
  }

  const isInCheckout = snapshot
    ? isCheckoutState((snapshot as { value?: unknown }).value)
    : false

  // ── Token budget check (bypassed for checkout states) ──────────────────
  // If the customer is mid-checkout, they must be allowed to complete the
  // transaction — this is a "point of no return" for the business flow.
  const currentTokens = await getSessionTokenCount(context.sessionId)
  if (!isInCheckout && currentTokens >= SESSION_TOKEN_BUDGET) {
    const phone = process.env.RESTAURANT_PHONE ?? ""
    const site = process.env.RESTAURANT_SITE_URL ?? "ibatexas.com.br"
    const contactInfo = phone
      ? `\n📞 Ligue: ${phone}\n🌐 Acesse: ${site}`
      : `\n🌐 Acesse: ${site}`
    const rateLimitMsg =
      `Por hoje cheguei no meu limite aqui, mas seu carrinho tá salvo!\n` +
      `Amanhã a gente continua de onde parou.${contactInfo ? ` Se for urgente:${contactInfo}` : ""} 🍖`
    yield { type: "text_delta", delta: rateLimitMsg }
    yield { type: "done", inputTokens: 0, outputTokens: 0 }
    return
  }

  // ── Phase 2: KERNEL ─────────────────────────────────────────────────────
  // (events already computed above for stale session detection)
  const channel = context.channel === Channel.WhatsApp ? "whatsapp" : "web" as const

  // Build initial context for new sessions
  const machineContext = createDefaultContext(channel, context.customerId ?? null)

  // If customer is authenticated, try to load profile for isNewCustomer flag
  // and pre-fill slots for returning customers (fulfillment, payment, CEP)
  if (context.customerId && !snapshot) {
    const profile = await withTimeout(
      fetchCustomerProfile(machineContext, context.sessionId),
      LOYALTY_TIMEOUT,
      { isNewCustomer: true, orderCount: 0 } as Awaited<ReturnType<typeof fetchCustomerProfile>>,
      "fetchCustomerProfile",
    )
    machineContext.isNewCustomer = profile.isNewCustomer
    // Pre-fill returning customer preferences — saves 2 questions in checkout
    if (!profile.isNewCustomer) {
      if (profile.lastFulfillment) machineContext.fulfillment = profile.lastFulfillment
      if (profile.lastPaymentMethod) machineContext.paymentMethod = profile.lastPaymentMethod
      if (profile.lastDeliveryCep) machineContext.deliveryCep = profile.lastDeliveryCep
    }
    // Pre-fill customer name if known
    if (profile.name) machineContext.customerName = profile.name

    // Pre-fill PIX details for returning customers (name, email, CPF)
    const pixCache = await withTimeout(
      loadCachedPixDetails(context.customerId!),
      1500,
      null,
      "loadCachedPixDetails",
    )
    if (pixCache) {
      if (pixCache.email) machineContext.customerEmail = pixCache.email
      if (pixCache.cpf) machineContext.customerTaxId = pixCache.cpf
      if (pixCache.name && !machineContext.customerName) machineContext.customerName = pixCache.name
    }

    // Session recovery: if Redis snapshot expired but Medusa cart still exists,
    // reconstruct cart data so the customer doesn't lose their items
    const recoveredCart = await withTimeout(
      ensureCart(machineContext, context.sessionId),
      CART_TIMEOUT,
      { success: false, cartId: "", items: [], totalInCentavos: 0 } as Awaited<ReturnType<typeof ensureCart>>,
      "ensureCart:recovery",
    )
    if (recoveredCart.success && recoveredCart.items.length > 0) {
      machineContext.cartId = recoveredCart.cartId
      machineContext.items = recoveredCart.items
      machineContext.totalInCentavos = recoveredCart.totalInCentavos
    }
  }

  // Name extraction from message — non-blocking, stores name in context
  if (!machineContext.customerName) {
    const detectedName = extractCustomerName(message)
    if (detectedName) machineContext.customerName = detectedName
  }

  const statusMessages: string[] = []
  const kernelOutput = await executeKernel(
    events,
    machineContext,
    context.sessionId,
    snapshot,
    (msg) => statusMessages.push(msg),
  )
  const { stateValue, context: machineCtx } = kernelOutput

  console.info("[agent] kernel_output state=%s cartId=%s items=%d orderId=%s",
    stateValue,
    machineCtx.cartId ?? "null",
    machineCtx.items?.length ?? 0,
    machineCtx.orderId ?? "null",
  )

  // Emit kernel metadata so the orchestrator can use state-aware fallbacks
  yield { type: "kernel_done" as const, stateValue, context: machineCtx as unknown as Record<string, unknown> }

  for (const msg of statusMessages) {
    yield { type: "status" as const, message: msg }
  }

  // ── Phase 2.5: Proactive delivery estimate for bare CEP ────────────────
  // When the router detected ASK_DELIVERY with a CEP, call estimateDeliveryAction
  // deterministically and inject the result into the prompt — don't rely on LLM.
  const askDeliveryEvent = events.find(
    (e) => e.type === "ASK_DELIVERY" && "cep" in e && (e as { cep?: string }).cep,
  ) as { type: "ASK_DELIVERY"; cep: string } | undefined

  let deliveryInjection: string | null = null
  if (askDeliveryEvent) {
    try {
      const dr = await withTimeout(
        estimateDeliveryAction(askDeliveryEvent.cep),
        DELIVERY_TIMEOUT,
        { success: false, inZone: false, feeInCentavos: 0, etaMinutes: 0, error: "Timeout" } as Awaited<ReturnType<typeof estimateDeliveryAction>>,
        "estimateDelivery:proactive",
      )
      if (dr.success && dr.inZone) {
        const fee = (dr.feeInCentavos / 100).toFixed(2).replace(".", ",")
        deliveryInjection = `\n[RESULTADO ENTREGA CEP ${askDeliveryEvent.cep}]: Entregamos! Zona: ${dr.zoneName ?? "—"}, taxa: R$${fee}, ~${dr.etaMinutes}min.`
      } else {
        const addr = process.env.RESTAURANT_ADDRESS || process.env.NEXT_PUBLIC_ADDRESS || ""
        deliveryInjection = `\n[RESULTADO ENTREGA CEP ${askDeliveryEvent.cep}]: Fora da área de entrega.${addr ? ` Endereço para retirada: ${addr}.` : ""} Sugira retirada.`
      }
    } catch {
      deliveryInjection = `\n[RESULTADO ENTREGA CEP ${askDeliveryEvent.cep}]: Erro ao verificar. Peça para o cliente tentar novamente.`
    }
  }

  // ── PIX data (buffered — yield AFTER LLM text so customer gets explanation first) ──
  const cr = machineCtx.checkoutResult as Record<string, unknown> | null
  const pendingPixData = (cr?.pixCopyPaste || cr?.pixQrCode)
    ? {
        type: "pix_data" as const,
        pixCopyPaste: cr.pixCopyPaste as string | undefined,
        pixQrCode: cr.pixQrCode as string | undefined,
        pixExpiresAt: cr.pixExpiresAt as string | undefined,
        orderId: machineCtx.orderId as string | undefined,
      }
    : null

  // ── Phase 2.7: SUPERVISOR (Layer 3 — evaluate and select mode) ──────────
  // Supervisor runs pure heuristics (<50ms), never modifies state.
  // Failure is safe to ignore — system works without it.
  let supervisorModifiers: SupervisorModifiers | undefined
  try {
    const envelope = createLatencyEnvelope()
    const remainingBudget = Math.max(0, envelope.hardDeadlineMs - (Date.now() - envelope.messageReceivedAt))
    const supervisorOutput = await evaluateSupervisor({
      userMessage: message,
      stateValue,
      contextSnapshot: machineCtx,
      illusionContext: extractIllusionContext(machineCtx),
      candidateResponse: "", // pre-LLM evaluation — no candidate yet
      latencyBudgetMs: remainingBudget,
      conversationHistory: history.map((m) => ({ role: m.role, content: m.content })),
    })
    if (supervisorOutput.confidence >= 0.8) {
      // High confidence: apply all modifiers
      supervisorModifiers = {
        toneAdjustment: supervisorOutput.modifiers.toneAdjustment,
        verbosityScale: supervisorOutput.modifiers.verbosityScale,
      }
    } else if (supervisorOutput.confidence >= 0.5) {
      // Medium confidence: apply tone only, keep default verbosity
      supervisorModifiers = {
        toneAdjustment: supervisorOutput.modifiers.toneAdjustment,
      }
    }
    // Below 0.5: ignore modifiers entirely
  } catch {
    // Supervisor failure is safe to ignore
  }

  // ── Phase 3: SYNTHESIZER ────────────────────────────────────────────────
  const schedule = await loadSchedule()
  const synthesized = synthesizePrompt(stateValue, machineCtx, channel, schedule, supervisorModifiers)

  // Inject proactive delivery result into system prompt
  if (deliveryInjection) {
    synthesized.systemPrompt += deliveryInjection
  }

  // ── Phase 4: LLM (natural language generation only) ─────────────────────
  const isPostCheckout = (
    stateValue.startsWith("post_order") || stateValue === "checkout.order_placed"
  ) && !!machineCtx.orderId

  const historyMessages: MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  } as MessageParam))

  const pendingMachineEvents: Array<{ type: string; payload: Record<string, unknown> }> = []

  yield* generateResponse({
    synthesized,
    message,
    history: historyMessages,
    agentContext: context,
    machineCtx,
    isPostCheckout,
    stateValue,
    onToolEvent: (evt) => pendingMachineEvents.push(evt),
  })

  // Post-LLM: inject tool events into machine (LLM proposes → Machine commits)
  // FIX 2 (P0-2): Validate event types against allowlist; process sequentially (no coalescing)
  if (pendingMachineEvents.length > 0) {
    try {
      // Load latest snapshot and replay events through machine
      const latestSnapshot = await loadMachineState(context.sessionId)
      if (latestSnapshot?.snapshot) {
        const postActor = createActor(orderMachine, {
          snapshot: latestSnapshot.snapshot,
        } as unknown as { input: OrderContext })
        postActor.start()

        const injectedTypes: string[] = []
        for (const evt of pendingMachineEvents) {
          if (!ALLOWED_POST_LLM_EVENTS.has(evt.type)) {
            console.warn("[agent] Blocked unauthorized post-LLM event: %s", evt.type)
            continue
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- XState event union requires dynamic dispatch
          postActor.send({ type: evt.type, payload: evt.payload } as any)
          injectedTypes.push(evt.type)
        }

        if (injectedTypes.length > 0) {
          await persistMachineState(context.sessionId, postActor.getSnapshot())
          console.info("[agent] Post-LLM events injected: %s", injectedTypes.join(", "))
        }
      }
    } catch (err) {
      console.error("[agent] Post-LLM event injection failed:", (err as Error).message)
    }
  }

  // Yield buffered PIX data after LLM explanation text
  if (pendingPixData) {
    yield pendingPixData
  }
}
