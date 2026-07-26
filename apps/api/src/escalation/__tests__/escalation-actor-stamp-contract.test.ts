// escalation-actor-stamp-contract — BKL-113. The BEHAVIOURAL half of the
// resumable-kind proposer-stamp contract (the type-level half is the exhaustive
// `ESCALATION_PROPOSER_STAMPS` registry in escalation-park-store.ts).
//
// THE CONTRACT. The pack overlay's escalate-band self-approve gate is the
// DEEPEST separation-of-duty check in the ESCALATE→approve→resume loop
// (pack-payments/src/policies.ts: `approval.approverId !== payload.actorId`).
// It compares against a PAYLOAD field, so it only gates when the authenticated
// write side actually STAMPED the proposer there. A kind added to
// `ESCALATION_RESUMABLE_KINDS` without such a stamp leaves the comparand
// `undefined`, `approverId !== undefined` is trivially true, and the gate
// silently degrades to the route JWT + engine checks only — with no failing
// test and no compile error.
//
// THE GATE. Every member of `ESCALATION_RESUMABLE_KINDS` is driven here through
// the REAL composed production policy router (`OPS_ROUTER` — the exact bundle
// the conductor SUBMIT stage and the escalation-approval engine's `policyFor`
// adjudicate against), proving for EACH kind that:
//
//   1. the canonical stamped payload carries the DECLARED proposer field;
//   2. `buildEscalationParkInput` derives `proposerId` from that stamp and NOT
//      from the session fallback;
//   3. a SELF-approval marker (approver === the stamped proposer) leaves the
//      ESCALATE INTACT — the gate BITES;
//   4. a DIFFERENT-owner marker converts to REQUEST_CONFIRMATION — the gate is
//      not vacuously escalating;
//   5. NEGATIVE CONTROL — with the declared field STRIPPED from the payload, the
//      same self-approval marker DOES convert. This reproduces the exact
//      degradation the contract exists to prevent, and is what makes arm 3
//      non-vacuous: arm 3 passes BECAUSE of the stamp, not incidentally.
//
// `ACTOR_STAMP_FIXTURES` is typed exhaustive over `EscalationResumableKind`, so
// adding a resumable kind forces a fixture — i.e. forces arms 1-5 to be PROVEN
// for it, not merely declared. The suite additionally iterates the RUNTIME set
// so a cast past the types still fails here.

import { describe, expect, it } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import {
  buildEscalationParkInput,
  escalationProposerStampFor,
  ESCALATION_PROPOSER_STAMPS,
  ESCALATION_RESUMABLE_KINDS,
  isEscalationResumableKind,
  type EscalationResumableKind,
} from "../escalation-park-store.js";
import { buildOpsRefundResumeState } from "../../ops/ops-resolver.js";
import { OPS_ROUTER } from "../../ops/__tests__/ops-e2e-harness.js";

const AT = "2026-07-04T12:00:00.000Z";
/** The staff member who PROPOSED the escalated intent (the stamped id). */
const PROPOSER = "owner_proposer";
/** A DIFFERENT owner, who may legitimately approve it. */
const APPROVER = "owner_approver";
/**
 * A session staffId that differs from {@link PROPOSER}, so arm 2 can tell the
 * registry-read stamp apart from `buildEscalationParkInput`'s session fallback.
 */
const OTHER_SESSION_STAFF = "session_only_staff";

/**
 * Per resumable kind, everything needed to drive its self-approve gate through
 * the REAL composed router: the canonical STAMPED payload the production write
 * side produces (at an amount/shape that lands in the ESCALATE band) and the
 * FRESH state the resume path re-projects.
 */
interface ActorStampFixture {
  /** The parked `actor.role` — `staffRoleGuard` re-runs on resume. */
  readonly actorRole: string;
  /** The envelope taint the production plane stamps for this kind. */
  readonly taint: IntentEnvelope["taint"];
  /**
   * The CANONICAL payload as the authenticated stamping site emits it —
   * including the proposer stamp under contract.
   */
  readonly stampedPayload: () => Record<string, unknown>;
  /** The FRESH state (built by the REAL production projector for this kind). */
  readonly resumeState: () => unknown;
}

const ACTOR_STAMP_FIXTURES: Readonly<
  Record<EscalationResumableKind, ActorStampFixture>
> = {
  "payment.refund.issue": {
    actorRole: "OWNER",
    taint: "UNTRUSTED",
    // Exactly the shape ops-resolver.ts `resolveRefundTarget` stamps
    // (STOP-GATE B): model controls amount + reason, everything else DB/Capsule.
    stampedPayload: () => ({
      paymentId: "pay_db_1",
      refundAmountCentavos: 150_000, // R$1500 > the R$1000 escalate threshold
      refundableBalanceCentavos: 500_000,
      amountInCentavos: 500_000,
      currentRefundedCentavos: 0,
      actor: "admin",
      actorId: PROPOSER, // ← the stamp under contract
    }),
    resumeState: () =>
      buildOpsRefundResumeState(
        {
          status: "paid",
          amountInCentavos: 500_000,
          refundedAmountCentavos: 0,
          method: "pix",
          version: 3,
          orderId: "order_4242",
        },
        "ibatexas",
      ),
  },
};

/** Build the envelope for `kind` from a (possibly mutated) payload. */
function envelopeFor(
  kind: string,
  fixture: ActorStampFixture,
  payload: Record<string, unknown>,
  sessionStaffId: string,
): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload,
    actor: {
      principal: "user",
      sessionId: `admin:${sessionStaffId}`,
      role: fixture.actorRole,
    },
    taint: fixture.taint,
    nonce: "bkl-113-actor-stamp",
    createdAt: AT,
  }) as IntentEnvelope;
}

