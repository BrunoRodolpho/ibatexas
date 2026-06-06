// loyalty-policy.ts — domain-internal PolicyBundle for the
// LoyaltyService chokepoint.
//
// Scope (intent kinds covered):
//   - loyalty.stamp.add — SYSTEM. Stamp award on `order.placed`
//                          (subscriber-driven). Persists a Prisma row on
//                          `ibx_domain.loyalty_accounts` — NOT a Redis-only
//                          counter (see audit 2026-05-23 NEW-W9-V4 for the
//                          doc/code drift fix that motivated this bundle).
//
// Mirrors the `conversation-policy.ts` shape: a small SYSTEM-only bundle
// that lets the LoyaltyService route through the kernel via
// `withAdjudicate` without pulling pack-orders into a loyalty-specific
// intent vocabulary. The LLM has no business mutating loyalty stamps —
// the only caller today is `cart-intelligence.ts:order.placed`.

import {
  basis,
  BASIS_CODES,
  decisionExecute,
} from "@adjudicate/core"
import {
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { createSystemTaintPolicy } from "@adjudicate/primitives"

export type LoyaltyIntentKind = "loyalty.stamp.add"

/**
 * Payload for `loyalty.stamp.add`. The customer ID is the only required
 * field — the stamp count derives from the persisted account state.
 */
export interface LoyaltyStampAddPayload {
  readonly customerId: string
}

export type LoyaltyPayload = LoyaltyStampAddPayload

export interface LoyaltyState {
  readonly ctx: {
    /**
     * Optional — caller may project the current customer id for guard
     * inspection. The kernel does not require it; the executor reads
     * the canonical value from the envelope payload.
     */
    readonly customerId?: string
  }
}

/**
 * `loyalty.stamp.add` is SYSTEM-only. The stamp award is triggered by the
 * `order.placed` subscriber after a successful checkout; the LLM must
 * never be able to forge an extra stamp. The taint gate REFUSEs any
 * UNTRUSTED proposal of this kind.
 */
export const loyaltyTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: ["loyalty.stamp.add"],
  userMinimum: "UNTRUSTED",
})

type LoyaltyGuard = Guard<LoyaltyIntentKind, LoyaltyPayload, LoyaltyState>

/**
 * Single EXECUTE producer — the bundle's default is REFUSE so any kind
 * not covered here is denied by construction (master plan §"Governance
 * principles" #4). The guard fires after the SYSTEM taint floor so an
 * UNTRUSTED proposal is rejected before reaching this point.
 */
const executeStampAdd: LoyaltyGuard = (envelope) => {
  if (envelope.kind !== "loyalty.stamp.add") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

export const loyaltyPolicyBundle: PolicyBundle<
  LoyaltyIntentKind,
  LoyaltyPayload,
  LoyaltyState
> = {
  stateGuards: [],
  authGuards: [],
  taint: loyaltyTaintPolicy,
  business: [executeStampAdd],
  default: "REFUSE",
}
