// Stage-0 shadow Conductor composition + trigger runner (plan-v2 T3-6).
//
// The shadow plane is a SECOND Conductor composition that mirrors production —
// same adjudicator (so decisions hit the REAL kernel and write REAL
// `intent_audit` rows), same memory/grounding/session/planner/responder — but
// with two deliberate swaps:
//   - tools  = a DEDICATED sandbox ToolRegistry (shadow-tool-registry.ts): every
//     EXECUTE/REWRITE resolves to a no-op recorder, so the shadow agent can
//     never mutate Medusa/Prisma/NATS. Fail-closed by construction (no real
//     executor is even present), conformance-asserted at composition.
//   - channels = [SystemChannel] (T3-1) + lockKeyStrategy = sessionKeyAwareLockKey
//     (DR-4) so a trigger turn serializes against the customer's chat turns on
//     the entity-scoped key the bridge supplies.
//
// Agent-namespace identity (D-017): the production planner stamps
// `envelope.actor.sessionId = state.conversationId`. So the runner OVERRIDES the
// inbound `conversationId` to the agent sessionId (`agent:<id>@<ver>:entity:…`)
// before opening the capsule — that is how every shadow row lands UNHASHED in
// the `agent:` namespace (the redactor carve-out keeps it so), which the
// time-windowed production-signal filters (kernel-replay `--ci` T1b-3, impact
// graph T2-4, drift baseline) exclude. Shadow rows are REAL audit rows; the
// exclusion is at query time, never at write.

import {
  createConductor,
  handleTurn,
  sessionKeyAwareLockKey,
  type Adjudicator,
  type Capsule,
  type Conductor,
  type ExplainerPort,
  type GroundingPort,
  type HandoffPort,
  type MemoryPort,
  type PlannerPort,
  type ResolverPort,
  type ResponderPort,
  type SessionLock,
  type SessionPort,
  type TelemetryPort,
  type TenantResolver,
  type ToolDefinition,
} from "@claustrum/core";
import { triggerExternalId, type SystemChannel } from "./system-channel.js";
import {
  assertNoRealExecutors,
  createSandboxToolRegistry,
  type SandboxExecution,
} from "./shadow-tool-registry.js";
import type { AgentRunJournal } from "./agent-run-journal.js";
import type { TriggerTurnRunner } from "./agent-trigger-bridge.js";

/** The shared production ports the shadow plane reuses verbatim. */
export interface ShadowConductorDeps {
  readonly adjudicator: Adjudicator;
  readonly memory: MemoryPort;
  readonly grounding: GroundingPort;
  readonly planner: PlannerPort;
  readonly responder: ResponderPort;
  readonly explainer: ExplainerPort;
  readonly handoff: HandoffPort;
  readonly telemetry: TelemetryPort;
  readonly session: SessionPort;
  readonly tenantResolver: TenantResolver;
  readonly sessionLock: SessionLock;
  readonly resolver?: ResolverPort;
  /** The REAL tool roster — mirrored capability-for-capability into the sandbox. */
  readonly realTools: ReadonlyArray<ToolDefinition<unknown, unknown>>;
  /** The non-conversational ingress driver (T3-1). */
  readonly systemChannel: SystemChannel;
}

export interface ShadowComposition {
  readonly conductor: Conductor;
  /** Return + clear the would-be mutations the sandbox recorded since last drain. */
  drainSandboxExecutions(): SandboxExecution[];
}

/**
 * Compose the Stage-0 shadow Conductor. Builds a dedicated sandbox registry
 * from `realTools`, asserts it holds zero real executors (conformance), and
 * wires a second Conductor over the shared ports with `[systemChannel]` +
 * `sessionKeyAwareLockKey`.
 */
export function composeShadowConductor(deps: ShadowConductorDeps): ShadowComposition {
  const buffer: SandboxExecution[] = [];
  const sandboxTools = createSandboxToolRegistry(deps.realTools, (exec) =>
    buffer.push(exec),
  );
  // Fail-closed: never compose a shadow plane that can reach a real executor.
  assertNoRealExecutors(sandboxTools);

  const conductor = createConductor({
    adjudicator: deps.adjudicator,
    memory: deps.memory,
    grounding: deps.grounding,
    planner: deps.planner,
    responder: deps.responder,
    explainer: deps.explainer,
    handoff: deps.handoff,
    telemetry: deps.telemetry,
    session: deps.session,
    tools: sandboxTools,
    channels: [deps.systemChannel],
    tenantResolver: deps.tenantResolver,
    sessionLock: deps.sessionLock,
    // DR-4: honor the entity-scoped sessionKey the trigger bridge supplies so an
    // agent turn serializes against the customer's chat turns.
    lockKeyStrategy: sessionKeyAwareLockKey,
    ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}),
  });

  return {
    conductor,
    drainSandboxExecutions() {
      return buffer.splice(0);
    },
  };
}

export interface ShadowTriggerRunnerDeps {
  readonly composition: ShadowComposition;
  readonly systemChannel: SystemChannel;
  readonly journal: AgentRunJournal;
  /** Autonomy stage this runner journals (0 for the Stage-0 shadow). */
  readonly stage: number;
  /** ISO clock (injected — never read here). */
  readonly now: () => string;
  /** Per-turn model-call count, if the composition wrapped the model (T3-2 cap). */
  readonly countModelCalls?: () => number;
}

/**
 * Build the {@link TriggerTurnRunner} the trigger bridge (T3-2) drives. Opens a
 * capsule on the shadow conductor for one trigger, runs the kernel-gated turn,
 * journals it to `agent_runs`, feeds the shadow drift monitor, and returns the
 * decision + model-call count. NEVER mutates the world (sandbox tools).
 */
export function createShadowTriggerRunner(
  deps: ShadowTriggerRunnerDeps,
): TriggerTurnRunner {
  const { conductor } = deps.composition;
  return async (input) => {
    const { agent, event, sessionId } = input;
    const inbound = await deps.systemChannel.perceive(event);
    // D-017 identity: the planner stamps envelope.actor.sessionId =
    // conversationId, so the conversation id IS the agent's audit namespace.
    const agentInbound = { ...inbound, conversationId: sessionId };

    const capsule: Capsule = await conductor.openCapsule({
      channel: "system",
      customerId: event.entityRef.customerId,
      // Entity-scoped serialization domain vs the customer's chat turns (DR-4).
      sessionKey: `web:${event.entityRef.customerId}`,
      actor: {
        principal: "system",
        role: "system",
        sessionId,
        customerId: event.entityRef.customerId,
      },
      inbound: agentInbound,
    });

    try {
      const result = await handleTurn(capsule, agentInbound);
      const sandboxExecutions = deps.composition.drainSandboxExecutions();

      // Shadow-decision drift is monitored at the audit-sink tee
      // (observability/drift-detector.ts → observeShadowDriftRecord), which sees
      // the REAL agent: audit row this turn just wrote — no coupling here.
      await deps.journal.record({
        agentId: agent.id,
        agentVersion: agent.version,
        stage: deps.stage,
        sessionId,
        entity: `${event.entityRef.kind}:${event.entityRef.id}`,
        externalId: triggerExternalId(event),
        decisionKind: result.decision.kind,
        sandboxExecutions,
        at: deps.now(),
      });

      return {
        decisionKind: result.decision.kind,
        modelCalls: deps.countModelCalls?.() ?? 0,
      };
    } finally {
      await conductor.closeCapsule(capsule);
    }
  };
}
