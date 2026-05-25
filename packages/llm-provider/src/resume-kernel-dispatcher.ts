// Resume-side kernel dispatcher — audit-2026-05-24 P1-3.
//
// Closes the "task 22" gap noted in `apps/api/src/adapters/resume-dispatcher.ts`:
// when a parked envelope resumes after PIX confirmation, the kernel-executor
// path that originally would have run the mutation (addItemToCart /
// processCheckout / cancelOrder / regeneratePix) does NOT execute — there is
// no XState machine reconstructed on the resume side. The intent-dispatcher
// (post-adjudication EXECUTE consumer) returns `kind: "skipped"` for any tool
// in DETERMINISTIC_KERNEL_COVERAGE so the responder hot path doesn't double-
// execute. On resume that contract becomes a silent drop.
//
// This module owns the resume-side dispatch for kernel-covered mutations.
// The defer-resolver subscriber re-adjudicates the parked envelope; on
// EXECUTE / REWRITE it calls the resume-dispatcher adapter, which now
// invokes this dispatcher whenever the inner intent-dispatcher returns
// `skipped` (the kernel-covered case) OR the parked envelope is a
// kernel-direct kind (`order.item.add` / `order.checkout.create` /
// `order.cancel` / `payment.pix.regenerate`).
//
// Scope (deliberately narrow):
//   - Only the four mutations the kernel-executor performs today are
//     wired. The intent-dispatcher's handler bindings (handoff_to_human,
//     schedule_follow_up, set_pix_details) still own non-kernel resumes.
//   - The dispatcher does NOT rebuild the XState machine. The kernel-
//     executor's `executeKernel` runs only on the synchronous responder
//     path; resume-side mutations call the underlying tool functions
//     directly. The fresh adjudicate() decision already validated the
//     envelope against current state, so a second machine pass would
//     introduce its own race surface.
//   - No new envelope kinds, no new executors — strictly the existing
//     deterministic-kernel surface.

