// Agent plane composition (plan-v2 T3-9 — the managed-agent runtime, assembled).
//
// Ties the Phase-3 pieces into one start()/stop()-able unit so the live boot
// (bootstrapClaustrum, behind an opt-in flag) wires them in one call:
//
//   trigger bridge (T3-2)  — NATS subscribe + BullMQ dedup worker
//     └─ runner = KILL-GUARDED shadow runner:
//          host-side kill check (T3-5) BEFORE the turn → if the agent is
//          killed, suppress (outside the seal pipeline; the kernel-side
//          kill guard is the in-pipeline backstop), else
//        shadow trigger runner (T3-6) — sandbox plane, agent: audit rows, journal
//   kill-switch manager (T3-5) — per-agent distributed pollers + isKilled
//   approval engine (T3-7) — Stage-1 confirm-gated resolution surface
//
// composeAgentPlane builds + wires; start()/stop() run the bridge + pollers. The
// host-side kill check is the piece T3-5 left for the runner — it lands here,
// wrapping the shadow runner so a killed agent never opens a capsule.

import type { AgentDefinition } from "@ibatexas/agents";
import { logger } from "../lib/logger.js";
import { parseAgentSessionNamespace } from "./agent-guards.js";
import type {
  AgentTriggerBridge,
  TriggerDedupRedis,
  TriggerEventMapper,
  TriggerOutcome,
  TriggerTurnRunner,
} from "./agent-trigger-bridge.js";
import { createAgentTriggerBridge } from "./agent-trigger-bridge.js";
import type { AgentKillSwitchManager } from "./agent-kill-switch.js";
import type { AgentApprovalEngine } from "./agent-approvals.js";

/**
 * Wrap a turn runner with the T3-5 HOST-SIDE kill check: before a killed agent's
 * trigger opens a capsule, short-circuit to a suppressed REFUSE-shaped outcome
 * (no turn, no model call). This is the pre-openCapsule gate "outside the seal
 * pipeline"; the AUTH-phase kill guard (agent-guards.ts) is the in-pipeline
 * backstop for a turn already in flight when the switch flips.
 */
export function killGuardedRunner(
  inner: TriggerTurnRunner,
  isKilled: (agentNamespace: string) => boolean,
): TriggerTurnRunner {
  return async (input) => {
    const namespace = parseAgentSessionNamespace(input.sessionId) ?? input.agent.sessionIdPrefix;
    if (isKilled(namespace)) {
      logger.warn(
        { component: "agent-plane", agentId: input.agent.id, sessionId: input.sessionId },
        "trigger suppressed at host — agent kill switch active (pre-openCapsule)",
      );
      // No capsule opened; surface a terminal non-EXECUTE so the bridge journals
      // it as a (zero-model-call) refusal rather than a run.
      return { decisionKind: "REFUSE", modelCalls: 0 };
    }
    return inner(input);
  };
}

export interface AgentPlaneDeps {
  readonly registry: ReadonlyArray<AgentDefinition>;
  /** The kill-guarded shadow trigger runner (compose via composeShadowConductor + killGuardedRunner). */
  readonly runner: TriggerTurnRunner;
  /** Per-agent kill-switch manager (its pollers boot with the plane). */
  readonly killSwitch: AgentKillSwitchManager;
  /** Stage-1 approval engine (the confirm-gated resolution surface). */
  readonly approvals: AgentApprovalEngine;
  /** Dedup-store Redis for the trigger bridge. */
  readonly redis: TriggerDedupRedis;
  /** Maps a raw NATS event → a TriggerJob (resolves entityRef incl. customerId). */
  readonly mapEvent: TriggerEventMapper;
}

export interface AgentPlane {
  readonly bridge: AgentTriggerBridge;
  readonly killSwitch: AgentKillSwitchManager;
  readonly approvals: AgentApprovalEngine;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Compose the managed-agent plane. The trigger bridge runs the injected
 * (kill-guarded shadow) runner; start() boots the kill-switch pollers THEN the
 * bridge (so a killed agent is already known before its first trigger), stop()
 * tears both down. The live boot (bootstrapClaustrum) constructs the runner from
 * composeShadowConductor + createShadowTriggerRunner + killGuardedRunner and
 * passes it here — kept injected so the plane stays composition-agnostic + the
 * wiring is unit-testable without NATS/Redis.
 */
export function composeAgentPlane(deps: AgentPlaneDeps): AgentPlane {
  const bridge = createAgentTriggerBridge({
    registry: deps.registry,
    runner: deps.runner,
    redis: deps.redis,
    mapEvent: deps.mapEvent,
  });

  return {
    bridge,
    killSwitch: deps.killSwitch,
    approvals: deps.approvals,
    async start() {
      // Kill state first — a flipped switch must be visible before the first
      // trigger is processed.
      await deps.killSwitch.start();
      await bridge.start();
      logger.info(
        { component: "agent-plane", agents: deps.registry.map((a) => a.id) },
        "managed-agent plane started",
      );
    },
    async stop() {
      await bridge.stop();
      await deps.killSwitch.stop();
    },
  };
}

export type { TriggerOutcome };
