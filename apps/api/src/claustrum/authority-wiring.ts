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
 *  money kinds (resolveAndAssemble confirms order ownership for each). */
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
