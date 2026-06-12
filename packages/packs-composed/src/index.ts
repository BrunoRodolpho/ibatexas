/**
 * @ibatexas/packs-composed — the SINGLE composition site for the five
 * first-party Packs.
 *
 * This leaf package is the only place in the codebase that names the five
 * `@ibatexas/pack-*` packages together. The Conductor composition root
 * (`apps/api/src/claustrum-bootstrap.ts`) consumes the lists below instead of
 * inlining its own 5-pack arrays; the CLI / journeys gates import the same
 * lists, which an apps/api export could never provide (apps are unreachable
 * from packages/*). Like `@ibatexas/intent-kinds`, it lives in its own
 * package so both apps/api and packages/cli can import it without a
 * dependency cycle.
 *
 * Scope: the five FIRST-PARTY packs only. The platform adopter pack
 * `@adjudicate/pack-payments-pix` (ADR #13) is a registry dep installed by
 * each composition root directly — it is not first-party and the kernel
 * `installPack` roster, not this list, is its source of truth.
 *
 * NOT here by design: `buildIbatexasPolicyPacks` (the adopter-level guard
 * prepend) stays in apps/api — the F4 token-budget + confirm-on-autoresolve
 * guards are adopter policy, not pack composition.
 */

import type { CapabilityPlanner } from "@adjudicate/core/llm"
import {
  customerOnboardingPack,
  customerOnboardingCapabilityPlanner,
} from "@ibatexas/pack-customer-onboarding"
import { ordersPack, ordersCapabilityPlanner } from "@ibatexas/pack-orders"
import {
  paymentsPack,
  paymentsCapabilityPlanner,
} from "@ibatexas/pack-payments"
import {
  reservationsPack,
  reservationsCapabilityPlanner,
} from "@ibatexas/pack-reservations"
import {
  whatsappPack,
  whatsappCapabilityPlanner,
} from "@ibatexas/pack-whatsapp"

// ── Composed pack list ───────────────────────────────────────────────────────

/**
 * The five first-party Packs, in canonical order (mirrors the install order
 * of the kernel boot anchors). Kept as the literal tuple type — consumers
 * that need the heterogeneous-erased `PackV0<string, unknown, unknown,
 * unknown>` shape (e.g. `buildIbatexasPolicyPacks`) cast at their boundary,
 * where the erased type lives.
 */
export const IBATEXAS_COMPOSED_PACKS = [
  ordersPack,
  paymentsPack,
  reservationsPack,
  customerOnboardingPack,
  whatsappPack,
] as const

/** One of the five composed first-party pack objects. */
export type ComposedPack = (typeof IBATEXAS_COMPOSED_PACKS)[number]

// ── Composed capability-planner list ─────────────────────────────────────────

/**
 * The packs' capability planners — union'd by the production planner
 * (`createIbatexasPlanner`). `CapabilityPlanner<S, C>.plan` is declared
 * method-style, so its params compare bivariantly — each pack's concrete
 * planner widens to `CapabilityPlanner<unknown, unknown>` with no cast.
 */
export const IBATEXAS_COMPOSED_CAPABILITY_PLANNERS: ReadonlyArray<
  CapabilityPlanner<unknown, unknown>
> = [
  ordersCapabilityPlanner,
  paymentsCapabilityPlanner,
  reservationsCapabilityPlanner,
  customerOnboardingCapabilityPlanner,
  whatsappCapabilityPlanner,
]

// ── Intent-kind union ────────────────────────────────────────────────────────

/**
 * Deduplicated union of the intent kinds declared across the composed packs
 * (`pack.intents`), in pack order then declaration order. Runtime-derived
 * from the pack objects themselves, so it can never drift from what the
 * packs declare — unlike the hand-mirrored literal lists in
 * `@ibatexas/intent-kinds`, which exist to typo-guard the unions and cover
 * non-composed kinds (pix.*, loyalty.*) this package deliberately excludes.
 */
export function composedIntentKinds(): ReadonlyArray<string> {
  const seen = new Set<string>()
  const kinds: string[] = []
  for (const pack of IBATEXAS_COMPOSED_PACKS) {
    for (const kind of pack.intents) {
      if (!seen.has(kind)) {
        seen.add(kind)
        kinds.push(kind)
      }
    }
  }
  return kinds
}
