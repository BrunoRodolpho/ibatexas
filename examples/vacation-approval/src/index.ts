// @example/vacation-approval — neutral hello-world for the @adjudicate framework.
//
// Demonstrates every Decision the kernel can produce
// (EXECUTE / REFUSE / ESCALATE / REQUEST_CONFIRMATION / DEFER / REWRITE)
// using a small approvals workflow as the domain.

export {
  VACATION_POLICY,
  vacationTaintPolicy,
  type VacationEnvelope,
  type VacationIntentKind,
  type VacationRequest,
  type VacationState,
} from "./types.js";

export { vacationPolicyBundle } from "./policies.js";

export {
  vacationCapabilityPlanner,
  VACATION_TOOLS,
} from "./capabilities.js";
