// BKL-069 Part D — DEFER-resume × staff-role contract drift guard.
//
// Governor decision: resume stays system-elevated / role-free at the kernel and
// adapter layer (Option 1); role authority is re-established ADOPTER-SIDE. The
// resume/resolve surfaces (docs/architecture/defer-resume-role-contract.md §3a)
// either re-adjudicate through a RAW pack bundle that does NOT carry the
// AUTH-phase `staffRoleGuard` (the PIX defer-resolver, `ordersPolicyBundle`) or
// do not re-adjudicate at all (the anonymize-grace resolver EXECUTEs the parked
// `customer.anonymize` directly). `staffRoleGuard` is prepended only in the
// composed conductor router (`policyForKind`).
//
// That is SOUND today — not a hole — because of the invariant this test pins:
//
//   Every DEFER-able kind is a customer-plane, role-free kind that never carries
//   actor.role. §3b of the ADR enumerates three DEFER producers —
//   order.checkout.create (deferOnPendingPix), customer.anonymize
//   (deferAnonymizeForGrace) and the installed pixPolicyBundle's pix.charge.create
//   (deferChargeCreate) — and NONE of the staff-plane kinds can produce a
//   DEFER through the bundle that owns it.
//
// De-vacuified over the prior form of this test, which adjudicated all staff
// kinds against a SINGLE bundle (`ordersPolicyBundle`): for the kinds
// that pack does not own, its guards kind-mismatch and the envelope falls through
// to `default: REFUSE`, so a DEFER producer added to the payments/reservations
// bundle would never have been exercised. This version routes EACH staff kind to
// its OWNING composed production bundle (§ `owningBundle` below) and additionally
// scans that bundle's guards directly so a business-phase DEFER cannot be masked
// by a taint/auth short-circuit.
//
// This test FAILS if someone makes a staff-plane kind DEFER-able (or adds a staff
// kind to a bundle that can DEFER) without revisiting the contract in
// docs/architecture/defer-resume-role-contract.md. See §6 trigger condition (1).

