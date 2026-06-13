// Managed-agent plane boot wiring (plan-v2 T3-9, step 1 — "flip it on").
//
// Composes + starts the full managed-agent plane (trigger bridge T3-2 → host
// kill-guard T3-5 → Stage-0 shadow runner T3-6, plus the kill-switch manager and
// the Stage-1 approval engine) from the production ports, BEHIND an opt-in flag.
// Default OFF: a normal api boot never touches NATS/BullMQ/agent pollers. An
// operator sets `IBX_AGENTS_ENABLED=true` on the test stack to activate — that
// boot is where the Stage-0 soak clock starts (D-017).
//
// `createPixTriggerMapper` is the real event→trigger logic: a
// `payment.status_changed` event carries an orderId + newStatus but NO
// customerId (the session/memory routing key), so the mapper resolves the
// order's customer and qualifies the failed/expired transition the PIX agent
// triggers on. It is pure of infra (the order lookup is injected) and unit-tested.
//
// VALIDATION SCOPE: the flag-OFF path + the mapper are unit-validated; the
// flag-ON `start()` (live NATS subscribe + BullMQ worker + Redis pub/sub kill
// pollers) is validated by the operator on the running test stack — it cannot be
// exercised in a unit run.

import {
  AGENT_SESSION_NAMESPACE,
  assertAgentRosterIntegrity,
  type AgentDefinition,
} from "@ibatexas/agents";
import type { PaymentStatusChangedEvent } from "@ibatexas/types";
import type {
  RedisLedgerClient,
  RedisPubSubClient,
} from "@adjudicate/audit";
import { logger } from "../lib/logger.js";
import {
  composeAgentPlane,
  killGuardedRunner,
  type AgentPlane,
} from "./agent-plane.js";
import {
  composeShadowConductor,
  createShadowTriggerRunner,
  type ShadowConductorDeps,
} from "./shadow-conductor.js";
import { createLoggingAgentRunJournal } from "./agent-run-journal.js";
import type {
  TriggerDedupRedis,
  TriggerEventMapper,
  TriggerJob,
} from "./agent-trigger-bridge.js";
import {
  createAgentKillSwitchManager,
  type AgentKillSwitchManager,
} from "./agent-kill-switch.js";
import type { AgentApprovalEngine } from "./agent-approvals.js";

/** Env flag that opts a boot into running the managed-agent plane (default off). */
export const AGENTS_ENABLED_ENV = "IBX_AGENTS_ENABLED";

export function agentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENTS_ENABLED_ENV] === "true";
}

// ── Event → trigger mapper (the real, testable product logic) ────────────────

/** Resolve an order's owning customer (injected; the domain order-query service in prod). */
export type OrderCustomerResolver = (orderId: string) => Promise<string | null>;

/**
 * Build the {@link TriggerEventMapper} for the PIX remediation agent over
 * `payment.status_changed`. Qualifies the transition (`payment.${newStatus}`
 * ∈ the agent's `trigger.eventKinds`), resolves the order→customer routing key,
 * and shapes the {@link TriggerJob}. Returns null to DROP (wrong transition, or
 * a customer that can't be resolved — never open a capsule without a routable
 * customer). Pure: the order lookup is injected.
 */
export function createPixTriggerMapper(
  resolveCustomer: OrderCustomerResolver,
): TriggerEventMapper {
  return async (agent: AgentDefinition, subject: string, payload: Record<string, unknown>) => {
    const e = payload as Partial<PaymentStatusChangedEvent> & {
      eventId?: string;
      causalActorSessionId?: string;
    };
    if (typeof e.orderId !== "string" || typeof e.newStatus !== "string") return null;

    // The event carries `newStatus` ("failed"/"expired"); the agent declares
    // trigger eventKinds as `payment.failed`/`payment.expired`. Map + qualify.
    const eventKind = `payment.${e.newStatus}`;
    if (!agent.trigger.eventKinds.includes(eventKind)) return null;

    const customerId = await resolveCustomer(e.orderId);
    if (customerId === null || customerId.length === 0) return null;

    const eventId = e.eventId ?? `${e.paymentId ?? e.orderId}:${e.newStatus}`;
    const job: TriggerJob = {
      agent,
      event: {
        sourceSubject: `ibatexas.${subject}`,
        eventId,
        kind: subject,
        payload: e,
        entityRef: { kind: "order", id: e.orderId, customerId },
        ...(typeof e.timestamp === "string" ? { occurredAt: e.timestamp } : {}),
      },
      ...(e.causalActorSessionId !== undefined
        ? { causalActorSessionId: e.causalActorSessionId }
        : {}),
    };
    return job;
  };
}

