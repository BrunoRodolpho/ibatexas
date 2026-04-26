/**
 * Vacation-approval — domain types.
 *
 * A small approvals workflow that exercises every Decision the kernel can
 * produce. Three intent kinds, one state shape, one taint policy. Real
 * adopters will obviously have more fields — this minimum is what's needed
 * for the policy bundle's guards to demonstrate the full lifecycle.
 */

import type { IntentEnvelope, TaintPolicy } from "@adjudicate/core";

export type VacationIntentKind =
  | "vacation.request" // employee proposes time off
  | "vacation.approve" // manager confirms a pending request
  | "vacation.cancel"; // employee or manager cancels an existing request

export interface VacationRequest {
  readonly id: string;
  readonly employeeId: string;
  /** ISO date `YYYY-MM-DD` for the first day of leave. */
  readonly startDate: string;
  readonly durationDays: number;
  readonly status: "pending" | "approved" | "denied" | "cancelled";
  /** Set on `approved` requests only. */
  readonly approvedBy: string | null;
}

export interface VacationState {
  readonly employee: {
    readonly id: string;
    readonly role: "employee" | "manager";
    /** PTO balance in whole days. */
    readonly ptoBalanceDays: number;
  };
  /** When non-null the intent operates on this existing request. */
  readonly request: VacationRequest | null;
  /**
   * Identity of the actor proposing an `approve` intent. `null` for
   * `request` and `cancel`. Set by the runtime/auth layer, not the LLM.
   */
  readonly approverId: string | null;
  /** Wall-clock "now" used by the cancel-window guard. ISO-8601. */
  readonly nowISO: string;
}

/** Domain-narrow envelope alias to keep test signatures readable. */
export type VacationEnvelope = IntentEnvelope<VacationIntentKind, unknown>;

/**
 * Centralized policy constants. A real org would source these from
 * config. Kept inline here so the example is self-contained.
 */
export const VACATION_POLICY = {
  /** Single contiguous request can't exceed this many days. Excess is REWRITTEN-clamped. */
  maxConsecutiveDays: 14,
  /** Cancellations within this window of `startDate` need REQUEST_CONFIRMATION. */
  cancelWindowHours: 24,
} as const;

/**
 * Taint requirements per intent kind. Approvals must originate from a
 * TRUSTED actor (a manager going through the workspace UI). Requests and
 * cancellations may originate from UNTRUSTED actors (the employee chat
 * channel) — the kernel's other guards police what they can do.
 */
export const vacationTaintPolicy: TaintPolicy = {
  minimumFor(kind) {
    return kind === "vacation.approve" ? "TRUSTED" : "UNTRUSTED";
  },
};