/**
 * Stamp the `escalationApproval` marker onto the projected state — the same
 * STATE-side injection `createEscalationApprovalEngine` performs at resume (the
 * marker never rides the payload, so `intentHash` is unchanged).
 */
function withApprovalMarker(
  state: unknown,
  envelope: IntentEnvelope,
  approverId: string,
): unknown {
  const s = (state ?? {}) as { ctx?: Record<string, unknown> };
  return {
    ...s,
    ctx: {
      ...(s.ctx ?? {}),
      escalationApproval: {
        intentHash: envelope.intentHash,
        approverId,
        approverRole: "OWNER",
        at: AT,
      },
    },
  };
}

/** The declared resumable kinds, read from the RUNTIME set (not the type). */
const RESUMABLE_KINDS = [...ESCALATION_RESUMABLE_KINDS];

describe("BKL-113 — ESCALATION_RESUMABLE_KINDS proposer-stamp contract", () => {
  it("the resumable set is non-empty and EXACTLY the stamp registry's keys", () => {
    expect(RESUMABLE_KINDS.length).toBeGreaterThan(0);
    expect([...RESUMABLE_KINDS].sort()).toEqual(
      Object.keys(ESCALATION_PROPOSER_STAMPS).sort(),
    );
  });

  it("every resumable kind DECLARES a proposer stamp", () => {
    for (const kind of RESUMABLE_KINDS) {
      expect(
        escalationProposerStampFor(kind),
        `${kind} is in ESCALATION_RESUMABLE_KINDS but declares no proposer stamp — its self-approve gate would degrade to route+module checks only`,
      ).toBeDefined();
    }
  });

  it("every resumable kind has a BEHAVIOURAL fixture (a new kind must PROVE its stamp, not just declare it)", () => {
    for (const kind of RESUMABLE_KINDS) {
      expect(
        isEscalationResumableKind(kind) &&
          Object.hasOwn(ACTOR_STAMP_FIXTURES, kind),
        `${kind} has no ACTOR_STAMP_FIXTURES entry — add one so its self-approve gate is proven through the real policy router`,
      ).toBe(true);
    }
  });

  describe.each(RESUMABLE_KINDS)("resumable kind: %s", (kind) => {
    if (!isEscalationResumableKind(kind)) {
      // Covered by the completeness arms above; keeps this block type-safe.
      it("is a declared resumable kind", () => {
        expect(isEscalationResumableKind(kind)).toBe(true);
      });
      return;
    }
    const stamp = ESCALATION_PROPOSER_STAMPS[kind];
    const fixture = ACTOR_STAMP_FIXTURES[kind];

    it("1 — the canonical stamped payload carries the DECLARED proposer field", () => {
      const payload = fixture.stampedPayload();
      expect(
        Object.hasOwn(payload, stamp.payloadField),
        `${kind}: the canonical payload has no "${stamp.payloadField}" field (declared in ESCALATION_PROPOSER_STAMPS, stamped by ${stamp.stampedBy})`,
      ).toBe(true);
      expect(stamp.readProposerId(payload)).toBe(PROPOSER);
    });

    it("2 — buildEscalationParkInput derives proposerId from the STAMP, not the session fallback", () => {
      // The session staffId deliberately differs from the stamped proposer: a
      // park that fell back to the session would read OTHER_SESSION_STAFF.
      const envelope = envelopeFor(
        kind,
        fixture,
        fixture.stampedPayload(),
        OTHER_SESSION_STAFF,
      );
      const parked = buildEscalationParkInput(envelope);
      expect(parked.proposerId).toBe(PROPOSER);
      expect(parked.proposerId).not.toBe(OTHER_SESSION_STAFF);
    });

    it("3 — SELF-approval marker leaves the ESCALATE INTACT (the structural gate BITES)", () => {
      const envelope = envelopeFor(
        kind,
        fixture,
        fixture.stampedPayload(),
        PROPOSER,
      );
      const decision = adjudicate(
        envelope as never,
        withApprovalMarker(fixture.resumeState(), envelope, PROPOSER) as never,
        OPS_ROUTER as never,
      );
      expect(
        decision.kind,
        `${kind}: a self-approval marker CONVERTED the ESCALATE — the pack overlay's separation-of-duty gate did not read the stamped proposer`,
      ).toBe("ESCALATE");
    });

    it("4 — a DIFFERENT-owner marker converts to REQUEST_CONFIRMATION (the gate is not vacuously escalating)", () => {
      const envelope = envelopeFor(
        kind,
        fixture,
        fixture.stampedPayload(),
        PROPOSER,
      );
      const decision = adjudicate(
        envelope as never,
        withApprovalMarker(fixture.resumeState(), envelope, APPROVER) as never,
        OPS_ROUTER as never,
      );
      expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    });

    it("5 — NEGATIVE CONTROL: with the declared field STRIPPED, the same self-approval marker DOES convert (the degradation this contract prevents)", () => {
      const stripped = fixture.stampedPayload();
      delete stripped[stamp.payloadField];
      expect(stamp.readProposerId(stripped)).toBeNull();

      const envelope = envelopeFor(kind, fixture, stripped, PROPOSER);
      const decision = adjudicate(
        envelope as never,
        withApprovalMarker(fixture.resumeState(), envelope, PROPOSER) as never,
        OPS_ROUTER as never,
      );
      // Arm 3 held the ESCALATE with the SAME marker; only the stamp changed.
      // So arm 3's pass is CAUSED by the stamp — a kind that never stamps
      // "${stamp.payloadField}" ships with this weaker gate.
      expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    });
  });
});
