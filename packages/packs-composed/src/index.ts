/**
 * @ibatexas/packs-composed — the SINGLE composition site for the six
 * first-party Packs.
 *
 * This leaf package is the only place in the codebase that names the six
 * `@ibatexas/pack-*` packages together. The Conductor composition root
 * (`apps/api/src/claustrum-bootstrap.ts`) consumes the lists below instead of
 * inlining its own 5-pack arrays; the CLI / journeys gates import the same
 * lists, which an apps/api export could never provide (apps are unreachable
 * from packages/*). Like `@ibatexas/intent-kinds`, it lives in its own
 * package so both apps/api and packages/cli can import it without a
 * dependency cycle.
 *
 * Scope: the six FIRST-PARTY packs only. The platform adopter pack
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
import { opsPack, opsCapabilityPlanner } from "@ibatexas/pack-ops"
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
 * The six first-party Packs, in canonical order (mirrors the install order
 * of the kernel boot anchors). Kept as the literal tuple type — consumers
 * that need the heterogeneous-erased `PackV0<string, unknown, unknown,
 * unknown>` shape (e.g. `buildIbatexasPolicyPacks`) cast at their boundary,
 * where the erased type lives.
 *
 * `opsPack` (NEW-032 slice C1) is appended last — it owns the staff-plane ops
 * verb surface (`product.availability.set`), disjoint from the five
 * customer/egress packs, so ordering among them is not load-bearing.
 */
export const IBATEXAS_COMPOSED_PACKS = [
  ordersPack,
  paymentsPack,
  reservationsPack,
  customerOnboardingPack,
  whatsappPack,
  opsPack,
] as const

/** One of the six composed first-party pack objects. */
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
  opsCapabilityPlanner,
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

// ── Chat-drivable registered tool roster (T1a-2) ─────────────────────────────

/**
 * The 18 chat-drivable, LLM-callable mutating tool capability ids
 * (`capability := intentKind`) registered by apps/api's
 * `listIbatexasToolPacks()` (`apps/api/src/tools/register-ibatexas-tool-packs.ts`).
 *
 * That registry is an apps/api module — unreachable from packages/* by
 * design — but the journey gates (`ibx journey lint` / `coverage`, DR-5)
 * need the registered chat surface as data. This list mirrors it in the
 * composition home; the drift test
 * `apps/api/src/__tests__/chat-drivable-roster-drift.test.ts` pins it to the
 * live roster fail-closed (same spirit as `toolRosterDrift`). Adding or
 * dropping a registered tool MUST update this list deliberately, or the api
 * suite goes red.
 */
export const CHAT_DRIVABLE_TOOL_KINDS: ReadonlyArray<string> = [
  // pack-orders (10)
  "order.cart.ensure",
  "order.item.add",
  "order.item.update",
  "order.item.remove",
  "order.coupon.apply",
  "order.checkout.create",
  "order.cancel",
  "order.amend.request",
  "order.note.add",
  "order.review.submit",
  // pack-reservations (4)
  "reservation.create",
  "reservation.modify",
  "reservation.cancel",
  "reservation.waitlist.join",
  // pack-customer-onboarding (2)
  "customer.preferences.update",
  "customer.pix.details.save",
  // pack-payments (1)
  "payment.pix.regenerate",
  // pack-whatsapp (1) — BKL-030 customer-side escalation on-ramp
  "whatsapp.handoff.request",
]
