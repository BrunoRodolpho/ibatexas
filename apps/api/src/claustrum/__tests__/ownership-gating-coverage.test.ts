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
import { OWNERSHIP_GATED_KINDS } from "../authority-wiring.js";
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
