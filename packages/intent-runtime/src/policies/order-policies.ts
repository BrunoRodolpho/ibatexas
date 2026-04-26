/**
 * Order-domain PolicyBundle for IBX-IGE.
 *
 * v2.0 of IBX-IGE: the actual policy lives in `@ibatexas/llm-provider/order-policy-bundle`
 * to avoid the circular dependency that would arise from llm-provider needing
 * to consume the bundle directly. After the P1-i physical extraction, the
 * source of truth moves to `@adjudicate/intent-domain-order` and this file is deleted.
 *
 * For now this file is a stable re-export so external consumers keep importing
 * from `@adjudicate/intent-runtime/policies/order` regardless of where the actual code
 * lives.
 */

export {
  orderPolicyBundle,
  orderTaintPolicy,
  PIX_CONFIRMATION_SIGNAL,
  PIX_DEFER_TIMEOUT_MS,
  type OrderEnvelope,
  type OrderState,
} from "@ibatexas/llm-provider"
