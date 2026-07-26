// approved-inner-refund — BKL-103. The money reversal an OWNER-approved
// `order.cancel` implies, settled through the AUDITED kernel on the APPROVER's
// authority.
//
// THE PROBLEM. `executeOrderCancel`'s BKL-130 block, for a still-PAID order,
// ADJUDICATES a fresh system-actor `payment.refund.issue` — and at >=R$1.000 that
// refund's OWN escalate band ESCALATEs, so it throws
// `PaidCancelRefundNotSettledError` and the cancel never happens. An approved
// big-ticket cancel would fail at its last step, every time, for precisely the
// amounts BKL-103 exists to rescue.
//
// THE TWO WRONG FIXES, and why this module is neither:
//   - Re-running that inner adjudication unchanged ⇒ it ESCALATEs again (dead loop).
//   - Skipping straight to `writeAdjudicatedRefund` ⇒ real money moves with NO
//     kernel decision and NO audit row of its own. That is a bypass, not a gate.
//
// WHAT THIS DOES INSTEAD. It composes the refund side's OWN approved-execution
// path: build the inner refund envelope, project FRESH PaymentState, stamp the
// AUT-017 `escalationApproval` marker (the approver), and adjudicate through the
// COMPOSED router with a matching `confirmationReceipt`. The pack-payments escalate
// band sees the marker and converts its own ESCALATE → REQUEST_CONFIRMATION, which
// the receipt flips to EXECUTE carrying `refund_escalation_approved`. Only THEN is
// the post-decision write performed. Every centavo stays kernel-adjudicated and
// audited, under the approver's authority — no band is weakened, and the refund's
// >=R$1.000 owner requirement is SATISFIED (by a real OWNER approval) rather than
// side-stepped.
//
// SEPARATION OF DUTY, and why the proposer rides the payload. The pack overlay
// converts only when `approval.approverId !== payload.actorId`. So the ADJUDICATED
// payload carries the CANCEL'S PROPOSER (the customer) as `actorId`, and the marker
// carries the approving OWNER — a real inequality, and the honest description of who
// asked versus who authorized. The subsequent WRITE re-stamps the author as the
// APPROVER (Option 1 provenance), exactly as the approved-refund executor does for
// a parked staff refund: `executeRefund` forces `actor:"admin", actorId: approver`.
// Adjudicated-payload-proposer vs written-author-approver is therefore the SAME
// established shape, not a new divergence.
//
// The BKL-116 basis assertion is mirrored here: an EXECUTE reached through any band
// OTHER than the marker branch (e.g. a lowered threshold routing it through a
// confirm band with no owner gate) is REFUSED, so the unconditional receipt can
// never launder a non-approved conversion.

import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import type { PaymentRefundIssuePayload } from "@ibatexas/pack-payments";

/**
 * The `business` basis reason the pack-payments escalate-band marker branch emits.
 * Single-sourced with `escalation-approval.ts`'s
 * `REQUIRED_ESCALATION_APPROVAL_BASIS["payment.refund.issue"]` by meaning — an
 * EXECUTE lacking it did NOT pass the pack's OWNER + self-approve gate.
 */
export const REFUND_ESCALATION_APPROVED_BASIS = "refund_escalation_approved";

