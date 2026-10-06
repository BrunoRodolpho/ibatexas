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
// FE-4 CONTRACT (FE-T26): CHAT_DRIVABLE_TOOL_KINDS below is now COMPUTED,
// not hand-typed — see its own doc comment.
//
// LE2-014: both names now come from `@ibatexas/catalog`, where the authored
// definitions and their generators moved. This import is SAFE and the old
// hazard is gone: it used to reach past `./capability-definitions/index.js`
// into two leaf modules on purpose, because that barrel pulls in
// `guard-resolution.ts`, which imports `IBATEXAS_COMPOSED_PACKS` from THIS
// file — a genuine ESM cycle (this file → barrel → guard-resolution → this
// file) that broke at module-eval time with `generateChatDrivableToolKinds`
// reading as `undefined` mid-cycle. `@ibatexas/catalog` contains no
// guard-resolution and depends on nothing in this package, so importing its
// root barrel forms no cycle at all.
//
// Keep it that way: if anything in this file ever needs a guard-resolution
// export, import it from `./capability-definitions/guard-resolution.js`
// directly and re-examine the cycle — do NOT import
// `./capability-definitions/index.js` here.
import {
  CAPABILITY_DEFINITIONS,
  generateChatDrivableToolKinds,
} from "@ibatexas/catalog"

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
 * The 19 chat-drivable, LLM-callable mutating tool capability ids
 * (`capability := intentKind`) registered by apps/api's
 * `listIbatexasToolPacks()` (`apps/api/src/tools/register-ibatexas-tool-packs.ts`).
 *
 * FE-4 CONTRACT (FE-T26): COMPUTED from `CAPABILITY_DEFINITIONS` via
 * `generateChatDrivableToolKinds` (FE-T19's original generator, the family
 * exemplar) — this was the very first hand list FE-4 mirrored, and is now
 * the first one CONTRACT repoints. Same export name, same shape, same pack
 * -grouped order (the generator preserves declaration order deliberately —
 * see its own doc) — every consumer of `CHAT_DRIVABLE_TOOL_KINDS` is
 * unaffected by this change.
 *
 * That registry is an apps/api module — unreachable from packages/* by
 * design — but the journey gates (`ibx journey lint` / `coverage`, DR-5)
 * need the registered chat surface as data. This list mirrors it in the
 * composition home; the drift test
 * `apps/api/src/__tests__/chat-drivable-roster-drift.test.ts` pins it to the
 * live roster fail-closed (same spirit as `toolRosterDrift`) — that gate,
 * not a hand edit, is what would now need to change if the registered
 * roster ever moves.
 */
export const CHAT_DRIVABLE_TOOL_KINDS: ReadonlyArray<string> =
  generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)
