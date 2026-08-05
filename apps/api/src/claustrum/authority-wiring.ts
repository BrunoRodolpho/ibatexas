// 034-F1 — production wiring for the kernel ownership/IDOR guard.
//
// The kernel ownership guard (resolveOwnership / enforceResourceOwnership) is
// INERT unless the host injects `state.authority` and stamps `resourceRefs` on
// money-moving envelopes. This module builds both from the per-turn,
// ownership-CONFIRMED resource set produced by resolveAndAssemble (the
// customer-scoped DB load). Because the authority graph contains ONLY resources
// the customer truly owns, the guard REFUSEs a forged / other-principal id
// rather than vacuously passing — the de-vacuuming invariant (see the
// authority-wiring vacuity test + pack-orders ownership canary).
//
// ibatexas already scopes order/payment resolution to the authenticated customer,
// so this is DEFENSE-IN-DEPTH: an independent kernel-level REFUSE that does not
// rely on downstream service-layer scoping.

import { createAuthorityGraphStore } from "@adjudicate/core";

/** Money-moving kinds whose envelopes carry an ownership binding. The resource is
 *  the orderId — ownership flows through the order for both order.* and payment.*
 *  money kinds (resolveAndAssemble confirms order ownership for each).
 *
 *  ── Why `order.review.submit` is NOT here (F-14, ledger cycle 21) ──────────
 *
 *  It looks like it should be: it is a mutating `order.` kind whose profile row
 *  loads the order by id (`ctxLoader: "order-by-id"`,
 *  kind-resolution-profiles.ts), and a public review is reputation-moving even
 *  though it is not money-moving. The absence was MEASURED rather than assumed,
 *  and the three vectors a kernel binding would close are already closed
 *  upstream. Each measurement has a named test; do not re-open F-14 without
 *  first re-running them.
 *
 *   1. The model cannot author the id. `order.review.submit`'s extraction schema
 *      declares NO `legacyPayloadChannels`, so `stripUnauthoredPayloadFields`
 *      (ibatexas-planner.ts, the PARSE seam) drops BOTH `orderId` and
 *      `productId` before `buildEnvelope`. The model only ever emits
 *      `rating`/`comment` plus the NL references `item`/`orderReference`.
 *      → ibatexas-planner.test.ts, "a smuggled orderId AND productId are BOTH
 *        dropped".
 *   2. The resolver resolves the id OWNER-SCOPED and OVERWRITES whatever was
 *      there. `applyAutoResolve`'s `order-display-reference` branch never
 *      consults a pre-existing `payload.orderId`: a display number is
 *      IDOR-checked (`resolveCustomerOrderReference`) and an unmatched one falls
 *      back to the CALLER's own orders. A foreign id survives that branch in one
 *      case only — a caller who owns nothing — and there the review-product
 *      resolution (`resolveReviewedProduct`, also owner-scoped) finds no line
 *      items, stamps `REVIEW_PRODUCT_UNRESOLVED`, and
 *      `refuseUnresolvedReviewProductGuard` (compose-policy-packs.ts) REFUSEs:
 *      no `productId`, no write.
 *      → resolve-and-assemble.test.ts, the two `order.review.submit` blocks.
 *   3. No foreign fact reaches the turn. `loadOrderCtx` is owner-scoped at the
 *      domain layer AND post-checks `order.customerId === customerId`, so a
 *      foreign id yields the null-order ctx (`resourceOwnerConfirmed: false`,
 *      `owned: []`) — nothing about the other customer's order is projected.
 *      → resolve-and-assemble.test.ts, "the ctx leaks NO foreign order fact".
 *
 *  Residual, recorded honestly: the executor does NOT independently verify that
 *  `orderId` belongs to the caller. Its upsert is keyed on the COMPOSITE
 *  `(orderId, customerId)` with the customerId taken from the verified context
 *  (customer.service.ts `performSubmitReview`), so a review can never
 *  impersonate or overwrite the order owner's row — but the order-ownership
 *  check itself lives entirely upstream, plus a route-level
 *  `getById(orderId, {customerId})` gate on the separate web path
 *  (POST /api/me/reviews, routes/me.ts).
 *
 *  If a future change DOES gate this kind, note that adding it here is not
 *  sufficient on its own: `enforceOrderOwnership` (packages/pack-orders
 *  policies.ts) gates on its OWN `OWNERSHIP_GATED_ORDER_KINDS` set, so a kind
 *  added only here gets a `resourceRefs` stamp and an injected authority graph
 *  that NOTHING reads — a change that looks wired and enforces nothing. Both
 *  sets, and a control/treatment pair at the kernel seam, or neither.
 *
 *  ── F-24: THREE sets, one agreement test ────────────────────────────────────
 *  The third is `OWNERSHIP_GATED_PAYMENT_KINDS` (packages/pack-payments
 *  policies.ts) — the payment half's own gate. All three are checked against a
 *  hand-written roll call, and each half against its pack's MEASURED enforcement,
 *  by `claustrum/__tests__/ownership-set-agreement.test.ts`. Edit this set there
 *  too, or that test reds by name. It also records the reverse direction: a kind
 *  in a PACK set but not here is SILENT, because this same set decides whether
 *  `state.authority` is injected at all — the pack guard then returns null on its
 *  `authority === undefined` line and the pack-side membership buys nothing. */
