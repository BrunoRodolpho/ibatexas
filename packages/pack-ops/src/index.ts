/**
 * @ibatexas/pack-ops — first-party Pack for the governed OPS (owner/staff
 * operations) plane. Sixth first-party Pack after pack-orders /
 * pack-reservations / pack-whatsapp / pack-customer-onboarding / pack-payments.
 *
 * NEW-032 slice C1 + BKL-088 + NEW-004 — the governed-verb surface of the
 * ops-actor plane. It ships FOUR OWNED governed staff-plane verbs with the
 * kernel authority wiring: `product.availability.set` (86/un-86, NEW-032 slice
 * C1), `product.price.set` (price-change-by-message, NEW-004 — confirm-gated on
 * UNTRUSTED taint), and the two RESOLUTION verbs `ops.alert.resolve.staff` /
 * `incident.ticket.close.staff` (BKL-088), whose ops-tool executors drive the
 * SAME-named SYSTEM domain write layer (the D10 two-layer posture). The
 * conductor ingress, LLM persona (which stamps `admin:${staffId}` +
 * `actor.role`), resolver, and tool executors live in apps/api.
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
  getPriceSanityMaxCentavos,
  INCIDENT_CLOSE_STAFF_KEYS,
  isOpsEntityActionable,
  OPS_ALERT_RESOLVE_STAFF_KEYS,
  OPS_ENTITY_NON_TERMINAL_STATUSES,
  opsTaintPolicy,
  PRODUCT_AVAILABILITY_SET_KEYS,
  PRODUCT_PRICE_SET_KEYS,
  type IncidentCloseStaffPayload,
  type OpsAlertResolveStaffPayload,
  type OpsAlertSnapshot,
  type OpsContext,
  type OpsIncidentSnapshot,
  type OpsIntentKind,
  type OpsPayload,
  type OpsPriceProductSnapshot,
  type OpsProductSnapshot,
  type OpsState,
  type ProductAvailabilitySetPayload,
  type ProductPriceSetPayload,
} from "./types.js"

export {
  OPS_ADMIN_SESSION_REQUIRED_CODE,
  OPS_ALERT_RESOLVE_NOT_ACTIONABLE_CODE,
  OPS_ALERT_RESOLVE_PAYLOAD_INVALID_CODE,
  OPS_AVAILABILITY_PAYLOAD_INVALID_CODE,
  OPS_AVAILABILITY_PRODUCT_NOT_FOUND_CODE,
  OPS_INCIDENT_CLOSE_NOT_ACTIONABLE_CODE,
  OPS_INCIDENT_CLOSE_PAYLOAD_INVALID_CODE,
  OPS_PRICE_OUT_OF_RANGE_CODE,
  OPS_PRICE_PAYLOAD_INVALID_CODE,
  OPS_PRICE_PER_VARIANT_UNSUPPORTED_CODE,
  OPS_PRICE_PRODUCT_NOT_FOUND_CODE,
  OPS_REFUSAL_CODES,
  refuseAdminSessionRequired,
  refuseAlertResolveNotActionable,
  refuseAlertResolvePayloadInvalid,
  refuseAvailabilityPayloadInvalid,
  refuseAvailabilityProductNotFound,
  refuseIncidentCloseNotActionable,
  refuseIncidentClosePayloadInvalid,
  refusePriceOutOfRange,
  refusePricePayloadInvalid,
  refusePricePerVariantUnsupported,
  refusePriceProductNotFound,
  portugueseRefusalMessages,
} from "./refusals.js"

export { opsPolicyBundle } from "./policies.js"

export {
  OPS_TOOLS,
  OPS_SNAPSHOT_READ_TOOL,
  OPS_SALES_ANALYTICS_READ_TOOL,
  OPS_ALERT_RESOLVE_STAFF_KIND,
  OPS_INCIDENT_CLOSE_STAFF_KIND,
  OPS_FOREIGN_ADVERTISED_KIND,
  OPS_FOREIGN_ADVERTISED_TRANSITION_KIND,
  OPS_FOREIGN_ADVERTISED_REFUND_KIND,
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
  version: "1.2.0",
  contract: "v0",
  intents: [
    "product.availability.set",
    // NEW-004 — the OWNED price-change verb (confirm-gated on UNTRUSTED taint;
    // executor re-prices via the same medusaAdjudicated admin egress).
    "product.price.set",
    // BKL-088 — the two OWNED staff-plane RESOLUTION verbs (their executors
    // drive the SAME-named SYSTEM domain write layer; see types.ts header).
    "ops.alert.resolve.staff",
    "incident.ticket.close.staff",
  ],
  policy: opsPolicyBundle,
  planner: opsCapabilityPlanner,
  basisCodes: OPS_REFUSAL_CODES,
  /** This pack does not DEFER — no wire signals. */
  signals: [],
} as const satisfies PackV0<OpsIntentKind, OpsPayload, OpsState, OpsContext>
