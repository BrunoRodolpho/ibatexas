// Re-export shared Medusa client with cart-specific aliases.
// Preserves existing function names so cart tool files need zero changes.
//
// ── W8-V1 — shared OrderService factory with adjudicated egress wiring ───
//
// `createTooledOrderService()` wires the `adminAdjudicated` DI of
// `createOrderService` (packages/domain) to the cart tool layer's
// `medusaAdjudicated` shim — so that the 6 mutating medusa egresses in
// order.service.ts route through the kernel-gated wrapper rather than
// hitting the (now-removed) silent fallback to bare `fetchAdmin`.
//
// Wave 7's P5↔P6 hand-off seam left 3 cart-tool callers
// (`cancel-order.ts`, `amend-order.ts`, `check-order-status.ts`)
// instantiating `createOrderService(medusaAdmin)` WITHOUT the option,
// so their order.service mutations silently bypassed the kernel. The
// W8 closure (NEW-W7-V1) migrates them through this factory.
//
// Mirrors the wiring shape used at `apps/api/src/routes/stripe-webhook.ts:347`
// (W7-P6 reference site). Audit sink is intentionally omitted because
// `@ibatexas/tools` cannot depend on `@ibatexas/llm-provider` (which owns
// `getAuditSink`) without creating a cycle. The wrapper's fail-open
// posture applies (per packages/tools/src/medusa/adjudicated.ts:474-479):
// the kernel still gates the call; audit emit is best-effort and skipped
// when the sink is not injected. This is the same posture the other
// cart-tool `medusaAdjudicated()` call sites already use (none of them
// pass an audit sink either — see amend-order.ts:84, 228, 236, etc.).

import { createOrderService, type OrderService } from "@ibatexas/domain"
import { medusaAdmin } from "../medusa/client.js"
import { medusaAdjudicated } from "../medusa/adjudicated.js"

export { medusaStore as medusaStoreFetch, medusaAdmin as medusaAdminFetch } from "../medusa/client.js"

/**
 * Construct an OrderService instance whose 6 mutating medusa egresses
 * route through `medusaAdjudicated` (kernel + audit emit), rather than
 * the legacy bare-`fetchAdmin` posture that bypassed the kernel.
 *
 * The shared factory ensures every cart-tool caller wires the same
 * `adminAdjudicated` closure shape — preventing a future caller from
 * accidentally re-introducing the bypass by passing bare `medusaAdmin`.
 * Paired with the hard-throw in `order.service.ts` so any caller that
 * forgets to use this factory fails loudly at construction time.
 *
 * @param sourceSubject — short call-site label, prefixed to the audit
 *   record's `actor.sessionId` (e.g. "tool:cancel_order", "tool:amend_order").
 *   Per the W7 sourceSubject conventions.
 */
export function createTooledOrderService(
  sourceSubject: string,
): OrderService {
  return createOrderService(medusaAdmin, {
    adminAdjudicated: (args) =>
      medusaAdjudicated({
        scope: "admin",
        method: args.method,
        path: args.path,
        ...(args.payload !== undefined ? { payload: args.payload } : {}),
        ...(args.intentKind ? { intentKind: args.intentKind as never } : {}),
        ...(args.idempotencyKey !== undefined
          ? { idempotencyKey: args.idempotencyKey }
          : {}),
        sourceSubject: `${sourceSubject}:${args.sourceSubject}`,
      }),
  })
}
