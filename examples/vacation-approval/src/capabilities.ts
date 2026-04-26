/**
 * Vacation-approval — CapabilityPlanner.
 *
 * Decides which tools the LLM may see in each role. The planner is the
 * security boundary that hides MUTATING tools from the model so the
 * model literally cannot propose them.
 *
 * Two roles, two tool tiers:
 *   employee — read-only catalog + propose `vacation.request` / `vacation.cancel`
 *   manager  — same as employee + propose `vacation.approve`
 */

import type { CapabilityPlanner, Plan } from "@adjudicate/core/llm";
import { type ToolClassification } from "@adjudicate/core/llm";
import type { VacationState } from "./types.js";

/**
 * Type-level partition. The framework's `filterReadOnly` uses this to
 * structurally drop MUTATING tools from the LLM's serialized tool list.
 */
export const VACATION_TOOLS: ToolClassification = {
  READ_ONLY: new Set([
    "list_my_requests",
    "check_pto_balance",
    "list_team_requests",
  ]),
  MUTATING: new Set([
    "request_vacation",
    "approve_vacation",
    "cancel_vacation",
  ]),
};

/**
 * Planner: produces a `Plan` for the current state. Adopters that want a
 * static plan per role can build it once at boot. Domains with richer
 * state (org charts, calendars, blackout dates) compute it per-turn.
 */
export const vacationCapabilityPlanner: CapabilityPlanner<VacationState> = {
  plan(state): Plan {
    const isManager = state.employee.role === "manager";

    return {
      visibleReadTools: isManager
        ? ["list_my_requests", "check_pto_balance", "list_team_requests"]
        : ["list_my_requests", "check_pto_balance"],
      allowedIntents: isManager
        ? ["vacation.request", "vacation.approve", "vacation.cancel"]
        : ["vacation.request", "vacation.cancel"],
      forbiddenConcepts: [
        // Concepts the LLM must NOT emit in any state — caught by the
        // forbidden-phrase scan in the validation layer before the
        // response reaches the user.
        "approved automatically",
        "skip approval",
      ],
    };
  },
};