export const OWNERSHIP_GATED_KINDS: ReadonlySet<string> = new Set([
  "order.cancel",
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
  "payment.refund.issue",
  "payment.refund.confirm",
  "payment.pix.regenerate",
]);

/** The resource id an ownership-gated envelope binds to (the orderId), or null
 *  for non-gated kinds / a missing id. */
export function ownershipResource(kind: string, payload: Record<string, unknown>): string | null {
  if (!OWNERSHIP_GATED_KINDS.has(kind)) return null;
  const orderId = payload.orderId;
  return typeof orderId === "string" ? orderId : null;
}

/** `resourceRefs` to stamp on an ownership-gated envelope (owner = the
 *  authenticated customer; resource = the orderId), or undefined when not gated. */
export function resourceRefsForIntent(
  kind: string,
  payload: Record<string, unknown>,
  customerId: string,
): Record<string, string> | undefined {
  const resource = ownershipResource(kind, payload);
  return resource === null ? undefined : { owner: customerId, resource };
}

export interface CustomerAuthority {
  readonly store: ReturnType<typeof createAuthorityGraphStore>;
  readonly principalOf: PrincipalForSession;
}

/** Resolve a session id → its AUTHENTICATED principal (sync — the kernel is pure).
 *  This is the seam that makes the kernel IDOR gate load-bearing: the binding MUST
 *  be sourced from the trusted upstream identity (the conductor-authenticated
 *  session), NOT from the envelope's self-reported `actor.sessionId`. The guard
 *  then checks `principalOf(envelope.actor.sessionId) === resourceOwner`, which
 *  genuinely verifies the acting session belongs to the resource owner instead of
 *  comparing the envelope's actor to itself. */
export type PrincipalForSession = (sessionId: string) => string | null;

/** Customer-turn principal binding: the conductor-AUTHENTICATED session (i.e.
 *  `cognition.conversationId`, independent of the envelope's actor) resolves to
 *  the authenticated customer; any other session id → null (the IDOR gate REFUSEs).
 *  Staff / managed-agent sessions resolving to a non-owner principal granted
 *  SCOPED access (delegation) is a documented follow-up — today they resolve to
 *  null (fail-closed). */
export function customerPrincipalForSession(
  authenticatedSessionId: string,
  customerId: string,
): PrincipalForSession {
  return (sessionId) => (sessionId === authenticatedSessionId ? customerId : null);
}

/** Build the per-turn authority context: an authority graph binding the customer
 *  to ONLY the resources they were ownership-confirmed to own this turn, plus the
 *  injected `principalForSession` (the authenticated session→principal binding,
 *  built via `customerPrincipalForSession`). A resource not in `owned` is unbound
 *  ⇒ the guard REFUSEs (de-vacuumed); a session that is not the authenticated one
 *  ⇒ principalOf → null ⇒ the IDOR gate REFUSEs. */
export function buildCustomerAuthority(
  customerId: string,
  owned: readonly string[],
  principalForSession: PrincipalForSession,
): CustomerAuthority {
  const edges = owned.map((resource) => ({
    principal: customerId,
    relationship: "owns" as const,
    resource,
    permits: { actions: [...OWNERSHIP_GATED_KINDS] },
  }));
  return {
    store: createAuthorityGraphStore({ edges }),
    principalOf: principalForSession,
  };
}
