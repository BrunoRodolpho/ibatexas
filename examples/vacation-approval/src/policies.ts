/**
 * Vacation-approval — PolicyBundle covering all six Decision outcomes.
 *
 * Each guard targets one path the kernel can take:
 *
 *   clampDuration            -> REWRITE              (durationDays > policy max)
 *   cancelWindowConfirmation -> REQUEST_CONFIRMATION (cancel within 24h of start)
 *   requestRequired          -> REFUSE   (STATE)     (approve/cancel with no request)
 *   noSelfApproval           -> ESCALATE             (manager approving themselves)
 *   sufficientBalance        -> REFUSE   (BUSINESS)  (request exceeds PTO balance)
 *   deferIfNeedsApproval     -> DEFER                (employee request awaits manager)
 *
 * When every guard returns null on a `vacation.request` from a manager, the
 * default branch fires and the kernel returns EXECUTE.
 *
 * Guards run in the kernel-fixed order: state -> auth -> taint -> business.
 */

import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionDefer,
  decisionEscalate,
  decisionRefuse,
  decisionRequestConfirmation,
  decisionRewrite,
  refuse,
} from "@adjudicate/core";
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel";
import {
  VACATION_POLICY,
  vacationTaintPolicy,
  type VacationIntentKind,
  type VacationState,
} from "./types.js";

type VacationGuard = Guard<VacationIntentKind, unknown, VacationState>;

// ── State guards ────────────────────────────────────────────────────────────

/**
 * Approve and cancel intents need an existing request to act on. Producing
 * a STATE refusal here is friendlier than letting the missing reference
 * blow up downstream.
 */
const requestRequired: VacationGuard = (envelope, state) => {
  if (envelope.kind === "vacation.request") return null;
  if (state.request) return null;
  return decisionRefuse(
    refuse(
      "STATE",
      "vacation.request_not_found",
      "No matching vacation request was found.",
    ),
    [
      basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, {
        reason: "no_request",
      }),
    ],
  );
};

/**
 * Requests beyond `maxConsecutiveDays` get clamped via REWRITE rather
 * than refused outright. The user gets shorter leave with a clear basis,
 * not a dead end.
 */
const clampDuration: VacationGuard = (envelope) => {
  if (envelope.kind !== "vacation.request") return null;
  const payload = envelope.payload as {
    readonly startDate: string;
    readonly durationDays: number;
  };
  if (payload.durationDays <= VACATION_POLICY.maxConsecutiveDays) return null;
  const rewritten = buildEnvelope({
    kind: envelope.kind,
    payload: { ...payload, durationDays: VACATION_POLICY.maxConsecutiveDays },
    actor: envelope.actor,
    taint: envelope.taint,
    createdAt: envelope.createdAt,
  });
  return decisionRewrite(
    rewritten,
    `Duration clamped to policy maximum of ${VACATION_POLICY.maxConsecutiveDays} days.`,
    [
      basis("business", BASIS_CODES.business.QUANTITY_CAPPED, {
        requested: payload.durationDays,
        cappedTo: VACATION_POLICY.maxConsecutiveDays,
      }),
    ],
  );
};

/**
 * Cancellations less than 24h before start need explicit user confirmation.
 * The kernel does not auto-cancel imminent leave.
 */
const cancelWindowConfirmation: VacationGuard = (envelope, state) => {
  if (envelope.kind !== "vacation.cancel") return null;
  if (!state.request) return null;
  const now = new Date(state.nowISO).getTime();
  const start = new Date(state.request.startDate).getTime();
  const hoursUntilStart = (start - now) / (60 * 60 * 1000);
  if (hoursUntilStart >= VACATION_POLICY.cancelWindowHours) return null;
  return decisionRequestConfirmation(
    `Your leave starts in ${Math.round(hoursUntilStart)}h. Confirm cancellation?`,
    [
      basis("state", BASIS_CODES.state.TRANSITION_VALID, {
        hoursUntilStart: Math.round(hoursUntilStart),
      }),
    ],
  );
};

// ── Auth guards ─────────────────────────────────────────────────────────────

/**
 * Self-approval is structurally forbidden. We escalate to a supervisor
 * rather than refuse because a separate human decision is the appropriate
 * remedy — refusing here would silently lose the request.
 */
const noSelfApproval: VacationGuard = (envelope, state) => {
  if (envelope.kind !== "vacation.approve") return null;
  if (!state.request || !state.approverId) return null;
  if (state.approverId !== state.request.employeeId) return null;
  return decisionEscalate(
    "supervisor",
    "Self-approval not permitted; routing to a supervisor for review.",
    [
      basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, {
        actor: state.approverId,
        targetEmployee: state.request.employeeId,
      }),
    ],
  );
};

// ── Business guards ─────────────────────────────────────────────────────────

/**
 * Refuse new requests that exceed the employee's PTO balance. A
 * BUSINESS_RULE refusal lets the UI explain the math; a SECURITY refusal
 * would be misleading here.
 */
const sufficientBalance: VacationGuard = (envelope, state) => {
  if (envelope.kind !== "vacation.request") return null;
  const payload = envelope.payload as { readonly durationDays: number };
  if (payload.durationDays <= state.employee.ptoBalanceDays) return null;
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "pto.insufficient_balance",
      "You don't have enough PTO balance for that request.",
      `requested=${payload.durationDays}, balance=${state.employee.ptoBalanceDays}`,
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        requested: payload.durationDays,
        balance: state.employee.ptoBalanceDays,
      }),
    ],
  );
};

/**
 * Employee-submitted requests are DEFERRED on a `manager.approval`
 * signal. The kernel persists the parked envelope; a manager's later
 * approval flows back through `resumeDeferredIntent` (see
 * @adjudicate/runtime).
 *
 * Manager-submitted requests skip this guard — they self-file and run
 * straight to the EXECUTE default.
 */
const deferIfNeedsApproval: VacationGuard = (envelope, state) => {
  if (envelope.kind !== "vacation.request") return null;
  if (state.employee.role === "manager") return null;
  return decisionDefer(
    "manager.approval",
    24 * 60 * 60 * 1000,
    [
      basis("state", BASIS_CODES.state.TRANSITION_VALID, {
        reason: "manager_approval_pending",
        employeeId: state.employee.id,
      }),
    ],
  );
};

// ── PolicyBundle ────────────────────────────────────────────────────────────

export const vacationPolicyBundle: PolicyBundle<
  VacationIntentKind,
  unknown,
  VacationState
> = {
  stateGuards: [requestRequired, clampDuration, cancelWindowConfirmation],
  authGuards: [noSelfApproval],
  taint: vacationTaintPolicy,
  business: [sufficientBalance, deferIfNeedsApproval],
  /**
   * Default to EXECUTE: when every guard above returns null the action is
   * legal and authorized. Pair with REFUSE-by-construction defaults if you
   * prefer the inverse safety polarity — see `@adjudicate/core/README.md`.
   */
  default: "EXECUTE",
};
