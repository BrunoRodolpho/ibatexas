// Kernel-executor IntentEnvelope factories (Task 06).
//
// Bridges the deterministic XState kernel's mutation call sites
// (kernel-executor.ts:282/366/425/449) to the adjudicate kernel.
//
// Per docs/adjudicate-migration/investigation/01-llm-tool-execution.md §"P0 #3":
// the four direct mutation calls (addItemToCart / processCheckout /
// cancelOrderAction / regeneratePixAction) historically bypassed adjudicate()
// entirely — no envelope, no policy review, no audit. This module exposes
// the small set of factory helpers used by `kernel-executor.ts` to wrap each
// of those mutations into a typed `IntentEnvelope<K, P>` before calling
// `adjudicate()`.
//
// Design decisions:
//
//  - Actor identity is `system` (CLAUDE.md rule #9) — the deterministic
//    kernel is route-driven, not LLM-proposed. The XState transition that
//    landed in `post_order.cancelling` / `checkout.processing_payment` /
//    etc. IS the system actor speaking; LLM intents flow through
//    `tool-registry.executeTool` → `llm-responder` → `adjudicate()` already.
//
//  - Taint is `SYSTEM` for the same reason. The taint policy on the
//    pack-orders bundle (and any future Pack) must opt these four kinds
//    into the SYSTEM grant — otherwise the kernel would refuse them on
//    taint-gate. Until that policy update lands (kind-by-kind, gated by
//    `IBX_KERNEL_ENFORCE`), this module's envelopes are still constructed
//    so the structural wrapping is in place. When enforcement is off, the
//    legacy direct-call path runs (see `kernel-executor.ts` for the
//    shadow/enforce branching).
//
//  - Intent kinds match the names task 06 baked into
//    `DETERMINISTIC_KERNEL_COVERAGE` (`intent-dispatcher.ts:107-115`) so
//    the dispatcher continues to skip these when the LLM ALSO proposes
//    them. Pack-orders' canonical `OrderIntentKind` surface uses
//    `order.item.add` instead of `order.cart.add`; we keep the task-spec
//    naming here and rely on the policy bundle's `PolicyBundle<string,
//    unknown, ...>` widening to accept the literal kinds (today's
//    pack-orders bundle was migrated under the same shim).
//
// Nonce: a fresh UUID per attempt. The XState kernel does not yet thread
// idempotency keys through its transitions; ledger dedup is owned by the
// LLM-proposed path. When the kernel needs idempotent retries it should
// thread its own nonce through ctx; for now first-attempt-only semantics
// match the legacy direct-call behaviour.

import { randomUUID } from "node:crypto"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import type { OrderContext } from "./machine/types.js"

// ── Intent kinds (mirror DETERMINISTIC_KERNEL_COVERAGE) ──────────────────────

export const KERNEL_INTENT_KIND_ADD_ITEM = "order.cart.add" as const
export const KERNEL_INTENT_KIND_CHECKOUT = "order.checkout.create" as const
export const KERNEL_INTENT_KIND_CANCEL = "order.cancel" as const
export const KERNEL_INTENT_KIND_PIX_REGENERATE = "order.pix.regenerate" as const

export type KernelIntentKind =
  | typeof KERNEL_INTENT_KIND_ADD_ITEM
  | typeof KERNEL_INTENT_KIND_CHECKOUT
  | typeof KERNEL_INTENT_KIND_CANCEL
  | typeof KERNEL_INTENT_KIND_PIX_REGENERATE

// ── Payload shapes ──────────────────────────────────────────────────────────
//
// These mirror the arguments threaded into `machine/actions.ts`. They are
// the smallest surface the adjudicate kernel needs to make a policy call;
// the underlying mutation handlers keep their existing signatures so
// `packages/tools/` remains untouched (per task 06 constraints).