import type { IntentEnvelope, IntentActor } from "@adjudicate/core"
import type { AgentContext } from "@ibatexas/types"
import { Channel } from "@ibatexas/types"
import {
  addToCart,
  createCheckout,
  cancelOrder,
  regeneratePix,
} from "@ibatexas/tools"
import {
  KERNEL_INTENT_KIND_ADD_ITEM,
  KERNEL_INTENT_KIND_CHECKOUT,
  KERNEL_INTENT_KIND_CANCEL,
  KERNEL_INTENT_KIND_PIX_REGENERATE,
} from "./kernel-executor-envelopes.js"

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Result of dispatching a resumed envelope. The defer-resolver subscriber
 * (via the resume-dispatcher adapter) uses this to decide whether to log
 * success or surface a failure into the DLQ.
 *
 *   - `executed`: the underlying tool ran. `result` is the tool's return.
 *   - `unsupported`: the envelope kind / toolName is not on the resume
 *     dispatch table. This is a structural error (someone parked an
 *     envelope the resume path can't run); the caller logs and returns
 *     void per the fail-closed adapter contract.
 *   - `failed`: the underlying tool threw. The adapter logs and returns
 *     void to protect the subscriber loop.
 */
export type ResumeKernelDispatchResult =
  | { readonly kind: "executed"; readonly toolName: string; readonly result: unknown }
  | { readonly kind: "unsupported"; readonly envelopeKind: string; readonly toolName?: string }
  | { readonly kind: "failed"; readonly toolName: string; readonly error: Error }

// ── Tool-name aliases ─────────────────────────────────────────────────────────
//
// The LLM-proposed path parks envelopes whose `kind` is the generic
// `order.tool.propose` and whose payload carries the real `toolName`. The
// kernel-direct path parks envelopes whose `kind` IS the mutation taxonomy
// kind. We map both into the same dispatch identity here.

const TOOLNAME_ADD_TO_CART = "add_to_cart"
const TOOLNAME_CREATE_CHECKOUT = "create_checkout"
const TOOLNAME_CANCEL_ORDER = "cancel_order"
const TOOLNAME_REGENERATE_PIX = "regenerate_pix"

/**
 * Resolve the resume-side dispatch identity from a parked envelope.
 * Returns null when the envelope is not on the kernel-covered surface.
 */
function resumeIdentity(envelope: IntentEnvelope): string | null {
  const kind = envelope.kind
  // Kernel-direct kinds map 1:1.
  if (kind === KERNEL_INTENT_KIND_ADD_ITEM) return TOOLNAME_ADD_TO_CART
  if (kind === KERNEL_INTENT_KIND_CHECKOUT) return TOOLNAME_CREATE_CHECKOUT
  if (kind === KERNEL_INTENT_KIND_CANCEL) return TOOLNAME_CANCEL_ORDER
  if (kind === KERNEL_INTENT_KIND_PIX_REGENERATE) return TOOLNAME_REGENERATE_PIX

  // LLM-proposed path: kind is `order.tool.propose` and payload.toolName
  // carries the real identity.
  if (kind === "order.tool.propose") {
    const payload = envelope.payload as { toolName?: unknown } | null
    if (
      payload &&
      typeof payload === "object" &&
      typeof payload.toolName === "string"
    ) {
      return payload.toolName
    }
  }

  return null
}

// ── Dispatch deps (injectable for tests) ──────────────────────────────────────

/**
 * The four tool functions the resume path invokes. The interface lets tests
 * inject spies without monkey-patching `@ibatexas/tools` at the module level.
 * Production callers leave these undefined and get the live tool functions.
 */
export interface ResumeKernelDispatchDeps {
  readonly addToCart?: typeof addToCart
  readonly createCheckout?: typeof createCheckout
  readonly cancelOrder?: typeof cancelOrder
  readonly regeneratePix?: typeof regeneratePix
}

// ── Context builder ───────────────────────────────────────────────────────────

/**
 * Build the minimal `AgentContext` the resume-side tool calls need.
 *
 *   - `channel = Channel.WhatsApp`: PIX-deferred intents are exclusively a
 *     WhatsApp concern (the web checkout path returns the PIX QR
 *     synchronously; it never DEFERs). When future channels start
 *     DEFER-ing, the parked envelope must start carrying its source
 *     channel and the resume dispatcher should read it.
 *   - `userType = "customer"`: resume can only happen for customer-
 *     initiated parks. System-actor kinds (`order.cancel.system`) never
 *     DEFER via the responder hot path.
 *   - `customerId`: audit-2026-05-25 (I6) — sourced from
 *     `actor.sessionId` when `actor.principal === "user"`. Pre-fix this
 *     was always `undefined`, which broke cancelOrder + regeneratePix
 *     ("Autenticação necessária" hard-throw on missing customerId) and
 *     addToCart for authenticated carts (assertCartOwnership rejected
 *     undefined against a cart with a non-null customer_id). The
 *     dispatcher's try/catch converted those throws to
 *     `{kind: 'failed'}`, the adapter logged them, and the defer-resolver
 *     committed the resume as durable — silent data loss for every
 *     PIX-deferred kernel-direct intent owned by an authenticated
 *     customer.
 *
 *     Customer-initiated routes (buildCustomerEnvelope at
 *     customer-intent-gateway.ts) set `actor.sessionId = customerId`
 *     by convention. System-actor envelopes use
 *     `${source}:${eventId}` for sessionId — those should never reach
 *     this resume path, but the principal check defense-in-depths
 *     against a malformed parked envelope leaking a non-customerId
 *     value through.
 */
function buildResumeKernelContext(
  sessionId: string,
  actor: IntentActor,
): AgentContext {
  const customerId =
    actor.principal === "user" && actor.sessionId.length > 0
      ? actor.sessionId
      : undefined
  return {
    sessionId,
    channel: Channel.WhatsApp,
    userType: "customer",
    ...(customerId !== undefined ? { customerId } : {}),
  }
}

// ── Payload extractors ───────────────────────────────────────────────────────
//
// For LLM-proposed envelopes (`kind: order.tool.propose`), the input is in
// `payload.input`. For kernel-direct envelopes, the input IS the payload.
// Both shapes are validated by the underlying tool's Zod schema (e.g.
// CreateCheckoutInputSchema); we just hand the raw object across.

function extractInput(envelope: IntentEnvelope): unknown {
  if (envelope.kind === "order.tool.propose") {
    const p = envelope.payload as { input?: unknown } | null
    if (p && typeof p === "object") {
      return p.input ?? {}
    }
    return {}
  }
  // Kernel-direct envelopes: the payload IS the input.
  return envelope.payload ?? {}
}

// ── Public entrypoint ─────────────────────────────────────────────────────────

/**
 * Dispatch a resumed kernel-covered envelope by invoking the underlying
 * tool function. Returns a structured result; never throws on tool errors —
 * the adapter contract is fail-closed so the subscriber loop is not
 * broken by tool exceptions.
 *
 * The caller is responsible for re-adjudicating the envelope BEFORE calling
 * this dispatcher — by the time we run, the kernel has already approved
 * the resumed mutation. We do not re-adjudicate here.
 */
export async function dispatchResumedKernelEnvelope(
  envelope: IntentEnvelope,
  sessionId: string,
  deps: ResumeKernelDispatchDeps = {},
): Promise<ResumeKernelDispatchResult> {
  const identity = resumeIdentity(envelope)
  if (identity === null) {
    return {
      kind: "unsupported",
      envelopeKind: envelope.kind,
    }
  }

  const ctx = buildResumeKernelContext(sessionId, envelope.actor)
  const input = extractInput(envelope)

  const addToCartFn = deps.addToCart ?? addToCart
  const createCheckoutFn = deps.createCheckout ?? createCheckout
  const cancelOrderFn = deps.cancelOrder ?? cancelOrder
  const regeneratePixFn = deps.regeneratePix ?? regeneratePix

  try {
    let result: unknown
    switch (identity) {
      case TOOLNAME_ADD_TO_CART: {
        // addToCart input: { cartId, variantId, quantity, allergens? }.
        // The Zod schema lives in `@ibatexas/types`; we trust the parked
        // payload was already shape-checked at park time.
        result = await addToCartFn(
          input as Parameters<typeof addToCart>[0],
          ctx,
        )
        break
      }
      case TOOLNAME_CREATE_CHECKOUT: {
        result = await createCheckoutFn(
          input as Parameters<typeof createCheckout>[0],
          ctx,
        )
        break
      }
      case TOOLNAME_CANCEL_ORDER: {
        result = await cancelOrderFn(
          input as Parameters<typeof cancelOrder>[0],
          ctx,
        )
        break
      }
      case TOOLNAME_REGENERATE_PIX: {
        result = await regeneratePixFn(
          input as Parameters<typeof regeneratePix>[0],
          ctx,
        )
        break
      }
      default:
        // resumeIdentity returned a non-null string but it's not one of
        // the four kernel-covered tools — the parked envelope is for a
        // tool we don't know how to resume. Caller logs.
        return {
          kind: "unsupported",
          envelopeKind: envelope.kind,
          toolName: identity,
        }
    }
    return { kind: "executed", toolName: identity, result }
  } catch (err) {
    return {
      kind: "failed",
      toolName: identity,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}

/**
 * @internal — re-exported for tests that want to assert routing without
 * invoking the underlying tools.
 */
export const __testOnly__resumeIdentity = resumeIdentity
