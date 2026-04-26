/**
 * One assertion per Decision the kernel can produce. If any of these
 * regress, the example has stopped demonstrating what the README claims.
 */

import { describe, expect, it } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope } from "@adjudicate/core";
import {
  vacationPolicyBundle,
  type VacationIntentKind,
  type VacationState,
} from "../src/index.js";

const DET_TIME = "2026-04-23T12:00:00.000Z";

function envelope(
  kind: VacationIntentKind,
  payload: Record<string, unknown>,
  taint: "SYSTEM" | "TRUSTED" | "UNTRUSTED" = "UNTRUSTED",
) {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "llm", sessionId: "s-1" },
    taint,
    createdAt: DET_TIME,
  });
}

function state(overrides: Partial<VacationState> = {}): VacationState {
  return {
    employee: {
      id: "emp_1",
      role: "employee",
      ptoBalanceDays: 10,
      ...(overrides.employee ?? {}),
    },
    request: overrides.request ?? null,
    approverId: overrides.approverId ?? null,
    nowISO: overrides.nowISO ?? DET_TIME,
  };
}

describe("vacation-approval — all six Decision outcomes", () => {
  it("EXECUTE — manager self-files within balance and policy max", () => {
    const decision = adjudicate(
      envelope("vacation.request", { startDate: "2026-05-01", durationDays: 3 }),
      state({ employee: { id: "mgr_1", role: "manager", ptoBalanceDays: 20 } }),
      vacationPolicyBundle,
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("REFUSE — request exceeds employee's PTO balance", () => {
    const decision = adjudicate(
      envelope("vacation.request", { startDate: "2026-05-01", durationDays: 12 }),
      state({ employee: { id: "emp_1", role: "manager", ptoBalanceDays: 5 } }),
      vacationPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.kind).toBe("BUSINESS_RULE");
    expect(decision.refusal.code).toBe("pto.insufficient_balance");
  });

  it("ESCALATE — manager attempts to approve their own request", () => {
    const decision = adjudicate(
      envelope("vacation.approve", { requestId: "req_1" }, "TRUSTED"),
      state({
        approverId: "mgr_1",
        request: {
          id: "req_1",
          employeeId: "mgr_1", // self-approval
          startDate: "2026-05-01",
          durationDays: 3,
          status: "pending",
          approvedBy: null,
        },
      }),
      vacationPolicyBundle,
    );
    expect(decision.kind).toBe("ESCALATE");
    if (decision.kind !== "ESCALATE") return;
    expect(decision.to).toBe("supervisor");
  });

  it("REQUEST_CONFIRMATION — cancel less than 24h before start", () => {
    const decision = adjudicate(
      envelope("vacation.cancel", { requestId: "req_1" }),
      state({
        // "now" is 2026-04-23T12:00; request starts the next morning
        nowISO: "2026-04-23T12:00:00.000Z",
        request: {
          id: "req_1",
          employeeId: "emp_1",
          startDate: "2026-04-24T08:00:00.000Z",
          durationDays: 2,
          status: "approved",
          approvedBy: "mgr_1",
        },
      }),
      vacationPolicyBundle,
    );
    expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    if (decision.kind !== "REQUEST_CONFIRMATION") return;
    expect(decision.prompt).toMatch(/Confirm cancellation/);
  });

  it("DEFER — employee request parks awaiting manager.approval signal", () => {
    const decision = adjudicate(
      envelope("vacation.request", { startDate: "2026-05-01", durationDays: 3 }),
      state(), // default employee with 10 days balance
      vacationPolicyBundle,
    );
    expect(decision.kind).toBe("DEFER");
    if (decision.kind !== "DEFER") return;
    expect(decision.signal).toBe("manager.approval");
    expect(decision.timeoutMs).toBe(24 * 60 * 60 * 1000);
  });

  it("REWRITE — duration of 30 days is clamped to policy max of 14", () => {
    const decision = adjudicate(
      envelope("vacation.request", { startDate: "2026-05-01", durationDays: 30 }),
      state({
        employee: { id: "mgr_1", role: "manager", ptoBalanceDays: 30 },
      }),
      vacationPolicyBundle,
    );
    expect(decision.kind).toBe("REWRITE");
    if (decision.kind !== "REWRITE") return;
    const rewrittenPayload = decision.rewritten.payload as {
      durationDays: number;
    };
    expect(rewrittenPayload.durationDays).toBe(14);
  });
});
