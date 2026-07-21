/**
 * Post-order "add item" — CUS-039.
 *
 * The batch amend route (`POST /api/orders/:id/amend/batch`) hard-rejects
 * `add` — its enum is `[remove, update_qty]`. Adds instead flow through the
 * SINGLE, kernel-governed route `POST /api/orders/:id/amend` with
 * `{ action: 'add', variantId, quantity }`. That route adjudicates an
 * `order.amend.request` envelope behind the `requireAmendable` fulfillment
 * guard, so the HTTP reply is a passthrough of the kernel's decision:
 *
 *   - 200                          → the add EXECUTED
 *   - 202 { confirmationRequired } → PARKED (REQUEST_CONFIRMATION), NOT applied
 *   - 403 / 422                    → governed refusal (not amendable / not allowed)
 *   - 429                          → the per-customer amend rate limit
 *
 * `apiFetch` throws a generic Error on any non-2xx and discards the body, so it
 * cannot tell a 202-park from a 200, nor a 403 refusal from a 500. This helper
 * reads the raw `Response` (the raw-fetch-reads-body idiom) and classifies the
 * outcome into a discriminated union — the UI must never render a 202 park as a
 * confident "item added" success.
 */

import { getApiBase } from '@ibatexas/tools/api'
import type { ProductDTO, ProductVariant } from '@ibatexas/types'

/** Upper bound on a single add — a UI sanity cap; the server takes any positive int. */
export const MAX_ADD_QUANTITY = 20

export interface AmendAddInput {
  readonly orderId: string
  readonly variantId: string
  readonly quantity: number
}

/** The single-route request body for an add action. */
export interface AmendAddBody {
  readonly action: 'add'
  readonly variantId: string
  readonly quantity: number
}

/**
 * Outcome of a single-route add, classified from the raw HTTP status/body so
 * the caller can surface an honest, pt-BR message per branch.
 */
export type AmendAddResult =
  | { readonly kind: 'executed' }
  | { readonly kind: 'confirmation_required'; readonly prompt?: string }
  | { readonly kind: 'not_allowed'; readonly code?: string; readonly message?: string }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'error' }

/** True when the quantity is an integer within [1, MAX_ADD_QUANTITY]. */
export function isValidAddQuantity(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_ADD_QUANTITY
}

/**
 * Pick the variant to add: the explicit choice by id, else the product's first
 * variant (mirrors `resolveVariant` in cart.logic — the loja/cart default).
 */
export function resolveAddVariant(
  product: ProductDTO,
  variantId?: string,
): ProductVariant | undefined {
  if (variantId) {
    const chosen = product.variants?.find((v) => v.id === variantId)
    if (chosen) return chosen
  }
  return product.variants?.[0]
}

/**
 * The positive price delta (integer centavos) an add contributes to the order
 * subtotal. Uses the variant price, falling back to the product price when the
 * variant carries none.
 */
export function computeAddPriceDelta(
  product: ProductDTO,
  variant: ProductVariant | undefined,
  quantity: number,
): number {
  const unit = variant?.price ?? product.price
  return unit * quantity
}

/** Build the single-route request body for an add. */
export function buildAmendAddBody(input: AmendAddInput): AmendAddBody {
  return { action: 'add', variantId: input.variantId, quantity: input.quantity }
}

/** Best-effort JSON parse — a body-less or non-JSON reply resolves to null. */
async function readJsonSafe(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * POST a single add action to the kernel-governed amend route and classify the
 * outcome. Never throws — every failure maps to an `AmendAddResult` branch so
 * the dialog can render a pt-BR message without a try/catch at the call site.
 */
export async function submitAmendAdd(input: AmendAddInput): Promise<AmendAddResult> {
  let response: Response
  try {
    response = await fetch(`${getApiBase()}/api/orders/${input.orderId}/amend`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAmendAddBody(input)),
    })
  } catch {
    return { kind: 'error' }
  }

  const body = await readJsonSafe(response)

  if (response.ok) {
    // 200 EXECUTE/REWRITE, or 202 REQUEST_CONFIRMATION (a 2xx that is NOT applied).
    if (body?.confirmationRequired === true) {
      const prompt = typeof body.prompt === 'string' ? body.prompt : undefined
      return { kind: 'confirmation_required', prompt }
    }
    return { kind: 'executed' }
  }

  if (response.status === 429) return { kind: 'rate_limited' }

  if (response.status === 403 || response.status === 422) {
    const code = typeof body?.code === 'string' ? body.code : undefined
    const message = typeof body?.error === 'string' ? body.error : undefined
    return { kind: 'not_allowed', code, message }
  }

  return { kind: 'error' }
}
