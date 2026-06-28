// 034-F1 — the IDOR principal binding must be LOAD-BEARING: principalOf is keyed
// on the conductor-AUTHENTICATED session (cognition.conversationId), independent
// of the envelope's self-reported actor.sessionId. The kernel guard then checks
// principalOf(envelope.actor.sessionId) === resourceOwner, so:
//  - a legit turn (planner stamps actor.sessionId = conversationId) → MATCHES → pass
//  - a divergent / forged / cross-session actor → null → REFUSE
// (This is the de-tautologization: the binding is no longer derived from the same
// actor.sessionId it is later queried with.)

import { describe, expect, it } from "vitest";
import { buildCustomerAuthority, customerPrincipalForSession } from "../authority-wiring.js";

describe("customerPrincipalForSession", () => {
  it("resolves the AUTHENTICATED session to the customer, any other session to null", () => {
    const principalOf = customerPrincipalForSession("conv-authenticated", "cust-1");
    expect(principalOf("conv-authenticated")).toBe("cust-1");
    expect(principalOf("conv-other")).toBeNull();
    expect(principalOf("")).toBeNull();
  });
});

describe("buildCustomerAuthority principalOf wiring (load-bearing IDOR gate)", () => {
  const authority = buildCustomerAuthority(
    "cust-1",
    ["order-1"],
    customerPrincipalForSession("conv-authenticated", "cust-1"),
  );

  it("principalOf is sourced from the injected authenticated binding, not the queried session itself", () => {
    // Simulate the guard's gate (2): authed = principalOf(envelope.actor.sessionId).
    // When the envelope's actor session equals the authenticated session → owner.
    expect(authority.principalOf("conv-authenticated")).toBe("cust-1");
    // When the adjudicated envelope's actor session diverges from the
    // authenticated conversation session → null → the gate REFUSEs (no longer a
    // tautology, which always returned the customer for the queried session).
    expect(authority.principalOf("conv-forged")).toBeNull();
  });

  it("builds an authority store over the ownership-confirmed resources", () => {
    expect(authority.store).toBeDefined();
  });
});