// ── Plane boot ────────────────────────────────────────────────────────────────

export interface ManagedAgentPlaneDeps {
  readonly registry: ReadonlyArray<AgentDefinition>;
  /** Production conductor ports reused by the Stage-0 shadow composition. */
  readonly shadowPorts: Omit<ShadowConductorDeps, "realTools" | "systemChannel">;
  /** The real tool roster (mirrored into the sandbox registry). */
  readonly realTools: ShadowConductorDeps["realTools"];
  /** The non-conversational ingress driver (T3-1). */
  readonly systemChannel: ShadowConductorDeps["systemChannel"];
  /** Read/write Redis (dedup claims + kill-switch state). The ledger client satisfies this. */
  readonly redis: RedisLedgerClient;
  /** Pub/sub Redis (a separate subscriber connection) for kill-switch propagation. */
  readonly pubsub: RedisPubSubClient;
  /** Stage-1 approval engine (the confirm-gated resolution surface). */
  readonly approvals: AgentApprovalEngine;
  /** Resolves an order's customer for the trigger mapper. */
  readonly resolveCustomer: OrderCustomerResolver;
  /** ISO clock for the agent_runs journal. */
  readonly now: () => string;
}

/**
 * Compose + start the managed-agent plane IF `IBX_AGENTS_ENABLED=true`; else a
 * no-op returning null. Wires the bridge over a kill-guarded Stage-0 shadow
 * runner, asserts roster integrity fail-closed, and boots the kill-switch
 * pollers + bridge. Returns the started {@link AgentPlane} (call `.stop()` on
 * shutdown / test reset).
 */
export async function startManagedAgentPlane(
  deps: ManagedAgentPlaneDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentPlane | null> {
  if (!agentsEnabled(env)) return null;

  // Fail-closed before composing anything that opens an agent capsule.
  assertAgentRosterIntegrity(deps.registry);

  const composition = composeShadowConductor({
    ...deps.shadowPorts,
    realTools: deps.realTools,
    systemChannel: deps.systemChannel,
  });

  const killSwitch: AgentKillSwitchManager = createAgentKillSwitchManager({
    registry: deps.registry,
    redis: deps.redis,
    pubsub: deps.pubsub,
  });

  const shadowRunner = createShadowTriggerRunner({
    composition,
    systemChannel: deps.systemChannel,
    journal: createLoggingAgentRunJournal(),
    stage: 0, // Stage-0 shadow; promotion is soak-gated (canPromoteToStage1).
    now: deps.now,
  });

  // T3-5 host-side pre-openCapsule kill check wrapping the shadow runner.
  const runner = killGuardedRunner(shadowRunner, (ns) =>
    killSwitch.isKilled(ns),
  );

  const plane = composeAgentPlane({
    registry: deps.registry,
    runner,
    killSwitch,
    approvals: deps.approvals,
    redis: deps.redis as unknown as TriggerDedupRedis,
    mapEvent: createPixTriggerMapper(deps.resolveCustomer),
  });

  await plane.start();
  logger.info(
    {
      component: "managed-agent-plane",
      agents: deps.registry.map((a) => a.id),
      namespace: AGENT_SESSION_NAMESPACE,
    },
    "managed-agent plane ENABLED + started (Stage-0 shadow; soak clock running)",
  );
  return plane;
}
