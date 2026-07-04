// ops-planner-context.ts — the ops-plane planner-context deriver (NEW-032 slice B).
//
// The production planner (`createIbatexasPlanner`) maps the claustrum
// `CognitiveState` onto the (state, context) the pack capability planners read
// via an injected `deriveContext`. The CHAT plane uses
// `deriveIbatexasPlannerContext` (staffId pinned null — CognitiveState carries
// no staff actor). The OPS plane injects THIS deriver instead: it stamps the
// AUTHENTICATED `staffId` (captured from the JWT at ops ingress, passed at
// conductor composition — never read from the model or the CognitiveState) so
// `opsCapabilityPlanner` advertises the staff-plane ops surface
// (`product.availability.set` + the `ops_snapshot` read).
//
// Security: `staffId` is a COMPOSITION-TIME constant, closed over here at
// `composeOpsConductor` time. It is the SAME authenticated identity the
// planner's `staffEnvelopeActor` stamps onto `envelope.actor.sessionId`
// (`admin:<staffId>`), so the planner's willingness-to-propose and the envelope
// authority can never diverge. Nothing the model emits can influence it.

import type { CognitiveState } from "@claustrum/core";

/**
 * The union ctx shape the pack capability planners read — mirrors
 * `deriveIbatexasPlannerContext` (claustrum-bootstrap.ts) but for the STAFF ops
 * plane: `staffId` present, `customerId` null, `isAuthenticated` false (the ops
 * plane's authority is the `admin:` namespace + `actor.role`, NOT a customer
 * auth flag — the customer/onboarding packs read `isAuthenticated`, and the ops
 * plane must never light up a customer-authenticated intent).
 */
interface OpsPlannerCtx {
  readonly tenantId: string;
  readonly channel: "staff";
  readonly customerId: null;
  readonly staffId: string;
  readonly isAuthenticated: false;
  readonly cartId: null;
  readonly orderId: null;
}

/**
 * Build the ops-plane `deriveContext` for a given authenticated `staffId`. The
 * returned function ignores the per-turn `CognitiveState` (the ops ctx is a
 * composition-time constant — `staffId` is fixed for the whole conductor) and
 * returns the `{ state: { ctx }, context: {} }` pair the pack planners consume.
 */
export function deriveOpsPlannerContext(
  staffId: string,
): (state: CognitiveState) => { readonly state: unknown; readonly context: unknown } {
  const ctx: OpsPlannerCtx = {
    // Single-tenant supply for the pack tenant-binding authGuard; env-driven
    // (Hard Rule #3), same source as deriveIbatexasPlannerContext.
    tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
    channel: "staff",
    customerId: null,
    staffId,
    isAuthenticated: false,
    cartId: null,
    orderId: null,
  };
  return (_state: CognitiveState) => ({ state: { ctx }, context: {} });
}