/**
 * Payload for `addItemToCart` (kernel-executor.ts:282).
 * Mirrors the args list passed to `addItemToCart(cartId, variantId,
 * quantity, ctx, sessionId)`. Allergens are CLAUDE.md rule #1 territory
 * for the LLM-proposed path; the deterministic kernel composes line items
 * from the catalog DTO directly so allergens are not propagated at this
 * boundary today (pack-orders' explicit-allergens guard fires only on
 * `order.item.add` kind from the LLM-proposed surface). We carry an
 * `allergens` field for forward-compat once the kernel-side catalog read
 * starts feeding it.
 */
export interface KernelAddItemPayload {
  readonly cartId: string
  readonly variantId: string
  readonly quantity: number
  readonly allergens: ReadonlyArray<string>
}

/**
 * Payload for `processCheckout` (kernel-executor.ts:366).
 * Centavos integer per CLAUDE.md rule #2. PIX details are PII — the audit
 * sink redacts them; the kernel reads the boolean-shaped fields only.
 */
export interface KernelCheckoutPayload {
  readonly cartId: string
  readonly paymentMethod: "pix" | "card" | "cash"
  readonly tipInCentavos: number
  readonly deliveryCep: string | null
}

/**
 * Payload for `cancelOrderAction` (kernel-executor.ts:425).
 * Customer-initiated cancel via the deterministic post_order.cancelling
 * sub-state. System-cron auto-cancels use `order.cancel.system` (a
 * separate kind owned by pack-orders, not this module).
 */
export interface KernelCancelPayload {
  readonly orderId: string
}

/**
 * Payload for `regeneratePixAction` (kernel-executor.ts:449).
 * No pack-orders kind for PIX regenerate (pack-payments-pix owns charge
 * lifecycle but not regenerate). Kernel-direct only for now; policy
 * bundle treatment is fall-through-EXECUTE under shadow/enforce mode.
 */
export interface KernelRegeneratePixPayload {
  readonly orderId: string
}

// ── Factory helpers ─────────────────────────────────────────────────────────

/**
 * Common envelope-builder shape — actor is always `system` per the
 * route-driven nature of the XState kernel. Caller supplies the
 * sessionId from the kernel-executor's `executeKernel(events, ctx,
 * sessionId, ...)` argument.
 */
function buildKernelEnvelope<K extends KernelIntentKind, P>(
  kind: K,
  payload: P,
  sessionId: string,
): IntentEnvelope<K, P> {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "system", sessionId },
    // System-initiated mutations enter with the SYSTEM taint level. The
    // policy bundle's taint policy must allow SYSTEM for these four
    // kinds; otherwise the kernel refuses on taint-gate (pre-enforce that
    // is shadow-only, not a hard refusal).
    taint: "SYSTEM",
    nonce: randomUUID(),
  })
}

export function buildAddItemEnvelope(
  payload: KernelAddItemPayload,
  _ctx: OrderContext,
  sessionId: string,
): IntentEnvelope<typeof KERNEL_INTENT_KIND_ADD_ITEM, KernelAddItemPayload> {
  return buildKernelEnvelope(KERNEL_INTENT_KIND_ADD_ITEM, payload, sessionId)
}

export function buildCheckoutEnvelope(
  payload: KernelCheckoutPayload,
  _ctx: OrderContext,
  sessionId: string,
): IntentEnvelope<typeof KERNEL_INTENT_KIND_CHECKOUT, KernelCheckoutPayload> {
  return buildKernelEnvelope(KERNEL_INTENT_KIND_CHECKOUT, payload, sessionId)
}

export function buildCancelOrderEnvelope(
  payload: KernelCancelPayload,
  _ctx: OrderContext,
  sessionId: string,
): IntentEnvelope<typeof KERNEL_INTENT_KIND_CANCEL, KernelCancelPayload> {
  return buildKernelEnvelope(KERNEL_INTENT_KIND_CANCEL, payload, sessionId)
}

export function buildRegeneratePixEnvelope(
  payload: KernelRegeneratePixPayload,
  _ctx: OrderContext,
  sessionId: string,
): IntentEnvelope<
  typeof KERNEL_INTENT_KIND_PIX_REGENERATE,
  KernelRegeneratePixPayload
> {
  return buildKernelEnvelope(
    KERNEL_INTENT_KIND_PIX_REGENERATE,
    payload,
    sessionId,
  )
}
