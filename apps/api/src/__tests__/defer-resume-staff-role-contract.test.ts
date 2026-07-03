// BKL-069 Part D — DEFER-resume × staff-role contract drift guard.
//
// Governor decision: resume stays system-elevated / role-free at the kernel and
// adapter layer (Option 1); role authority is re-established ADOPTER-SIDE. The
// PIX defer-resolver (subscribers/defer-resolver.ts) re-adjudicates a resumed
// envelope through the RAW `ordersPolicyBundle` from @ibatexas/pack-orders —
// which does NOT carry the AUTH-phase `staffRoleGuard` (that guard is prepended
// only in the composed conductor router, `policyForKind`).
//
// That is SOUND today — not a hole — because of the invariant this test pins:
//
//   The ONLY DEFER-able kind is `order.checkout.create` (a customer-plane kind
//   that never carries actor.role). NONE of the seven staff-plane kinds can
//   produce a DEFER, so the role-guard-free resume bundle never re-adjudicates a
//   role-gated staff envelope.
//
// This test FAILS if someone makes a staff-plane kind DEFER-able (or adds a
// staff kind to a bundle that can DEFER) without revisiting the contract in
// docs/architecture/defer-resume-role-contract.md. See §6 trigger condition (1).

import { describe, expect, it } from "vitest";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { ordersPolicyBundle, type OrderState } from "@ibatexas/pack-orders";
import { STAFF_PLANE_KINDS } from "../claustrum/staff-role-matrix.js";

const DET_TIME = "2026-07-02T12:00:00.000Z";

// The EXACT typed surface the PIX defer-resolver re-adjudicates through
// (subscribers/defer-resolver.ts widens the pack bundle identically). Widening
// is zero-behaviour: adjudicate() routes by `kind` at runtime.
const resumeBundle = ordersPolicyBundle as unknown as PolicyBundle<
  string,
  unknown,
  OrderState
>;

/**
 * An `admin:`-session, role-carrying staff envelope — the shape Part B threads
 * for the seven staff kinds. (Role is irrelevant to the DEFER verdict; it is
 * included to model the real resumed-envelope shape faithfully.)
 */
function staffEnvelope(kind: string): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload: { cartId: "cart-1", orderId: "order-1", paymentMethod: "pix" },
    actor: { principal: "user", sessionId: "admin:staff_1", role: "MANAGER" },
    taint: "TRUSTED",
    nonce: "n-staff",
    createdAt: DET_TIME,
  }) as IntentEnvelope;
}

/** An in-flight, unconfirmed PIX state — the world that trips `deferOnPendingPix`. */
function inFlightPixState(): OrderState {
  return {
    ctx: {
      channel: "whatsapp",
      customerId: "c-1",
      cartId: "cart-1",
      orderId: null,
      items: [{ variantId: "v-1", quantity: 1, priceInCentavos: 5_000 }],
      fulfillment: "delivery",
      paymentMethod: "pix",
      paymentStatus: "pending",
      totalInCentavos: 5_000,
      lastAction: null,
    },
  };
}

describe("DEFER-resume × staff-role contract (BKL-069 Part D)", () => {
  it("positive control: order.checkout.create with in-flight PIX DEFERs through the resume bundle", () => {
    // Proves the negatives below are not vacuous — this state genuinely trips a
    // PIX DEFER through the SAME bundle the resolver uses.
    const decision = adjudicate(
      buildEnvelope({
        kind: "order.checkout.create",
        payload: { cartId: "cart-1", paymentMethod: "pix" },
        actor: { principal: "llm", sessionId: "s-cust" },
        taint: "UNTRUSTED",
        nonce: "n-checkout",
        createdAt: DET_TIME,
      }) as IntentEnvelope,
      inFlightPixState(),
      resumeBundle,
    );
    expect(decision.kind).toBe("DEFER");
  });

  it("no staff-plane kind DEFERs through the resume bundle (role-free bundle is sound because staff kinds cannot be parked)", () => {
    for (const kind of STAFF_PLANE_KINDS) {
      const decision = adjudicate(staffEnvelope(kind), inFlightPixState(), resumeBundle);
      expect(
        decision.kind,
        `staff-plane kind "${kind}" produced a DEFER — a staff kind is now parkable; ` +
          `revisit docs/architecture/defer-resume-role-contract.md §6 (the PIX resume ` +
          `bundle has no staffRoleGuard) before shipping.`,
      ).not.toBe("DEFER");
    }
  });

  it("the only DEFER-able kind (order.checkout.create) is not a staff-plane kind", () => {
    // Static drift guard: if order.checkout.create ever joins the staff matrix
    // (or a staff kind becomes the DEFER-able one), the resume path could resume
    // a role-gated envelope through the role-guard-free bundle.
    expect(STAFF_PLANE_KINDS.has("order.checkout.create")).toBe(false);
  });
});
