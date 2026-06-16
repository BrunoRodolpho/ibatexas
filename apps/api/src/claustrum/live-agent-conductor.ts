// Live agent Conductor composition + trigger runner (P1-D / H1 / B2).
//
// Replaces the deleted Stage-0 shadow plane. The live plane is a SECOND
// Conductor composition that mirrors production — same adjudicator (decisions
// hit the REAL kernel and write REAL `agent:` `intent_audit` rows), same
// memory/grounding/session/planner/responder — MINUS the sandbox: tools are the
// REAL registry, so a trigger turn really executes. The two deliberate swaps the
// shadow plane kept remain:
//   - channels   = [SystemChannel] (T3-1)
//   - lockKeyStrategy = sessionKeyAwareLockKey (DR-4) so a trigger turn
//     serializes against the customer's chat turns on the entity-scoped key.
//
// H1 (per-turn model cap): createConductor binds planner/responder at compose
// time, so a single reused conductor cannot host a per-trigger cap. Each trigger
// therefore RECOMPOSES the conductor over a fresh createModelCallCap(model, max)
// — the recomposition is cheap (port wiring), the cap is genuinely per-turn.
//
// B2 (park-seam): a REQUEST_CONFIRMATION decision (the B1 refund-confirm rule
// fires for agent-session refunds) parks a REAL approval via approvals.request()
// — without this seam the console/adjutant /approvals queue stays empty no
// matter how many phases ship. Real-money kinds additionally pass the proactive
// refund circuit breaker before parking.
//
// Agent-namespace identity (D-017): the production planner stamps
// envelope.actor.sessionId = state.conversationId, so the runner OVERRIDES the
// inbound conversationId to the agent sessionId before opening the capsule —
// that is how every agent row lands UNHASHED in the `agent:` namespace.

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
  type ModelProvider,
  type PlannerPort,
  type ResolverPort,
  type ResponderPort,
  type SessionLock,
  type SessionPort,
  type TelemetryPort,
  type TenantResolver,
  type ToolRegistry,
  type TurnResult,
} from "@claustrum/core";
import type { IntentEnvelope } from "@adjudicate/core";
import { logger } from "../lib/logger.js";
import { isSessionPausedForHuman } from "../escalation/escalation-store.js";
import { triggerExternalId, type SystemChannel } from "./system-channel.js";
import {
  createModelCallCap,
  type TriggerTurnInput,
  type TriggerTurnResult,
  type TriggerTurnRunner,
} from "./agent-trigger-bridge.js";
import type { AgentRunJournal } from "./agent-run-journal.js";
import type { AgentApprovalEngine } from "./agent-approvals.js";
import {
  isRealMoneyKind,
  type RefundCircuitBreaker,
} from "./agent-realmoney-safety.js";

/**
 * The shared production ports the live plane reuses verbatim, plus the seams H1
 * needs to recompose the conductor over a capped model per trigger. The base
 * (uncapped) `modelProvider` is wrapped per-trigger; `buildPlanner`/
 * `buildResponder` rebuild those ports over that wrapped model.
 */
export interface LiveAgentConductorDeps {
  readonly adjudicator: Adjudicator;
  readonly memory: MemoryPort;
  readonly grounding: GroundingPort;
  readonly explainer: ExplainerPort;
  readonly handoff: HandoffPort;
  readonly telemetry: TelemetryPort;
  readonly session: SessionPort;
  readonly tenantResolver: TenantResolver;
  readonly sessionLock: SessionLock;
  readonly resolver?: ResolverPort;
  /** The REAL tool registry — tools really execute (no sandbox). */
  readonly tools: ToolRegistry;
  /** The non-conversational ingress driver (T3-1). */
  readonly systemChannel: SystemChannel;
  /** Base (uncapped) model provider; wrapped per-trigger by createModelCallCap. */
  readonly modelProvider: ModelProvider;
  /** Build the planner over a (capped) model. */
  readonly buildPlanner: (model: ModelProvider) => PlannerPort;
  /** Build the responder over a (capped) model. */
  readonly buildResponder: (model: ModelProvider) => ResponderPort;
}

