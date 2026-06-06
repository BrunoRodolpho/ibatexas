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
// ── audit-2026-05-24 H2 (A1) closure ──────────────────────────────────────
//
// Pre-H2 the audit sink slot was intentionally omitted here because
// `@ibatexas/tools` could not depend on `@ibatexas/llm-provider` (which
// owned `getAuditSink`) without creating a cycle. H2 (sub-option A1)
// moved `getAuditSink` into the new leaf package `@ibatexas/audit-sink`
// (zero runtime deps on tools / domain / nats-client / llm-provider),
// closing the cycle. Every `medusaAdjudicated` call now passes
// `auditSink: getAuditSink()` — including the one this factory closure
// fans out to via `createOrderService.adminAdjudicated`.
//
// The factory's closure is the single seam through which the 6 mutating
// medusa egresses in `packages/domain/src/services/order.service.ts`
// reach the wrapper; adding the audit sink here means those 6 egresses
// emit audit records without any cascade into the domain package.

import { createOrderService, type OrderService } from "@ibatexas/domain"
import { getAuditSink } from "@ibatexas/audit-sink"
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
        // audit-2026-05-24 H2 (A1): the leaf-package cycle break landed,
        // so every medusa egress in order.service.ts now emits an audit
        // record by contract. Same as the 28 wrapper-call sites the H2
        // sweep covers.
        auditSink: getAuditSink(),
      }),
  })
}
