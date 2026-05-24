// Order-domain PolicyBundle — DEPRECATED legacy shim.
//
// The order-policy-bundle was MIGRATED into the first-party
// `@ibatexas/pack-orders` workspace package (the lighthouse first-party
// Pack — task 08 of the adjudicate-migration plan; CLAUDE.md rule #9,
// ADR #13). This file is kept for one release cycle as a re-export
// alias so existing import sites don't break; new code MUST import from
// `@ibatexas/pack-orders` directly.
//
// What lives where now:
//
//   - `ordersPack` / `ordersPolicyBundle`         → @ibatexas/pack-orders
//   - intent kinds + payload types                → @ibatexas/pack-orders/types
//   - typed refusals (pt-BR per CLAUDE.md #4)     → @ibatexas/pack-orders/refusals
//   - CapabilityPlanner + ToolClassification      → @ibatexas/pack-orders/capabilities
//   - PIX-pending DEFER guard factory             → @adjudicate/pack-payments-pix
//                                                   (re-composed inside the Pack)
//
// Migration target: remove this file once every importer is updated.

import type { PolicyBundle } from "@adjudicate/core/kernel"
import type { IntentEnvelope } from "@adjudicate/core"
import {
  ordersPolicyBundle as _ordersPolicyBundle,
  orderTaintPolicy as _orderTaintPolicy,
  type OrderState as _PackOrderState,
} from "@ibatexas/pack-orders"
import type { OrderContext } from "./machine/types.js"

/**
 * @deprecated Migrated to `@ibatexas/pack-orders.ordersPolicyBundle`.
 * Re-exported here under the legacy name so v1 callers keep compiling
 * while the import site is updated. Will be removed in a future
 * release.
 */
export const orderPolicyBundle: PolicyBundle<string, unknown, OrderState> =
  _ordersPolicyBundle as unknown as PolicyBundle<
    string,
    unknown,
    OrderState
  >

/**
 * @deprecated Migrated to `@ibatexas/pack-orders.orderTaintPolicy`.
 */
export const orderTaintPolicy = _orderTaintPolicy

/**
 * @deprecated Use `OrderState` from `@ibatexas/pack-orders`. The legacy
 * IbateXas shape wrapped the full `OrderContext`; the Pack's narrower
 * `ctx` type is a structural subset that the legacy `machineCtx`
 * satisfies via TypeScript width subtyping.
 */
export interface OrderState {
  readonly ctx: OrderContext
}

/**
 * @deprecated Use `IntentEnvelope<OrderIntentKind, OrderPayload>` from
 * `@ibatexas/pack-orders`.
 */
export type OrderEnvelope = IntentEnvelope<string, unknown>

// Re-affirm the structural compatibility between the legacy OrderState
// (the broad llm-provider shape) and the Pack's narrow OrderState — a
// no-op assignment that fails the build if drift ever breaks the
// subset relation.
type _AssertCompat<T extends _PackOrderState> = T
type _Check = _AssertCompat<OrderState>
