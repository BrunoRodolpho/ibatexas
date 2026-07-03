// run-staff-ops-intent — the NEW-032 load-bearing proof: an admin:+role staff
// envelope routed through the COMPOSED policy router is gated by staffRoleGuard.
//
// Exercises the REAL composed production bundle (buildIbatexasPolicyPacks over
// IBATEXAS_COMPOSED_PACKS — the exact list claustrum-bootstrap feeds policyForKind)
// + the REAL kernel adjudicate, injected into runStaffOpsIntent. This turns the
// DORMANT staffRoleGuard (BKL-069) into a live, asserted gate:
//   - a permitted role EXECUTEs (guard inert) and the executor runs;
//   - a not-permitted role REFUSEs (staff_role_violation) and the executor never runs;
//   - an absent role REFUSEs (staff_role_absent);
//   - an unrouted kind fails closed (ops_kind_unrouted).

import { describe, expect, it, vi } from "vitest";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../../claustrum/compose-policy-packs.js";
import {
  resolveCapabilityPolicy,
  type CapabilityPolicyPack,
} from "../../claustrum/capability-policy.js";
import {
  buildStaffOpsEnvelope,
  runStaffOpsIntent,
} from "../run-staff-ops-intent.js";

// The staffRoleGuard uses ONE refusal code (staff_role_violation); the distinct
// case (absent / unknown / not-permitted) rides basis[].meta.reason. Shape-agnostic
// extraction so the absent-vs-not-permitted assertions are non-vacuous.
const basisMentions = (decision: Decision, reason: string): boolean =>
  JSON.stringify((decision as { basis?: unknown }).basis ?? []).includes(reason);

// The EXACT composition claustrum-bootstrap feeds policyForKind.
const IBATEXAS_POLICY_PACKS = buildIbatexasPolicyPacks(
  IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
);

const resolvePolicy = (
  kind: string,
): PolicyBundle<string, unknown, unknown> | null =>
  resolveCapabilityPolicy(
    IBATEXAS_POLICY_PACKS as unknown as ReadonlyArray<CapabilityPolicyPack>,
    kind,
  );

// The REAL pure kernel adjudication (no audit — the guard behaviour under test is
// audit-independent; the audited bridge is exercised at the route layer).
const realAdjudicate = async (
  envelope: IntentEnvelope,
  state: unknown,
  policy: PolicyBundle<string, unknown, unknown>,
): Promise<Decision> => adjudicate(envelope, state as never, policy);

// A broad ctx superset so no pack's kind-matching state/business guard reads
// `undefined` — mirrors the defer-resume-staff-role-contract test's world.
function opsWorld(): unknown {
  return {
    ctx: {
      channel: "web",
      customerId: "c-1",
      cartId: null,
      orderId: "order-1",
      items: [],
      fulfillment: "delivery",
      paymentMethod: "pix",
      paymentStatus: "confirmed",
      totalInCentavos: 5_000,
      lastAction: null,
      actor: { principal: "user", id: "staff_1" },
      customerExists: true,
      isAuthenticated: true,
      otpFresh: true,
      hasParkedAnonymize: false,
      now: new Date("2026-07-03T12:00:00.000Z"),
      exists: true,
      currentStatus: "confirmed",
      isTerminal: false,
      amountInCentavos: 5_000,
      refundedAmountCentavos: 0,
      reservation: null,
      slot: null,
      newSlot: null,
      customer: null,
    },
  };
}

const NOTE_PAYLOAD = { orderId: "order-1", body: "nota operacional" };
const REFUND_PAYLOAD = { orderId: "order-1", paymentId: "pay-1", refundCentavos: 100 };

describe("buildStaffOpsEnvelope — the admin:+role shape staffRoleGuard gates", () => {
  it("stamps admin:${staffId} + role + TRUSTED", () => {
    const env = buildStaffOpsEnvelope("order.note.add", NOTE_PAYLOAD, "staff_1", "MANAGER") as {
      actor: { principal: string; sessionId: string; role?: string };
      taint: string;
    };
    expect(env.actor.principal).toBe("user");
    expect(env.actor.sessionId).toBe("admin:staff_1");
    expect(env.actor.role).toBe("MANAGER");
    expect(env.taint).toBe("TRUSTED");
  });

  it("omits role when absent (canonical-drop-safe)", () => {
    const env = buildStaffOpsEnvelope("order.note.add", NOTE_PAYLOAD, "staff_1") as {
      actor: { role?: string };
    };
    expect(env.actor.role).toBeUndefined();
  });
});

describe("runStaffOpsIntent — staffRoleGuard gates through the composed router (NEW-032)", () => {
  it("ATTENDANT + order.note.add → EXECUTE (guard inert; matrix permits) and the executor RUNS", async () => {
    const executor = vi.fn().mockResolvedValue({ noteId: "note_1" });
    const out = await runStaffOpsIntent({
      kind: "order.note.add",
      payload: NOTE_PAYLOAD,
      staffId: "staff_1",
      actorRole: "ATTENDANT",
      state: opsWorld(),
      resolvePolicy,
      adjudicate: realAdjudicate,
      executor,
    });
    expect(out.decision.kind).toBe("EXECUTE");
    expect(out.executed).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("ATTENDANT + payment.refund.issue → REFUSE staff_role_violation and the executor NEVER runs", async () => {
    const executor = vi.fn();
    const out = await runStaffOpsIntent({
      kind: "payment.refund.issue",
      payload: REFUND_PAYLOAD,
      staffId: "staff_1",
      actorRole: "ATTENDANT", // refund is OWNER/MANAGER only
      state: opsWorld(),
      resolvePolicy,
      adjudicate: realAdjudicate,
      executor,
    });
    expect(out.decision.kind).toBe("REFUSE");
    expect(
      out.decision.kind === "REFUSE" ? out.decision.refusal.code : "",
    ).toBe("staff_role_violation");
    expect(basisMentions(out.decision, "staff_role_not_permitted")).toBe(true);
    expect(out.executed).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it("absent role + order.note.add → REFUSE (staff_role_absent basis, fail-closed) and the executor NEVER runs", async () => {
    const executor = vi.fn();
    const out = await runStaffOpsIntent({
      kind: "order.note.add",
      payload: NOTE_PAYLOAD,
      staffId: "staff_1",
      // actorRole omitted — a staff caller with no role
      state: opsWorld(),
      resolvePolicy,
      adjudicate: realAdjudicate,
      executor,
    });
    expect(out.decision.kind).toBe("REFUSE");
    expect(
      out.decision.kind === "REFUSE" ? out.decision.refusal.code : "",
    ).toBe("staff_role_violation");
    expect(basisMentions(out.decision, "staff_role_absent")).toBe(true);
    expect(out.executed).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it("unrouted kind → REFUSE ops_kind_unrouted (fail-closed), executor never runs, no adjudication", async () => {
    const executor = vi.fn();
    const adjudicateSpy = vi.fn();
    const out = await runStaffOpsIntent({
      kind: "not.a.real.kind",
      payload: {},
      staffId: "staff_1",
      actorRole: "OWNER",
      state: opsWorld(),
      resolvePolicy,
      adjudicate: adjudicateSpy,
      executor,
    });
    expect(out.decision.kind).toBe("REFUSE");
    expect(
      out.decision.kind === "REFUSE" ? out.decision.refusal.code : "",
    ).toBe("ops_kind_unrouted");
    expect(adjudicateSpy).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });
});