/**
 * Compose a live agent Conductor over a (possibly capped) model — mirrors the
 * old shadow compose MINUS the sandbox (tools really execute). Called once per
 * trigger by the runner with that trigger's capped model.
 */
export function composeLiveAgentConductor(
  deps: LiveAgentConductorDeps,
  model: ModelProvider,
): Conductor {
  return createConductor({
    adjudicator: deps.adjudicator,
    memory: deps.memory,
    grounding: deps.grounding,
    planner: deps.buildPlanner(model),
    responder: deps.buildResponder(model),
    explainer: deps.explainer,
    handoff: deps.handoff,
    telemetry: deps.telemetry,
    session: deps.session,
    tools: deps.tools,
    channels: [deps.systemChannel],
    tenantResolver: deps.tenantResolver,
    sessionLock: deps.sessionLock,
    // DR-4: honor the entity-scoped sessionKey the trigger bridge supplies so an
    // agent turn serializes against the customer's chat turns.
    lockKeyStrategy: sessionKeyAwareLockKey,
    ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}),
  });
}

/** Derive the journaled intentKind from the planned envelopes (handle 0 / 1 / N). */
export function deriveIntentKind(envelopes: ReadonlyArray<IntentEnvelope>): string {
  if (envelopes.length === 0) return "";
  if (envelopes.length === 1) return envelopes[0]!.kind;
  return envelopes.map((e) => e.kind).join("+");
}

/**
 * A parked remediation proposal — the P4 producer seam's output. Written to the
 * shared `remediation_proposals` table (the contract the @adjudicate/adjutant
 * Postgres store reads) when the agent parks a confirm-gated remediation. Kept
 * as a local shape so apps/api takes no @adjudicate/adjutant dependency.
 */
export interface ParkedRemediationProposal {
  /** Stable id = the trigger's deterministic externalId. */
  readonly proposalId: string;
  /** The incident = the entity the trigger was about (`order:<id>`). */
  readonly incidentId: string;
  /** The remediation action = the proposed intent kind. */
  readonly action: string;
  /** A parked confirm is a REVIEW disposition. */
  readonly disposition: "REVIEW";
  readonly status: "pending_review";
  readonly approvalToken: string;
  readonly intentHash: string;
  /** ISO time the proposal was parked. */
  readonly at: string;
}

export interface LiveTriggerRunnerDeps {
  /** Conductor ingredients — recomposed per trigger over the capped model (H1). */
  readonly conductor: LiveAgentConductorDeps;
  readonly systemChannel: SystemChannel;
  readonly journal: AgentRunJournal;
  /** Stage-1 approval engine — the B2 park-seam target. */
  readonly approvals: AgentApprovalEngine;
  /** Proactive per-agent/per-window refund breaker (gates real-money parks). */
  readonly refundBreaker?: RefundCircuitBreaker;
  /**
   * P4 producer seam: write a remediation proposal when a confirm decision parks
   * (the adjutant projects incidents/proposals from these + agent_runs). Best-
   * effort; a write failure never breaks the turn. Omit to disable.
   */
  readonly proposalSink?: (proposal: ParkedRemediationProposal) => void | Promise<void>;
  /** ISO clock for the agent_runs journal. */
  readonly now: () => string;
}

/**
 * Build the {@link TriggerTurnRunner} the trigger bridge drives. Per trigger:
 * caps the model, recomposes the conductor over it (H1), opens a system capsule,
 * runs the kernel-gated turn (tools REALLY execute), parks an approval on
 * REQUEST_CONFIRMATION (B2, breaker-gated for real money), journals to
 * `agent_runs`, and returns the decision + model-call count.
 */
