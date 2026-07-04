/**
 * @ibatexas/pack-ops — first-party Pack for the governed OPS (owner/staff
 * operations) plane. Sixth first-party Pack after pack-orders /
 * pack-reservations / pack-whatsapp / pack-customer-onboarding / pack-payments.
 *
 * NEW-032 slice C1 — the governed-verb FOUNDATION of the ops-actor plane. It
 * ships ONE governed staff-plane verb (`product.availability.set`) with the
 * kernel authority wiring; the HTTP/conductor ingress, the ops-actor LLM
 * persona (which stamps `admin:${staffId}` + `actor.role`), and the read/exec
 * tool executors land in later PRs.
 *
 * Authority model (see `types.ts` module header for the full posture):
 * `admin:`-session fence (this pack's `adminSessionOnlyGuard`) + `actor.role`
 * matrix (adopter `staffRoleGuard`, prepended by `buildIbatexasPolicyPacks`) +
 * strict business validation. Taint floor is UNTRUSTED by design — the ops
 * payloads are model-parsed; authority is the namespace + role, not the taint.
 *
 * Conformance: `opsPack satisfies PackV0<...>`. `runConformance(opsPack)` from
 * `@adjudicate/conformance` runs the kernel-invariant suite (taint protection,
 * replay determinism, basis-vocabulary purity, guard ordering, default
 * polarity) — see `__tests__/ops-pack.test.ts`.
 */

import type { PackV0 } from "@adjudicate/core"
import { opsCapabilityPlanner } from "./capabilities.js"
import { opsPolicyBundle } from "./policies.js"
import { OPS_REFUSAL_CODES } from "./refusals.js"
import type {
  OpsContext,
  OpsIntentKind,
  OpsPayload,
  OpsState,
} from "./types.js"

// ── Re-exports for adopter convenience ──────────────────────────────────────

export {
  opsTaintPolicy,
  PRODUCT_AVAILABILITY_SET_KEYS,
  type OpsContext,
  type OpsIntentKind,
  type OpsPayload,
  type OpsProductSnapshot,
  type OpsState,
  type ProductAvailabilitySetPayload,
} from "./types.js"

export {
  OPS_ADMIN_SESSION_REQUIRED_CODE,
  OPS_AVAILABILITY_PAYLOAD_INVALID_CODE,
  OPS_AVAILABILITY_PRODUCT_NOT_FOUND_CODE,
  OPS_REFUSAL_CODES,
  refuseAdminSessionRequired,
  refuseAvailabilityPayloadInvalid,
  refuseAvailabilityProductNotFound,
  portugueseRefusalMessages,
} from "./refusals.js"

export { opsPolicyBundle } from "./policies.js"

export {
  OPS_TOOLS,
  OPS_SNAPSHOT_READ_TOOL,
  OPS_FOREIGN_ADVERTISED_KIND,
  OPS_FOREIGN_ADVERTISED_TRANSITION_KIND,
  opsCapabilityPlanner,
} from "./capabilities.js"

/**
 * The Pack as a `PackV0`-conformant value. The `satisfies` clause provides
 * compile-time conformance — drift from `PackV0`'s shape fails the build.
 *
 * Pack id convention matches the sibling packs (`ibatexas/pack-orders`):
 * short, no npm scope on the `id` field itself.
 *
 * `basisCodes` is sourced from `OPS_REFUSAL_CODES` so the declared refusal
 * taxonomy can never drift from the codes `refusals.ts` actually emits (the
 * AC-004 basis-vocabulary-purity check pins runtime emissions to this set).
 *
 * State is plain JSON (no `Date`/`Map`/`Set`), so `rehydrateState` is
 * intentionally omitted per the PackV0 convention.
 */
export const opsPack = {
  id: "ibatexas/pack-ops",
  version: "1.0.0",
  contract: "v0",
  intents: ["product.availability.set"],
  policy: opsPolicyBundle,
  planner: opsCapabilityPlanner,
  basisCodes: OPS_REFUSAL_CODES,
  /** This pack does not DEFER — no wire signals. */
  signals: [],
} as const satisfies PackV0<OpsIntentKind, OpsPayload, OpsState, OpsContext>
