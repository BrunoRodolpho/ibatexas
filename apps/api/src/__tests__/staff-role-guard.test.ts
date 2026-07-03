/**
 * BKL-069 Part C conformance — the staff-plane per-role capability guard.
 *
 * Proves, against the CODE-TRUTH matrix (staff-role-matrix.ts):
 *   - engagement is by the `admin:` sessionId NAMESPACE, not by kind: customer /
 *     LLM / managed-agent (`agent:`) / system-subscriber
 *     (`${sourceSubject}:${eventId}`, incl. incident.ticket.open) traffic is
 *     inert (null), even for the seven staff-plane kinds;
 *   - per-role allow/deny for each of the seven kinds (ATTENDANT is refused on
 *     payment.refund.issue and the three reservation kinds; OWNER/MANAGER pass);
 *   - fail-closed on the staff plane: absent role, unknown role value, and an
 *     unmatrixed kind all REFUSE with the stable `staff_role_violation` code and
 *     a role-opaque pt-BR message (SCN-125, zero info leak);
 *   - the guard adds friction only (null or REFUSE — never EXECUTE/CONFIRM);
 *   - through the REAL production composition (`buildIbatexasPolicyPacks`) and
 *     the REAL kernel (`adjudicate`), an ATTENDANT `payment.refund.issue` that
 *     WOULD EXECUTE by the money band is REFUSED in the AUTH phase BEFORE the
 *     business band runs (phase-ordering pin); OWNER/MANAGER and non-staff
 *     traffic still EXECUTE (no tightening).
 */

