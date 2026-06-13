/**
 * @ibatexas/agents — AgentDefinition manifest + composed AGENT_REGISTRY +
 * roster-drift gate + AI-BOM mapping for server-resident managed agents
 * (plan-v2 Phase 3, T3-3).
 *
 * Lives in a workspace package (not apps/api) because the CLI
 * (`ibx kernel pack-bom`) and the journeys gates consume the roster as
 * data, and apps/* are unreachable from packages/* — the P0-8 lesson.
 */

export {
  AGENT_SESSION_NAMESPACE,
  AgentBudgetsSchema,
  AgentDefinitionSchema,
  AgentAutonomyStageSchema,
  AgentTriggerSchema,
  agentSessionId,
  expectedSessionIdPrefix,
  type AgentBudgets,
  type AgentDefinition,
  type AgentAutonomyStage,
  type AgentTrigger,
} from "./definition.js"

export { AGENT_REGISTRY, PIX_REMEDIATION_AGENT } from "./registry.js"

export {
  agentRosterDrift,
  assertAgentRosterIntegrity,
  registeredPolicyKinds,
  type AgentRosterDriftCode,
  type AgentRosterDriftFinding,
} from "./drift.js"

export {
  agentBomPackId,
  agentConformanceReport,
  agentDefinitionDigest,
  agentPackManifest,
  generateAgentAiBom,
  type AgentBomOptions,
} from "./bom.js"