import { describe, expect, it } from "vitest";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import {
  buildEnvelope,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import { staffCommandPolicyBundle } from "@ibatexas/domain";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import {
  resolveCapabilityPolicy,
  type CapabilityPolicyPack,
} from "../claustrum/capability-policy.js";
import { STAFF_PLANE_KINDS } from "../claustrum/staff-role-matrix.js";

const DET_TIME = "2026-07-02T12:00:00.000Z";

// The composition that routes each kind to its OWNING pack bundle. This is the
// EXACT list claustrum-bootstrap feeds `composePolicyRouter`/`policyForKind`
// (`buildIbatexasPolicyPacks(IBATEXAS_COMPOSED_PACKS, …)`), and the composition
// the ADR §6 says a future staff-kind resume MUST be routed through. It resolves
// order kinds to `ordersPolicyBundle` (the SAME pack bundle the PIX defer-resolver
// re-adjudicates through), payment kinds to `paymentsPolicyBundle`, and
// reservation kinds to `reservationsPolicyBundle`. (The domain-local
// `orderProjectionPolicyBundle` / `paymentProjectionPolicyBundle` used by the HTTP
// command services are a different, non-resume surface and are out of scope for
// the resume-role contract.)
const IBATEXAS_POLICY_PACKS = buildIbatexasPolicyPacks(
  IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
);

/**
 * The four AUT-038 + AUT-007 staff-CRUD verbs are the domain-internal
 * `StaffCommandService` plane (staff-command.service.ts), NOT composed Packs —
 * exactly like the `ops.alert.*` / `incident.ticket.*` domain-internal kinds.
 * Their OWNING bundle is `staffCommandPolicyBundle`, adjudicated by the HTTP
 * admin staff routes via the command service (not `policyForKind`). The contract
 * this test pins — no staff-plane kind is DEFER-able — holds for them too:
 * `staffCommandPolicyBundle` has a TRUSTED taint floor and a single `executeAll`
 * business guard, no DEFER producer.
 */
const STAFF_COMMAND_KINDS: ReadonlySet<string> = new Set([
  "staff.create",
  "staff.update",
  "staff.deactivate",
  "staff.role.assign",
]);

/** The production bundle that owns `kind` (throws if unrouted). */
function owningBundle(kind: string): PolicyBundle<string, unknown, unknown> {
  if (STAFF_COMMAND_KINDS.has(kind)) {
    return staffCommandPolicyBundle as unknown as PolicyBundle<
      string,
      unknown,
      unknown
    >;
  }
  const bundle = resolveCapabilityPolicy(
    IBATEXAS_POLICY_PACKS as unknown as ReadonlyArray<CapabilityPolicyPack>,
    kind,
  );
  if (!bundle) throw new Error(`no owning pack routes staff kind "${kind}"`);
  return bundle;
}

/**
 * The complete set of DEFER-able intent kinds today, per
 * docs/architecture/defer-resume-role-contract.md §3b (three producers:
 * `deferOnPendingPix` → order.checkout.create, `deferAnonymizeForGrace` →
 * customer.anonymize, and the installed pixPolicyBundle's `deferChargeCreate` →
 * pix.charge.create). Hand-maintained: ADR §6 trigger condition (1) says adding a
 * staff kind here (or a DEFER producer for one) requires revisiting the
 * resume-role contract.
 */
const DEFERABLE_KINDS: ReadonlySet<string> = new Set([
  "order.checkout.create",
  "customer.anonymize",
  "pix.charge.create",
]);

/**
 * A broad union `ctx` that simultaneously (a) trips the PIX-pending DEFER for
 * `order.checkout.create` (`paymentStatus: "pending"`, `paymentMethod: "pix"`,
 * matching the known-good in-flight PIX state) and (b) satisfies every
 * precondition the `customer.anonymize` grace DEFER requires (authenticated,
 * fresh OTP, exists, no parked anonymize, `immediateErasure` absent). Carrying a
 * superset of order / customer-onboarding / payment / reservation fields keeps
 * every pack's kind-matching guards from reading `undefined`. Typed `unknown`;
 * `adjudicate` routes by kind at runtime.
 */
function deferInducingWorld(): unknown {
  return {
    ctx: {
      // orders — the known-good in-flight PIX DEFER state (orderId null).
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
      // customer-onboarding — satisfies the anonymize-grace preconditions.
      actor: { principal: "user", id: "c-1" },
      customerExists: true,
      isAuthenticated: true,
      otpFresh: true,
      hasParkedAnonymize: false,
      now: new Date(DET_TIME),
      // payments — benign (no payment DEFER producer exists).
      exists: true,
      currentStatus: "confirmed",
      isTerminal: false,
      amountInCentavos: 5_000,
      refundedAmountCentavos: 0,
      // reservations — no snapshot ⇒ guards REFUSE/no-op, never DEFER.
      reservation: null,
      slot: null,
      newSlot: null,
      customer: null,
    },
  };
}

/** A quiescent world: no PIX pending, unauthenticated — nothing DEFERs. */
function neutralWorld(): unknown {
  return {
    ctx: {
      channel: "web",
      customerId: "c-1",
      cartId: null,
      orderId: "order-1",
      items: [],
      fulfillment: "delivery",
      paymentMethod: "cash",
      paymentStatus: null,
      totalInCentavos: 5_000,
      lastAction: null,
      actor: { principal: "user", id: "c-1" },
      customerExists: true,
      isAuthenticated: false,
      otpFresh: false,
      hasParkedAnonymize: false,
      now: new Date(DET_TIME),
      exists: false,
      isTerminal: false,
      reservation: null,
      slot: null,
      newSlot: null,
      customer: null,
    },
  };
}

/**
 * An `admin:`-session, role-carrying staff envelope — the shape Part B threads
 * for the staff kinds. Role MANAGER is permitted for all of them (so
 * `staffRoleGuard` does not itself REFUSE, and the DEFER verdict is what is under
 * test). A superset payload keeps per-kind guards from reading `undefined`.
 *
 * NOTE: for `product.availability.set` this superset payload is not a valid
 * ops payload (it carries no `productId`/`available`), so the ops pack REFUSEs
 * it at the business phase — still not a DEFER, which is all this contract pins.
 */
function staffEnvelope(kind: string): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload: {
      cartId: "cart-1",
      orderId: "order-1",
      reservationId: "resv-1",
      paymentId: "pay-1",
      paymentMethod: "pix",
      body: "nota",
      refundCentavos: 100,
      expectedVersion: 1,
    },
    actor: { principal: "user", sessionId: "admin:staff_1", role: "MANAGER" },
    taint: "TRUSTED",
    nonce: "n-staff",
    createdAt: DET_TIME,
  }) as IntentEnvelope;
}