export function createLiveTriggerRunner(
  deps: LiveTriggerRunnerDeps,
): TriggerTurnRunner {
  return async (input) => {
    const { event, sessionId, maxModelCalls } = input;
    // D2 bot-pause gate (managed-agent plane): if this agent session is under a
    // human takeover (open escalation), suppress the autonomous turn — don't
    // recompose, plan, or act. Symmetric with the conversational planes.
    if (await isSessionPausedForHuman(sessionId)) {
      return { decisionKind: "PAUSED_FOR_HUMAN", modelCalls: 0 };
    }
    // H1: a FRESH cap per trigger; recompose the conductor over the capped model.
    const capped = createModelCallCap(deps.conductor.modelProvider, maxModelCalls);
    const conductor = composeLiveAgentConductor(deps.conductor, capped);

    const inbound = await deps.systemChannel.perceive(event);
    // D-017 identity: the planner stamps actor.sessionId = conversationId, so the
    // conversation id IS the agent's audit namespace.
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
      return await processLiveTurnResult(deps, input, result, capped.calls());
    } finally {
      await conductor.closeCapsule(capsule);
    }
  };
}

/**
 * Post-turn handling — the park-seam (B2) + agent_runs journal + result shaping.
 * Extracted from the runner so it is unit-testable with a synthetic TurnResult
 * (no real conductor/handleTurn needed). A REQUEST_CONFIRMATION decision parks a
 * real approval (breaker-gated for real money); every turn is journaled.
 */
export async function processLiveTurnResult(
  deps: LiveTriggerRunnerDeps,
  input: TriggerTurnInput,
  result: TurnResult,
  modelCalls: number,
): Promise<TriggerTurnResult> {
  const { agent, event, sessionId } = input;
  const envelopes = result.plan.envelopes;
  const intentKind = deriveIntentKind(envelopes);

  // B2 park-seam: a confirm decision queues a REAL approval (the source the
  // console/adjutant /approvals read). Real-money kinds pass the breaker first.
  // Fail-OPEN on a park error — the kernel already withheld EXECUTE. On a
  // successful park, the P4 producer seam writes a remediation proposal.
  if (result.decision.kind === "REQUEST_CONFIRMATION" && envelopes.length > 0) {
    const envelope = envelopes[0]!;
    const token = await parkApproval(deps, agent.id, envelope, result.decision.prompt);
    if (token !== null && deps.proposalSink) {
      try {
        await deps.proposalSink({
          proposalId: triggerExternalId(event),
          incidentId: `${event.entityRef.kind}:${event.entityRef.id}`,
          action: intentKind,
          disposition: "REVIEW",
          status: "pending_review",
          approvalToken: token,
          intentHash: envelope.intentHash,
          at: deps.now(),
        });
      } catch (err) {
        logger.error(
          { component: "live-agent-conductor", agentId: agent.id, err: (err as Error).message },
          "failed to write remediation proposal (swallowed — approval already parked)",
        );
      }
    }
  }

  await deps.journal.record({
    agentId: agent.id,
    agentVersion: agent.version,
    sessionId,
    entity: `${event.entityRef.kind}:${event.entityRef.id}`,
    externalId: triggerExternalId(event),
    decisionKind: result.decision.kind,
    intentKind,
    modelCalls,
    at: deps.now(),
  });

  return { decisionKind: result.decision.kind, modelCalls };
}

/**
 * Park a confirm-gated envelope as a real approval (breaker-gated for money).
 * Returns the approval token on success, or null when suppressed/failed.
 */
async function parkApproval(
  deps: LiveTriggerRunnerDeps,
  agentId: string,
  envelope: IntentEnvelope,
  prompt: string,
): Promise<string | null> {
  try {
    if (isRealMoneyKind(envelope.kind) && deps.refundBreaker) {
      const allowed = await deps.refundBreaker.tryConsume(agentId);
      if (!allowed) {
        logger.warn(
          { component: "live-agent-conductor", agentId, kind: envelope.kind },
          "refund circuit breaker tripped — NOT parking approval this window",
        );
        return null;
      }
    }
    const request = await deps.approvals.request({ envelope, prompt });
    logger.info(
      { component: "live-agent-conductor", agentId, kind: envelope.kind, token: request.token },
      "agent confirm decision parked a real approval (B2)",
    );
    return request.token;
  } catch (err) {
    // Parking is best-effort: the kernel already withheld EXECUTE, so a park
    // failure cannot move money. Log and continue (turn unaffected).
    logger.error(
      { component: "live-agent-conductor", agentId, kind: envelope.kind, err: (err as Error).message },
      "failed to park agent approval (swallowed — kernel already withheld EXECUTE)",
    );
    return null;
  }
}
