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
// the REAL composed production policy router for ITS OWN PLANE — `OPS_ROUTER` for
// the staff refund, `CUSTOMER_ROUTER` for the BKL-103 customer cancel (each is the
// exact bundle that plane's conductor SUBMIT stage and the escalation-approval
// engine's `policyFor` adjudicate against) — proving for EACH kind that:
//
//   1. the canonical stamped payload carries the DECLARED proposer field;
//   2. `buildEscalationParkInput` derives `proposerId` from that stamp and NOT
//      from the session fallback;
//   3. a SELF-approval marker (approver === the stamped proposer) leaves the
//      ESCALATE INTACT — the gate BITES;
//   4. a DIFFERENT-owner marker converts to REQUEST_CONFIRMATION — the gate is
//      not vacuously escalating;
//   5. NEGATIVE CONTROL — with the declared field STRIPPED from the payload, the
//      same self-approval marker hits the kind's DECLARED unstamped posture
//      (`ActorStampFixture.unstampedDecision`). The refund overlay DEGRADES
//      (converts — the exact hazard this contract exists to prevent, pinned so it
//      stays reproducible); BKL-103's cancel overlay FAILS CLOSED (stays ESCALATE,
//      because it requires a non-empty comparand before converting).
//
// Arm 3's non-vacuity comes from the arm-3-vs-arm-4 DIFFERENTIAL — identical state
// and payload, only the marker's `approverId` changes ⇒ ESCALATE vs
// REQUEST_CONFIRMATION — which holds for BOTH postures.
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
// BKL-103 — the customer plane's composed router + the REAL ctx projectors the
// customer resume branch uses (`resolveAndAssemble` → identityCtx + buildOrderCtx).
import { CUSTOMER_ROUTER } from "../../__tests__/customer-e2e-harness.js";
import {
  buildOrderCtx,
  identityCtx,
} from "../../claustrum/resolve-and-assemble.js";

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
/** The order a parked `order.cancel` fixture targets. */
const CANCEL_ORDER_ID = "order_bkl103";

/**
 * Per resumable kind, everything needed to drive its self-approve gate through
 * the REAL composed router: the canonical STAMPED payload the production write
 * side produces (at an amount/shape that lands in the ESCALATE band) and the
 * FRESH state the resume path re-projects.
 */
interface ActorStampFixture {
  /**
   * The envelope ACTOR the kind's production plane stamps, given the session
   * identity to embed. BKL-103 — this became per-kind because the resumable set
   * now spans BOTH planes: `payment.refund.issue` is proposed by STAFF
   * (`{ principal: "user", sessionId: "admin:<staffId>", role: "OWNER" }`, which
   * arms `staffRoleGuard`), while `order.cancel` is proposed by a CUSTOMER
   * (`{ principal: "llm", sessionId: <conversationId> }` — the customer-plane
   * planner's `plannerEnvelopeActor`, which stamps NO role). Driving a cancel
   * under an `admin:` actor would REFUSE `kind_not_in_staff_matrix` (order.cancel
   * is a BKL-096 no-plane-ever forbidden OPS verb) and prove nothing about the
   * overlay.
   */
  readonly actorFor: (sessionIdentity: string) => IntentEnvelope["actor"];
  /**
   * The COMPOSED production router this kind is adjudicated against — the exact
   * bundle its plane's conductor SUBMIT stage and the escalation-approval
   * engine's `policyFor` use. Ops kinds ⇒ `OPS_ROUTER`; customer kinds ⇒
   * `CUSTOMER_ROUTER`.
   */
  readonly router: unknown;
  /** The envelope taint the production plane stamps for this kind. */
  readonly taint: IntentEnvelope["taint"];
  /**
   * The CANONICAL payload as the authenticated stamping site emits it —
   * including the proposer stamp under contract.
   */
  readonly stampedPayload: () => Record<string, unknown>;
  /** The FRESH state (built by the REAL production projector for this kind). */
  readonly resumeState: () => unknown;
  /**
   * The approver ROLE whose marker legitimately converts this kind's ESCALATE.
   * Both members require `"OWNER"` today (each pack overlay hard-gates on it).
   */
  readonly approverRole: string;
  /**
   * Arm 5's expected verdict when the declared proposer field is STRIPPED from
   * the payload and the SAME self-approval marker is applied. The two members
   * differ HONESTLY, and the difference is the point:
   *
   *   - `"REQUEST_CONFIRMATION"` — the overlay DEGRADES. `@ibatexas/pack-payments`
   *     compares a bare `approval.approverId !== payload.actorId`, so an absent
   *     comparand makes the comparison trivially true and a self-approval
   *     converts. This is EXACTLY the silent degradation BKL-113 exists to
   *     prevent, and pinning it here keeps the hazard reproducible: the refund is
   *     safe because the write side genuinely stamps, not because the overlay
   *     is defensive.
   *   - `"ESCALATE"` — the overlay FAILS CLOSED. BKL-103's `gatePaidCancel`
   *     overlay (`@ibatexas/pack-orders`) additionally requires the comparand to
   *     be a NON-EMPTY string before any conversion, so an unstamped cancel can
   *     never convert; a missing stamp leaves the escalation escalated.
   *
   * Either way arm 5 is a NEGATIVE CONTROL over the same marker. Arm 3's
   * non-vacuity is established by the arm-3-vs-arm-4 DIFFERENTIAL (identical
   * state and payload; only the approver id changes ⇒ ESCALATE vs
   * REQUEST_CONFIRMATION), which holds for both postures — see the arm 4 doc.
   */
  readonly unstampedDecision: "REQUEST_CONFIRMATION" | "ESCALATE";
}