/** The customer/LLM `order.checkout.create` envelope (positive control). */
function checkoutEnvelope(): IntentEnvelope {
  return buildEnvelope({
    kind: "order.checkout.create",
    payload: { cartId: "cart-1", paymentMethod: "pix" },
    actor: { principal: "llm", sessionId: "s-cust" },
    taint: "UNTRUSTED",
    nonce: "n-checkout",
    createdAt: DET_TIME,
  }) as IntentEnvelope;
}

/** The authenticated-customer `customer.anonymize` envelope (positive control). */
function anonymizeEnvelope(): IntentEnvelope {
  return buildEnvelope({
    kind: "customer.anonymize",
    payload: { customerId: "c-1", otpToken: "tok-1", scope: "lgpd_art_18" },
    actor: { principal: "user", sessionId: "s-1" },
    taint: "UNTRUSTED",
    nonce: "n-anon",
    createdAt: DET_TIME,
  }) as IntentEnvelope;
}

describe("DEFER-resume × staff-role contract (BKL-069 Part D)", () => {
  it("positive control: order.checkout.create DEFERs under in-flight PIX through pack-orders", () => {
    // Proves the negatives below are non-vacuous for the ORDERS bundle — this
    // state genuinely trips a PIX DEFER through the owning composed bundle.
    const decision = adjudicate(
      checkoutEnvelope(),
      deferInducingWorld() as never,
      owningBundle("order.checkout.create"),
    );
    expect(decision.kind).toBe("DEFER");
  });

  it("positive control: customer.anonymize DEFERs under its grace state through pack-customer-onboarding", () => {
    // Proves the negatives below are non-vacuous for the CUSTOMER-ONBOARDING
    // bundle — the grace preconditions genuinely trip an anonymize DEFER.
    const decision = adjudicate(
      anonymizeEnvelope(),
      deferInducingWorld() as never,
      owningBundle("customer.anonymize"),
    );
    expect(decision.kind).toBe("DEFER");
  });

  it("no staff-plane kind DEFERs through the bundle that OWNS it (PIX-pending, anonymize-grace, or neutral state)", () => {
    const worlds = [
      {
        label: "DEFER-inducing (in-flight PIX + anonymize grace)",
        state: deferInducingWorld(),
      },
      { label: "neutral", state: neutralWorld() },
    ];
    for (const kind of STAFF_PLANE_KINDS) {
      const bundle = owningBundle(kind);
      for (const { label, state } of worlds) {
        // (1) Full-pipeline outcome through the owning composed bundle.
        const decision = adjudicate(staffEnvelope(kind), state as never, bundle);
        expect(
          decision.kind,
          `staff-plane kind "${kind}" produced a DEFER under ${label} — a staff ` +
            `kind is now parkable; revisit docs/architecture/defer-resume-role-` +
            `contract.md §6 (its resume path has no staffRoleGuard) before shipping.`,
        ).not.toBe("DEFER");

        // (2) Direct guard scan — DEFER can only be EMITTED by a guard; scanning
        // every guard of the owning bundle makes the assertion non-vacuous even
        // if a taint/auth REFUSE would short-circuit the full pipeline before a
        // (hypothetical) business-phase staff DEFER.
        for (const guard of [
          ...bundle.stateGuards,
          ...bundle.authGuards,
          ...bundle.business,
        ]) {
          const d = guard(staffEnvelope(kind), state) as Decision | null;
          expect(
            d?.kind,
            `a guard of the "${kind}" owning bundle emitted DEFER under ${label}`,
          ).not.toBe("DEFER");
        }
      }
    }
  });

  it("census-intersection: no DEFER-able kind is a staff-plane kind (∅, ADR §3b)", () => {
    // Static drift guard over the maintained DEFER-able-kind census: if any of
    // the three DEFER producers ever comes to match a staff kind (or a staff
    // kind is added to the census), this trips before the runtime assertions.
    const intersection = [...DEFERABLE_KINDS].filter((k) =>
      STAFF_PLANE_KINDS.has(k),
    );
    expect(
      intersection,
      `DEFER-able ∩ staff-plane must be empty; found [${intersection.join(", ")}]. ` +
        `A staff kind is now DEFER-able — revisit docs/architecture/` +
        `defer-resume-role-contract.md §6 trigger condition (1).`,
    ).toEqual([]);
  });
});