export interface ApprovedInnerRefundDeps {
  /**
   * Project the FRESH PaymentState for the payment (production:
   * `buildOpsRefundResumeState` over a LIVE read). A not-found / non-refundable
   * projection ⇒ the kernel REFUSEs, which this module surfaces as a throw.
   */
  readonly projectPaymentState: (paymentId: string) => Promise<unknown>;
  /**
   * The COMPOSED `payment.refund.issue` PolicyBundle — it MUST be the composed
   * router's bundle, because the AUT-017 marker overlay lives in
   * `@ibatexas/pack-payments`, NOT in the domain `paymentProjectionPolicyBundle`
   * that `issueRefundFromEnvelope` adjudicates against. Adjudicating against the
   * domain bundle would ESCALATE regardless of the marker.
   */
  readonly policyForRefund: () => unknown;
  /**
   * `adjudicateAndAudit`-shaped: emits the AuditRecord and rides the execution
   * ledger. The receipt is threaded so the marker-induced REQUEST_CONFIRMATION
   * becomes EXECUTE.
   */
  readonly adjudicate: (args: {
    readonly envelope: IntentEnvelope;
    readonly state: unknown;
    readonly policy: unknown;
    readonly receipt: {
      readonly intentHash: string;
      readonly at: string;
      readonly binding: {
        readonly approver: { readonly confirmed: string };
        readonly channel: { readonly confirmed: string };
      };
    };
  }) => Promise<Decision>;
  /**
   * POST-DECISION persistence + events (`executeRefund` → `writeAdjudicatedRefund`
   * + `payment.status_changed` + the refund event log). Runs ONLY after a verified
   * EXECUTE. Re-stamps the author as the approver.
   */
  readonly writeRefund: (
    payload: PaymentRefundIssuePayload,
    approverStaffId: string,
  ) => Promise<unknown>;
  readonly now: () => string;
  /** Confirmation-binding channel label (default "admin-dashboard"). */
  readonly channelLabel?: string;
}

export interface ApprovedInnerRefundArgs {
  readonly orderId: string;
  readonly paymentId: string;
  readonly amountInCentavos: number;
  readonly currentRefundedCentavos: number;
  /** The CANCEL's proposer (the customer) — the self-approve comparand. */
  readonly proposerId: string;
  readonly approver: { readonly id: string; readonly role: string };
  readonly reason: string;
}

export interface ApprovedInnerRefundResult {
  readonly settled: boolean;
  readonly refundAmountCentavos: number;
  readonly decision?: Decision;
  readonly intentHash?: string;
}

/**
 * The live payment row shape the inner-refund projector maps from.
 */
export interface InnerRefundPaymentRow {
  readonly status: string;
  readonly amountInCentavos: number;
  readonly refundedAmountCentavos?: number | null;
  readonly method: string;
  readonly version: number;
  readonly orderId?: string | null;
}

/**
 * Build the `projectPaymentState` dep from a live payment reader.
 *
 * Extracted out of the composition root deliberately: it is the mapping that decides
 * what the kernel SEES about the money, so it belongs somewhere a test can drive it.
 * A missing row projects `null` into `buildOpsRefundResumeState`, which yields a
 * `{ ctx: { exists: false } }` state ⇒ the kernel REFUSEs (fail-closed).
 */
export function createInnerRefundPaymentStateProjector(deps: {
  readonly getPayment: (paymentId: string) => Promise<InnerRefundPaymentRow | null>;
  readonly buildRefundState: (
    payment: {
      status: string;
      amountInCentavos: number;
      refundedAmountCentavos: number;
      method: string;
      version: number;
      orderId?: string | null;
    } | null,
    tenantId: string,
  ) => unknown;
  readonly tenantId: string;
}): (paymentId: string) => Promise<unknown> {
  return async (paymentId) => {
    const p = await deps.getPayment(paymentId);
    return deps.buildRefundState(
      p === null
        ? null
        : {
            status: p.status,
            amountInCentavos: p.amountInCentavos,
            // A null/absent refunded total means NOTHING refunded yet — never
            // silently treated as the full amount.
            refundedAmountCentavos: p.refundedAmountCentavos ?? 0,
            method: p.method,
            version: p.version,
            orderId: p.orderId ?? null,
          },
      deps.tenantId,
    );
  };
}

/**
 * Resolve the COMPOSED refund PolicyBundle, failing LOUDLY when no installed pack
 * owns the kind — an unowned kind would otherwise adjudicate against `undefined` and
 * the failure would surface far from its cause.
 */
export function createRefundPolicyResolver(
  policyForKind: (kind: string) => unknown | null,
): () => unknown {
  return () => {
    const policy = policyForKind("payment.refund.issue");
    if (policy === null || policy === undefined) {
      throw new Error(
        'escalation approval: no installed pack owns kind "payment.refund.issue"',
      );
    }
    return policy;
  };
}