const ACTOR_STAMP_FIXTURES: Readonly<
  Record<EscalationResumableKind, ActorStampFixture>
> = {
  "payment.refund.issue": {
    actorFor: (sessionIdentity) => ({
      principal: "user",
      sessionId: `admin:${sessionIdentity}`,
      role: "OWNER",
    }),
    router: OPS_ROUTER,
    approverRole: "OWNER",
    // The refund overlay's bare inequality DEGRADES when unstamped (the hazard).
    unstampedDecision: "REQUEST_CONFIRMATION",
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
  // BKL-103 — the >=R$1.000 PAID customer cancel. The proposer is the CUSTOMER
  // (stamped onto `payload.actorId` by routes/order-actions.ts and by the
  // conversational resolver), so `PROPOSER` here plays a customer id and the
  // approver is an OWNER on the ops plane. The FRESH state is built by the REAL
  // production projectors (`identityCtx` + `buildOrderCtx`) — the same pair
  // `resolveAndAssemble` composes on the customer resume branch — rather than a
  // hand-authored ctx literal, so a projector change cannot silently drift past
  // this proof.
  "order.cancel": {
    actorFor: (sessionIdentity) => ({
      principal: "llm",
      sessionId: sessionIdentity,
    }),
    router: CUSTOMER_ROUTER,
    approverRole: "OWNER",
    // BKL-103's overlay requires a non-empty comparand ⇒ FAILS CLOSED unstamped.
    unstampedDecision: "ESCALATE",
    taint: "UNTRUSTED",
    stampedPayload: () => ({
      orderId: CANCEL_ORDER_ID,
      reason: "mudei de ideia",
      actorId: PROPOSER, // ← the stamp under contract
    }),
    resumeState: () => ({
      ctx: buildOrderCtx(identityCtx(PROPOSER, "web"), CANCEL_ORDER_ID, {
        // R$1.500 > the R$1.000 escalate threshold, and `paid` is in
        // CANCEL_REFUND_IMPLYING_PAYMENT_STATUSES ⇒ `gatePaidCancel`'s HIGH band.
        totalInCentavos: 150_000,
        paymentStatus: "paid",
        paymentMethod: "pix",
        // Pre-PONR, so the fulfillment-state guards do not pre-empt the money band.
        fulfillmentStatus: "confirmed",
      } as never),
    }),
  },
};

/** Build the envelope for `kind` from a (possibly mutated) payload. */
function envelopeFor(
  kind: string,
  fixture: ActorStampFixture,
  payload: Record<string, unknown>,
  sessionIdentity: string,
): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload,
    actor: fixture.actorFor(sessionIdentity),
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
  approverRole: string,
): unknown {
  const s = (state ?? {}) as { ctx?: Record<string, unknown> };
  return {
    ...s,
    ctx: {
      ...(s.ctx ?? {}),
      escalationApproval: {
        intentHash: envelope.intentHash,
        approverId,
        approverRole,
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
        withApprovalMarker(
          fixture.resumeState(),
          envelope,
          PROPOSER,
          fixture.approverRole,
        ) as never,
        fixture.router as never,
      );
      expect(
        decision.kind,
        `${kind}: a self-approval marker CONVERTED the ESCALATE — the pack overlay's separation-of-duty gate did not read the stamped proposer`,
      ).toBe("ESCALATE");
    });

    // THE NON-VACUITY DIFFERENTIAL for arm 3: this arm is byte-identical to arm 3
    // except for the marker's `approverId`. Arm 3 ⇒ ESCALATE, arm 4 ⇒
    // REQUEST_CONFIRMATION, so the verdict provably turns on the
    // approver-vs-stamped-proposer comparison and nothing else. This holds for
    // BOTH unstamped postures, so it — not arm 5 — is what makes arm 3 non-vacuous
    // for a fail-closed overlay.
    it("4 — a DIFFERENT-owner marker converts to REQUEST_CONFIRMATION (the gate is not vacuously escalating)", () => {
      const envelope = envelopeFor(
        kind,
        fixture,
        fixture.stampedPayload(),
        PROPOSER,
      );
      const decision = adjudicate(
        envelope as never,
        withApprovalMarker(
          fixture.resumeState(),
          envelope,
          APPROVER,
          fixture.approverRole,
        ) as never,
        fixture.router as never,
      );
      expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    });

    it("5 — NEGATIVE CONTROL: with the declared field STRIPPED, the same self-approval marker hits the kind's DECLARED unstamped posture (degrade vs fail-closed)", () => {
      const stripped = fixture.stampedPayload();
      delete stripped[stamp.payloadField];
      expect(stamp.readProposerId(stripped)).toBeNull();

      const envelope = envelopeFor(kind, fixture, stripped, PROPOSER);
      const decision = adjudicate(
        envelope as never,
        withApprovalMarker(
          fixture.resumeState(),
          envelope,
          PROPOSER,
          fixture.approverRole,
        ) as never,
        fixture.router as never,
      );
      // Arm 3 held the ESCALATE with the SAME marker; only the stamp changed.
      // A "REQUEST_CONFIRMATION" here means the overlay degrades without the
      // stamp (so arm 3's pass is CAUSED by the stamp, and a kind that never
      // stamps "${stamp.payloadField}" would ship that weaker gate); an
      // "ESCALATE" means the overlay refuses to convert on an absent comparand
      // at all. See `ActorStampFixture.unstampedDecision`.
      expect(
        decision.kind,
        `${kind}: unstamped payload produced ${decision.kind}, but the fixture declares "${fixture.unstampedDecision}" — the overlay's unstamped posture changed`,
      ).toBe(fixture.unstampedDecision);
    });
  });
});
