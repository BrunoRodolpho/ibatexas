/**
 * Clinic booking — a second-domain scaffold against the IBX-IGE framework.
 *
 * Success criterion from the plan: "A second domain scaffold (clinic booking:
 * 3 tools, 4 state transitions, 1 PolicyBundle) builds against the packages
 * in under a day with no fork."
 *
 * Every piece below is clinic-specific. None of `@adjudicate/core`,
 * `@adjudicate/core/kernel`, `@adjudicate/audit`, or `@adjudicate/core/llm` was forked
 * or patched to make this work.
 */

import {
  basis,
  BASIS_CODES,
  decisionRefuse,
  refuse,
  type IntentEnvelope,
  type TaintPolicy,
} from "@adjudicate/core";
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel";

// ── Clinic domain types ───────────────────────────────────────────────────────

export type ClinicIntentKind =
  | "appointment.book"     // propose a booking
  | "appointment.cancel"   // cancel an existing booking
  | "appointment.reschedule";

export interface ClinicState {
  readonly patientId: string | null;
  readonly identityVerified: boolean;
  readonly selectedSlotId: string | null;
  readonly existingAppointmentId: string | null;
  readonly slotIsFree: boolean;
  readonly withinCancelWindowHours: number | null;
}

// ── Clinic taint policy ───────────────────────────────────────────────────────

const CLINIC_TAINT_MIN: Record<ClinicIntentKind, "SYSTEM" | "TRUSTED" | "UNTRUSTED"> = {
  "appointment.book": "UNTRUSTED",       // patient proposal — kernel validates legality
  "appointment.cancel": "UNTRUSTED",
  "appointment.reschedule": "UNTRUSTED",
};

export const clinicTaintPolicy: TaintPolicy = {
  minimumFor(kind) {
    return CLINIC_TAINT_MIN[kind as ClinicIntentKind] ?? "UNTRUSTED";
  },
};

// ── Guards (pure functions: envelope + state → Decision | null) ───────────────

const requireIdentity: Guard<ClinicIntentKind, unknown, ClinicState> = (
  _envelope,
  state,
) => {
  if (state.identityVerified) return null;
  return decisionRefuse(
    refuse("AUTH", "clinic.identity_required", "Precisamos confirmar sua identidade antes de agendar."),
    [basis("auth", BASIS_CODES.auth.IDENTITY_MISSING)],
  );
};

const requireSlotFree: Guard<ClinicIntentKind, unknown, ClinicState> = (
  envelope,
  state,
) => {
  if (envelope.kind !== "appointment.book" && envelope.kind !== "appointment.reschedule") {
    return null;
  }
  if (state.selectedSlotId === null) {
    return decisionRefuse(
      refuse("STATE", "clinic.no_slot_selected", "Escolha um horário antes de confirmar."),
      [basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, { reason: "no_slot" })],
    );
  }
  if (!state.slotIsFree) {
    return decisionRefuse(
      refuse("STATE", "clinic.slot_taken", "Esse horário acabou de ser reservado. Quer ver outros?"),
      [basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, { reason: "slot_taken" })],
    );
  }
  return null;
};

const require24hCancelWindow: Guard<ClinicIntentKind, unknown, ClinicState> = (
  envelope,
  state,
) => {
  if (envelope.kind !== "appointment.cancel") return null;
  if (state.existingAppointmentId === null) {
    return decisionRefuse(
      refuse("STATE", "clinic.no_appointment", "Não encontrei um agendamento em aberto pra você."),
      [basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, { reason: "no_appointment" })],
    );
  }
  if (state.withinCancelWindowHours !== null && state.withinCancelWindowHours < 24) {
    return decisionRefuse(
      refuse(
        "BUSINESS_RULE",
        "clinic.cancel_window_violated",
        "Cancelamentos precisam ser feitos com pelo menos 24h de antecedência.",
      ),
      [basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        hoursUntilAppointment: state.withinCancelWindowHours,
      })],
    );
  }
  return null;
};

// ── PolicyBundle ──────────────────────────────────────────────────────────────

/**
 * `default: "EXECUTE"` — OPA-style "allow unless explicitly denied."
 * Pair with tight taint policy and exhaustive guards so "no opinion" means
 * "already validated by the earlier layers." Adopters that prefer fail-safe
 * (`default: "REFUSE"`) add a terminal business guard that EXECUTEs after
 * validation instead.
 */
export const clinicPolicyBundle: PolicyBundle<ClinicIntentKind, unknown, ClinicState> = {
  stateGuards: [requireSlotFree, require24hCancelWindow],
  authGuards: [requireIdentity],
  taint: clinicTaintPolicy,
  business: [],
  default: "EXECUTE",
};

// ── Minimal tool set (demonstration — the framework doesn't execute these) ────

export const clinicTools = {
  READ_ONLY: new Set(["list_services", "find_slot"]) as ReadonlySet<string>,
  MUTATING: new Set([
    "book_appointment",
    "cancel_appointment",
    "reschedule_appointment",
  ]) as ReadonlySet<string>,
} as const;

// ── Intent envelope builder (domain-typed) ────────────────────────────────────

export type ClinicEnvelope = IntentEnvelope<ClinicIntentKind, unknown>;