import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import { paymentsPack } from "@ibatexas/pack-payments";
import type { StaffActorRole } from "../routes/admin/_shared-actions.js";
import {
  buildIbatexasPolicyPacks,
  IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import {
  createStaffRoleGuard,
  staffRoleGuard,
  STAFF_ROLE_REFUSAL_CODE,
} from "../claustrum/staff-role-guard.js";
import {
  STAFF_KIND_ALLOWED_ROLES,
  STAFF_PLANE_KINDS,
  STAFF_ROLES,
  STAFF_ROLE_CAPABILITY_MATRIX,
} from "../claustrum/staff-role-matrix.js";

type Bundle = PolicyBundle<string, unknown, unknown>;

const THE_SEVEN = [
  "order.status.transition",
  "payment.status.transition",
  "payment.refund.issue",
  "order.note.add",
  "reservation.checkin",
  "reservation.complete",
  "reservation.cancel",
] as const;

/** A minimal staff-plane envelope; the guard never inspects payload/taint. */
function staffEnv(kind: string, role?: string, staffId = "staff_01") {
  return buildEnvelope({
    kind,
    payload: { probe: true },
    actor: {
      principal: "user" as const,
      sessionId: `admin:${staffId}`,
      ...(role ? { role } : {}),
    },
    taint: "TRUSTED" as const,
    nonce: `nonce-${kind}-${role ?? "none"}`,
  });
}

/** Same shape, non-staff sessionId (guard must stay inert). */
function nonStaffEnv(kind: string, sessionId: string, role?: string) {
  return buildEnvelope({
    kind,
    payload: { probe: true },
    actor: {
      principal: "user" as const,
      sessionId,
      ...(role ? { role } : {}),
    },
    taint: "TRUSTED" as const,
    nonce: `nonce-${kind}-${sessionId}`,
  });
}

const guard = createStaffRoleGuard(STAFF_ROLE_CAPABILITY_MATRIX);

// ── Engagement: `admin:` namespace only ─────────────────────────────────────

describe("createStaffRoleGuard — engagement by `admin:` namespace", () => {
  it("is inert (null) for every non-staff sessionId shape, even for the seven kinds", () => {
    const nonStaff = [
      "cust_001", // customer principal
      "hashed:ab12cd34", // redacted chat namespace
      "agent:pix-remediation@0.1.0:entity:pay_1", // managed agent
      "payments.events:evt_1", // system subject:eventId
      "incident.ticket.open:evt_9", // system incident subject:eventId
      "administrator:staff_1", // near-miss prefix (NOT `admin:`)
    ];
    for (const sessionId of nonStaff) {
      for (const kind of THE_SEVEN) {
        // Even with a role present, a non-`admin:` sessionId is untouched.
        expect(guard(nonStaffEnv(kind, sessionId, "ATTENDANT"), {})).toBeNull();
      }
    }
  });

  it("is inert for a system-actor incident.ticket.open envelope (never `admin:`)", () => {
    const sys = buildEnvelope({
      kind: "incident.ticket.open",
      payload: { conversationId: "conv_1" },
      actor: { principal: "system" as const, sessionId: "incident.web:evt_1" },
      taint: "SYSTEM" as const,
      nonce: "n-incident",
    });
    expect(guard(sys, {})).toBeNull();
  });
});

// ── Per-role × per-kind allow / deny (code-truth) ───────────────────────────

describe("createStaffRoleGuard — per-role capability matrix (code-truth)", () => {
  for (const kind of THE_SEVEN) {
    const allowedRoles = new Set<string>(STAFF_KIND_ALLOWED_ROLES[kind]);
    for (const role of STAFF_ROLES) {
      const shouldAllow = allowedRoles.has(role);
      it(`${role} ${shouldAllow ? "→ null (allowed)" : "→ REFUSE"} for ${kind}`, () => {
        const decision = guard(staffEnv(kind, role), {});
        if (shouldAllow) {
          expect(decision).toBeNull();
        } else {
          expect(decision?.kind).toBe("REFUSE");
          if (decision?.kind === "REFUSE") {
            expect(decision.refusal.code).toBe(STAFF_ROLE_REFUSAL_CODE);
            expect(decision.refusal.kind).toBe("AUTH");
          }
        }
      });
    }
  }

  it("ATTENDANT is refused on the money/booking kinds it cannot reach", () => {
    for (const kind of [
      "payment.refund.issue",
      "reservation.checkin",
      "reservation.complete",
      "reservation.cancel",
    ]) {
      expect(guard(staffEnv(kind, "ATTENDANT"), {})?.kind).toBe("REFUSE");
    }
  });

  it("MANAGER and OWNER pass every one of the seven kinds", () => {
    for (const role of ["OWNER", "MANAGER"] as const) {
      for (const kind of THE_SEVEN) {
        expect(guard(staffEnv(kind, role), {})).toBeNull();
      }
    }
  });
});

// ── Fail-closed on the staff plane ──────────────────────────────────────────

describe("createStaffRoleGuard — fail-closed", () => {
  it("absent role on the staff plane ⇒ REFUSE (identity_missing)", () => {
    const decision = guard(staffEnv("order.status.transition", undefined), {});
    expect(decision?.kind).toBe("REFUSE");
    if (decision?.kind === "REFUSE") {
      expect(decision.refusal.code).toBe(STAFF_ROLE_REFUSAL_CODE);
      expect(decision.refusal.kind).toBe("AUTH");
      expect(decision.basis[0]?.code).toBe("identity_missing");
    }
  });

  it("unknown role value on the staff plane ⇒ REFUSE (identity_missing)", () => {
    for (const bogus of ["SUPERADMIN", "owner", "admin", "root", ""]) {
      const decision = guard(staffEnv("order.note.add", bogus), {});
      expect(decision?.kind).toBe("REFUSE");
      if (decision?.kind === "REFUSE") {
        expect(decision.refusal.code).toBe(STAFF_ROLE_REFUSAL_CODE);
      }
    }
  });

  it("an unmatrixed kind on the staff plane ⇒ REFUSE (de-vacuum, scope_insufficient)", () => {
    // A real customer-plane kind that is NEVER staff-plane-proposable.
    for (const kind of ["order.cancel", "payment.pix.regenerate", "cart.item.add"]) {
      const decision = guard(staffEnv(kind, "OWNER"), {});
      expect(decision?.kind).toBe("REFUSE");
      if (decision?.kind === "REFUSE") {
        expect(decision.refusal.code).toBe(STAFF_ROLE_REFUSAL_CODE);
        expect(decision.basis[0]?.code).toBe("scope_insufficient");
      }
    }
  });

  it("known role NOT permitted for the kind ⇒ scope_insufficient basis", () => {
    const decision = guard(staffEnv("payment.refund.issue", "ATTENDANT"), {});
    expect(decision?.kind).toBe("REFUSE");
    if (decision?.kind === "REFUSE") {
      expect(decision.basis[0]?.code).toBe("scope_insufficient");
    }
  });

  it("the user-facing copy is pt-BR and role-opaque (SCN-125 — leaks no role)", () => {
    const decision = guard(staffEnv("payment.refund.issue", "ATTENDANT"), {});
    if (decision?.kind === "REFUSE") {
      const text = decision.refusal.userFacing;
      expect(text).toMatch(/não permite/i);
      // Never names a role that WOULD be allowed.
      expect(text).not.toMatch(/OWNER|MANAGER|ATTENDANT|propriet|gerente/i);
    }
  });

  it("only ever returns null or REFUSE — never EXECUTE/CONFIRM/ESCALATE", () => {
    const decisions = [
      guard(staffEnv("order.status.transition", "OWNER"), {}), // null
      guard(staffEnv("payment.refund.issue", "ATTENDANT"), {}), // REFUSE
      guard(staffEnv("order.cancel", "OWNER"), {}), // REFUSE (unmatrixed)
      guard(staffEnv("order.note.add", undefined), {}), // REFUSE (no role)
    ];
    for (const d of decisions) {
      expect(d === null || d.kind === "REFUSE").toBe(true);
    }
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe("createStaffRoleGuard — determinism", () => {
  it("same envelope + state ⇒ same decision", () => {
    const env = staffEnv("payment.refund.issue", "ATTENDANT");
    const a = guard(env, {});
    const b = guard(env, {});
    expect(a?.kind).toBe(b?.kind);
    if (a?.kind === "REFUSE" && b?.kind === "REFUSE") {
      expect(a.refusal.code).toBe(b.refusal.code);
      expect(a.refusal.userFacing).toBe(b.refusal.userFacing);
    }
  });
});

// ── Matrix structure (derivation is code-truth) ─────────────────────────────

describe("STAFF_ROLE_CAPABILITY_MATRIX (derived structure)", () => {
  it("the staff-plane surface is EXACTLY the seven kinds", () => {
    expect([...STAFF_PLANE_KINDS].sort()).toEqual([...THE_SEVEN].sort());
  });

  it("OWNER and MANAGER may propose all seven; ATTENDANT only the three requireStaff kinds", () => {
    expect([...STAFF_ROLE_CAPABILITY_MATRIX.OWNER].sort()).toEqual(
      [...THE_SEVEN].sort(),
    );
    expect([...STAFF_ROLE_CAPABILITY_MATRIX.MANAGER].sort()).toEqual(
      [...THE_SEVEN].sort(),
    );
    expect([...STAFF_ROLE_CAPABILITY_MATRIX.ATTENDANT].sort()).toEqual(
      [
        "order.note.add",
        "order.status.transition",
        "payment.status.transition",
      ].sort(),
    );
  });

  it("ATTENDANT can never reach refund or the reservation kinds", () => {
    for (const kind of [
      "payment.refund.issue",
      "reservation.checkin",
      "reservation.complete",
      "reservation.cancel",
    ]) {
      expect(STAFF_ROLE_CAPABILITY_MATRIX.ATTENDANT.has(kind)).toBe(false);
    }
  });
});

// ── Composition: AUTH short-circuits BEFORE the business money band ──────────

/**
 * A refund envelope that WOULD EXECUTE by pack-payments' money band (small
 * amount, settled payment, refundable balance, NO injected authority so the D1
 * ownership/eligibility/freshness conjuncts stay inert). Mirrors the pack's own
 * `refund-magnitude-ladder` EXECUTE fixture, differing only in the actor.
 */
function refundEnvelope(sessionId: string, role?: StaffActorRole) {
  return buildEnvelope({
    kind: "payment.refund.issue",
    payload: {
      paymentId: "p-1",
      refundAmountCentavos: 100, // R$1,00 — EXECUTE band (≤ R$500)
      refundableBalanceCentavos: 50_000,
      amountInCentavos: 50_000,
      currentRefundedCentavos: 0,
      actor: "admin",
    },
    actor: {
      principal: "user" as const,
      sessionId,
      ...(role ? { role } : {}),
    },
    taint: "TRUSTED" as const,
    nonce: "n-refund-compose",
  });
}

const refundState = {
  ctx: {
    actor: { principal: "admin" },
    exists: true,
    isTerminal: false,
    currentStatus: "paid",
    refundedAmountCentavos: 0,
    amountInCentavos: 50_000,
    sessionTokensConsumed: 0,
  },
};

/** Production composition (default adopter business + auth guards). */
function composedBundle(pack: unknown): Bundle {
  return buildIbatexasPolicyPacks([pack as ErasedPack])[0]!.policy as Bundle;
}

/**
 * Counterfactual: adopter BUSINESS guards only, NO adopter AUTH guards. Removing
 * all adopter auth guards is equivalent to removing just the staff-role guard
 * for `admin:` traffic — the agent guards are provably inert on non-`agent:`
 * sessionIds.
 */
function bundleWithoutAdopterAuthGuards(pack: unknown): Bundle {
  return buildIbatexasPolicyPacks(
    [pack as ErasedPack],
    IBATEXAS_ADOPTER_BUSINESS_GUARDS,
    [],
  )[0]!.policy as Bundle;
}

describe("composition — staff-role guard vs the refund money band (real packs + kernel)", () => {
  it("counterfactual: WITHOUT the adopter auth guards the ATTENDANT refund EXECUTEs (money band)", () => {
    const decision = adjudicate(
      refundEnvelope("admin:staff_att_01", "ATTENDANT"),
      refundState,
      bundleWithoutAdopterAuthGuards(paymentsPack),
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("production composition: the ATTENDANT refund is REFUSED in AUTH before the business band", () => {
    const decision = adjudicate(
      refundEnvelope("admin:staff_att_01", "ATTENDANT"),
      refundState,
      composedBundle(paymentsPack),
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind === "REFUSE") {
      expect(decision.refusal.code).toBe(STAFF_ROLE_REFUSAL_CODE);
      // AUTH-phase refusal — proves it short-circuited before the money band.
      expect(decision.refusal.kind).toBe("AUTH");
      expect(decision.basis.some((b) => b.category === "auth")).toBe(true);
    }
  });

  it("MANAGER and OWNER refunds still EXECUTE through the production composition (no tightening)", () => {
    for (const role of ["OWNER", "MANAGER"] as const) {
      const decision = adjudicate(
        refundEnvelope(`admin:staff_${role.toLowerCase()}_01`, role),
        refundState,
        composedBundle(paymentsPack),
      );
      expect(decision.kind).toBe("EXECUTE");
    }
  });

  it("non-staff (customer) traffic is untouched: the same refund envelope EXECUTEs", () => {
    const decision = adjudicate(
      refundEnvelope("cust_001"),
      refundState,
      composedBundle(paymentsPack),
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("the exported production guard is the one composed into the bundle", () => {
    const auth = composedBundle(paymentsPack).authGuards;
    expect(auth).toContain(staffRoleGuard);
  });
});
