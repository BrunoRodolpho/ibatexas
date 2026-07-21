/**
 * Customer two-phase order cancel (BKL-146 / FE-D19).
 *
 * A PAID order does not cancel synchronously: `POST /api/orders/:id/cancel`
 * returns HTTP 202 `{ confirmationRequired, confirmationId, prompt, ttlSeconds }`
 * (BKL-036 gatePaidCancel parks it under a single-use receipt). The customer
 * COMPLETES it via `POST /api/orders/:id/cancel/confirm { confirmationId }`,
 * which resumes the EXECUTE through the kernel's confirmationReceipt seam (the
 * kernel stays the confirm authority — every guard is still enforced).
 *
 * `apiFetch` throws a generic Error on any non-2xx and discards the body, so it
 * cannot tell a 202-park from a 200, nor a 410-expiry from a 500. These helpers
 * read the raw `Response` and classify the outcome into a discriminated union so
 * the UI renders an honest, pt-BR outcome per branch — and, critically, restates
 * the KERNEL'S prompt in the confirm dialog rather than an app-authored claim
 * about what will happen.
 */

import { getApiBase } from '@ibatexas/tools/api'

/** Outcome of the FIRST POST /api/orders/:id/cancel. */
export type OrderCancelResult =
  | { readonly kind: 'executed' }
  | {
      readonly kind: 'needs_confirmation'
      readonly confirmationId: string
      /** The kernel's pt-BR prompt — restated verbatim in the confirm dialog. */
      readonly prompt: string
      readonly ttlSeconds?: number
    }
  | { readonly kind: 'not_allowed'; readonly code?: string; readonly message?: string }
  | { readonly kind: 'error' }

/** Outcome of the SECOND POST /api/orders/:id/cancel/confirm. */
export type OrderCancelConfirmResult =
  | { readonly kind: 'executed' }
  /** The single-use receipt expired or was already used (HTTP 410). */
  | { readonly kind: 'expired' }
  | { readonly kind: 'not_allowed'; readonly code?: string; readonly message?: string }
  | { readonly kind: 'error' }

/** Best-effort JSON parse — a body-less or non-JSON reply resolves to null. */
async function readJsonSafe(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * POST the cancel request. A PAID order parks (202) — the receipt + kernel
 * prompt are surfaced so the caller can render the confirm step; the cancel has
 * NOT happened yet (never rendered as success). Never throws.
 */
export async function submitOrderCancel(
  orderId: string,
  reason?: string,
): Promise<OrderCancelResult> {
  let response: Response
  try {
    response = await fetch(`${getApiBase()}/api/orders/${orderId}/cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    })
  } catch {
    return { kind: 'error' }
  }

  const body = await readJsonSafe(response)

  if (response.status === 202 && body?.confirmationRequired === true) {
    const confirmationId = typeof body.confirmationId === 'string' ? body.confirmationId : ''
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    // A park with no usable receipt cannot be completed — treat as an error
    // rather than a dead-end confirm step.
    if (confirmationId.length === 0) return { kind: 'error' }
    return {
      kind: 'needs_confirmation',
      confirmationId,
      prompt,
      ...(typeof body.ttlSeconds === 'number' ? { ttlSeconds: body.ttlSeconds } : {}),
    }
  }

  if (response.ok) return { kind: 'executed' }

  if (response.status === 403 || response.status === 409 || response.status === 422) {
    const code = typeof body?.code === 'string' ? body.code : undefined
    const message = typeof body?.error === 'string' ? body.error : undefined
    return { kind: 'not_allowed', code, message }
  }

  return { kind: 'error' }
}

/**
 * POST the confirm receipt to COMPLETE a parked cancel. A 200 is the real
 * cancel; a 410 means the single-use receipt expired/was used (restart); a
 * governed refusal (the order moved past the PONR since the park) surfaces
 * honestly. Never throws.
 */
export async function submitOrderCancelConfirm(
  orderId: string,
  confirmationId: string,
): Promise<OrderCancelConfirmResult> {
  let response: Response
  try {
    response = await fetch(`${getApiBase()}/api/orders/${orderId}/cancel/confirm`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId }),
    })
  } catch {
    return { kind: 'error' }
  }

  if (response.ok) return { kind: 'executed' }

  const body = await readJsonSafe(response)

  if (response.status === 410) return { kind: 'expired' }

  if (response.status === 403 || response.status === 409 || response.status === 422) {
    const code = typeof body?.code === 'string' ? body.code : undefined
    const message = typeof body?.error === 'string' ? body.error : undefined
    return { kind: 'not_allowed', code, message }
  }

  return { kind: 'error' }
}