/** TRUE iff the decision carries the escalate-band marker branch's OWN basis. */
export function refundExecuteReachedViaMarker(decision: Decision): boolean {
  return decision.basis.some(
    (b) =>
      b.category === "business" &&
      (b.detail as { reason?: string } | undefined)?.reason ===
        REFUND_ESCALATION_APPROVED_BASIS,
  );
}

/**
 * Settle the approved cancel's implied refund. Throws on ANY non-settlement — the
 * escalation engine turns a throw into `execute_failed`, and the caller must NOT
 * proceed to cancel the order (no-half-apply: no reversed money ⇒ no cancel).
 *
 * Returns `settled: false` ONLY when there is genuinely nothing to refund (a fully
 * refunded balance), which is not a failure.
 */
export async function settleApprovedInnerRefund(
  deps: ApprovedInnerRefundDeps,
  args: ApprovedInnerRefundArgs,
): Promise<ApprovedInnerRefundResult> {
  const refundable = args.amountInCentavos - args.currentRefundedCentavos;
  if (refundable <= 0) {
    return { settled: false, refundAmountCentavos: 0 };
  }

  const payload: PaymentRefundIssuePayload = {
    paymentId: args.paymentId,
    refundAmountCentavos: refundable,
    refundableBalanceCentavos: refundable,
    amountInCentavos: args.amountInCentavos,
    currentRefundedCentavos: args.currentRefundedCentavos,
    // SYSTEM issues it on the customer's behalf; `actorId` is the CANCEL's
    // proposer, which is what the pack overlay compares the approver against.
    actor: "system",
    actorId: args.proposerId,
    reason: args.reason,
  } as PaymentRefundIssuePayload;

  // Deterministic nonce (orderId:paymentId-scoped) ⇒ a retried approval hashes
  // identically and the always-on execution ledger REPLAY_SUPPRESSES the duplicate
  // instead of double-refunding.
  const envelope = buildSystemEnvelope<
    "payment.refund.issue",
    PaymentRefundIssuePayload
  >({
    kind: "payment.refund.issue",
    payload,
    sourceSubject: "order.cancel.refund",
    eventId: `${args.orderId}:${args.paymentId}:cancel-refund-approved`,
  }) as IntentEnvelope;

  const at = deps.now();
  const baseState = (await deps.projectPaymentState(args.paymentId)) ?? {};
  const s = baseState as { ctx?: Record<string, unknown> };
  const state = {
    ...s,
    ctx: {
      ...(s.ctx ?? {}),
      // The AUT-017 marker rides STATE, never the payload ⇒ intentHash unchanged
      // and unforgeable from the wire.
      escalationApproval: {
        intentHash: envelope.intentHash,
        approverId: args.approver.id,
        approverRole: args.approver.role,
        at,
      },
    },
  };

  const decision = await deps.adjudicate({
    envelope,
    state,
    policy: deps.policyForRefund(),
    receipt: {
      intentHash: envelope.intentHash,
      at,
      binding: {
        approver: { confirmed: `staff:${args.approver.id}` },
        channel: { confirmed: deps.channelLabel ?? "admin-dashboard" },
      },
    },
  });

  if (decision.kind !== "EXECUTE") {
    throw new Error(
      `approved cancel: the implied refund did NOT settle (kernel decision: ${decision.kind}) — order NOT cancelled`,
    );
  }
  // BKL-116 parity: the receipt is unconditional, so require the EXECUTE to carry
  // the marker branch's OWN basis. Any other band means the pack's OWNER +
  // separation-of-duty gate never ran.
  if (!refundExecuteReachedViaMarker(decision)) {
    throw new Error(
      "approved cancel: the implied refund EXECUTEd WITHOUT the escalation-approval basis (threshold drift?) — refusing to move money",
    );
  }

  await deps.writeRefund(payload, args.approver.id);
  return {
    settled: true,
    refundAmountCentavos: refundable,
    decision,
    intentHash: envelope.intentHash,
  };
}
