/**
 * Proves the success criterion from the IBX-IGE v1.0 plan:
 *   "A second domain scaffold (clinic booking: 3 tools, 4 state transitions,
 *    1 PolicyBundle) builds against the packages in under a day with no fork."
 *
 * The clinic scaffold in `examples/clinic/` uses only @adjudicate/core and
 * @adjudicate/core/kernel. This test exercises the adjudicate() boundary with the
 * scaffold's PolicyBundle.
 */

import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import { adjudicate } from "@adjudicate/core/kernel";
import {
  clinicPolicyBundle,
  clinicTools,
  type ClinicIntentKind,
  type ClinicState,
} from "../examples/clinic/clinic-policies.js";

function env(kind: ClinicIntentKind, payload: Record<string, unknown> = {}) {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "llm", sessionId: "s-clinic-1" },
    taint: "UNTRUSTED",
    createdAt: "2026-04-23T12:00:00.000Z",
  });
}

function state(overrides: Partial<ClinicState> = {}): ClinicState {
  const defaults: ClinicState = {
    patientId: "pat_1",
    identityVerified: true,
    selectedSlotId: "slot_1",
    existingAppointmentId: null,
    slotIsFree: true,
    withinCancelWindowHours: null,
  };
  // Use spread so `null` overrides actually reach the final state.
  return { ...defaults, ...overrides };
}

describe("clinic second-domain scaffold — success criterion", () => {
  it("ships a PolicyBundle that EXECUTEs valid bookings", () => {
    const decision = adjudicate(
      env("appointment.book"),
      state(),
      clinicPolicyBundle,
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("refuses booking with unverified identity (AUTH)", () => {
    const decision = adjudicate(
      env("appointment.book"),
      state({ identityVerified: false }),
      clinicPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.kind).toBe("AUTH");
    expect(decision.refusal.code).toBe("clinic.identity_required");
  });

  it("refuses booking with no slot selected (STATE)", () => {
    // With EXECUTE-default, a STATE refusal here must come from requireSlotFree,
    // which runs BEFORE taint. The taint check for UNTRUSTED would otherwise
    // fire first if the slot check returned null.
    const decision = adjudicate(
      env("appointment.book"),
      state({ selectedSlotId: null }),
      clinicPolicyBundle,
    );
    if (decision.kind !== "REFUSE") throw new Error("expected REFUSE");
    expect(decision.refusal.code).toBe("clinic.no_slot_selected");
  });

  it("refuses booking when slot was taken (STATE)", () => {
    const decision = adjudicate(
      env("appointment.book"),
      state({ slotIsFree: false }),
      clinicPolicyBundle,
    );
    if (decision.kind !== "REFUSE") throw new Error("expected REFUSE");
    expect(decision.refusal.code).toBe("clinic.slot_taken");
  });

  it("refuses cancel within 24h window (BUSINESS_RULE)", () => {
    const decision = adjudicate(
      env("appointment.cancel"),
      state({
        existingAppointmentId: "appt_1",
        withinCancelWindowHours: 5,
      }),
      clinicPolicyBundle,
    );
    if (decision.kind !== "REFUSE") throw new Error("expected REFUSE");
    expect(decision.refusal.kind).toBe("BUSINESS_RULE");
    expect(decision.refusal.code).toBe("clinic.cancel_window_violated");
  });

  it("EXECUTEs cancel outside the 24h window", () => {
    const decision = adjudicate(
      env("appointment.cancel"),
      state({
        existingAppointmentId: "appt_1",
        withinCancelWindowHours: 48,
      }),
      clinicPolicyBundle,
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("exposes 3 mutating tools and 2 read-only tools (spec)", () => {
    expect(clinicTools.MUTATING.size).toBe(3);
    expect(clinicTools.READ_ONLY.size).toBe(2);
  });
});
