// 034-F1 anti-drift guard. The kernel ownership guard engages for every kind in
// OWNERSHIP_GATED_KINDS (the resolver injects state.authority + resourceRefs).
// For the guard to confirm ownership instead of REFUSING the resource's TRUE
// owner, resolveAndAssemble MUST route that kind to a loader that sets
// `resourceOwnerConfirmed`: loadOrderCtx (kinds in ORDER_BY_ID_KINDS) or
// loadPaymentCtx (payment.* kinds). Any ownership-gated kind that falls to the
// cart loader gets `owned = []`, an empty authority graph, and a false REFUSE.
//
// This pins the invariant so the three hand-maintained kind-sets
// (OWNERSHIP_GATED_KINDS / OWNERSHIP_GATED_ORDER_KINDS / ORDER_BY_ID_KINDS)
// cannot silently drift apart again (the bug behind the granular amend kinds).

import { describe, expect, it } from "vitest";
import { adjudicate, buildEnvelope, createAuthorityGraphStore } from "@adjudicate/core";
import { ordersPolicyBundle } from "@ibatexas/pack-orders";
import { OWNERSHIP_GATED_KINDS, resourceRefsForIntent } from "../authority-wiring.js";
import { ORDER_BY_ID_KINDS } from "../resolve-and-assemble.js";

describe("034-F1 ownership-gating coverage", () => {
  it("every ownership-gated kind routes to a resourceOwnerConfirmed-capable loader", () => {
    // Mirror resolveAndAssemble's dispatch: payment.* → loadPaymentCtx (confirms),
    // ORDER_BY_ID_KINDS → loadOrderCtx (confirms). Anything else falls to the cart
    // loader, which never confirms ownership.
    const confirmable = (kind: string): boolean =>
      kind.startsWith("payment.") || ORDER_BY_ID_KINDS.has(kind);

    const orphaned = [...OWNERSHIP_GATED_KINDS].filter((k) => !confirmable(k));

    expect(orphaned).toEqual([]);
  });

  it("the granular amend kinds resolve by id (regression for the original drift)", () => {
    for (const k of [
      "order.amend.add_item",
      "order.amend.update_qty",
      "order.amend.remove_item",
    ]) {
      expect(OWNERSHIP_GATED_KINDS.has(k)).toBe(true);
      expect(ORDER_BY_ID_KINDS.has(k)).toBe(true);
    }
  });
});

// ── F-14 — membership here must buy ENFORCEMENT, not just a stamp ────────────
//
// `OWNERSHIP_GATED_KINDS` decides what this host STAMPS (`resourceRefs`) and what
// its authority-graph edges PERMIT. It does NOT decide what the kernel CHECKS:
// `enforceOrderOwnership` (packages/pack-orders policies.ts) gates on a second,
// hand-maintained set of its own. A kind added HERE and not THERE gets a
// resourceRefs stamp and an injected authority graph that nothing reads — a
// change that looks wired, passes the loader-coverage test above, and enforces
// nothing. This block drives the REAL bundle so that class of counterfeit fix
// cannot ship silently.
//
// Scope line: the order half only. The `payment.*` members are enforced by the
// payments pack's own guard, which this file does not compose.
const ORDER_HALF = [...OWNERSHIP_GATED_KINDS].filter((k) => k.startsWith("order."));

function unboundEnvelope(kind: string) {
  return buildEnvelope({
    kind,
    payload: { orderId: "order-B", itemId: "li-1", item: "coca", quantity: 1 },
    actor: { principal: "llm", sessionId: "sess-A" },
    taint: "UNTRUSTED",
    nonce: `n-${kind}`,
    // The host's own stamp — the exact shape `resourceRefsForIntent` produces.
    resourceRefs: { owner: "cust-A", resource: "order-B" },
  });
}

/** cust-A owns order-A ONLY, so an envelope targeting order-B is unbound. */
function authorityState() {
  return {
    ctx: {
      tenantId: "ibatexas",
      channel: "whatsapp",
      customerId: "cust-A",
      isAuthenticated: true,
      actor: { principal: "user", id: "cust-A" },
      cartId: null,
      orderId: "order-B",
      fulfillmentStatus: "pending",
      lastAction: null,
    },
    authority: {
      store: createAuthorityGraphStore({
        edges: [
          {
            principal: "cust-A",
            relationship: "owns" as const,
            resource: "order-A",
            permits: { actions: [...OWNERSHIP_GATED_KINDS] },
          },
        ],
      }),
      principalOf: (sid: string) => (sid === "sess-A" ? "cust-A" : null),
    },
  };
}

describe("F-14 — every ownership-gated ORDER kind is actually ENFORCED by the pack guard", () => {
  it("the order half is non-empty (guards the census below against becoming vacuous)", () => {
    expect(ORDER_HALF.length).toBeGreaterThan(0);
  });

  it.each(ORDER_HALF)(
    "%s: an unbound resource REFUSEs order.ownership_denied (the stamp is read, not just written)",
    (kind) => {
      const decision = adjudicate(
        unboundEnvelope(kind) as never,
        authorityState() as never,
        ordersPolicyBundle as never,
      );
      expect(decision.kind).toBe("REFUSE");
      if (decision.kind !== "REFUSE") return;
      expect(decision.refusal.code).toBe("order.ownership_denied");
    },
  );

  // The deliberate NON-member, with the control that makes the claim directional:
  // `order.cancel` (a real member) DOES get a stamp on the very same call, so a
  // broken `resourceRefsForIntent` could not make this pair pass. See the F-14
  // decision record on OWNERSHIP_GATED_KINDS for why the absence is sound and
  // which tests measure each vector.
  it("order.review.submit is deliberately NOT gated — no resourceRefs stamp, while order.cancel (control) IS stamped", () => {
    const payload = { orderId: "order-B" };
    expect(resourceRefsForIntent("order.review.submit", payload, "cust-A")).toBeUndefined();
    expect(resourceRefsForIntent("order.cancel", payload, "cust-A")).toEqual({
      owner: "cust-A",
      resource: "order-B",
    });
  });
});
