// Managed-agent plane boot wiring (P1 — the SINGLE live path).
//
// Composes + starts the full managed-agent plane (trigger bridge → host
// kill-guard → LIVE trigger runner, plus the kill-switch manager and the
// Stage-1 approval engine) from the production ports, BEHIND an opt-in flag.
// Default OFF: a normal api boot never touches NATS/BullMQ/agent pollers. An
// operator sets `IBX_AGENTS_ENABLED=true` to activate. The staging machinery
// (shadow conductor, sandbox registry, soak gate, autonomy ladder) is GONE — a
// trigger really executes; money-moving kinds are confirm-gated by policy (B1)
// and park a real approval (B2), with a proactive refund circuit breaker and a
// fail-closed boot assertion guarding the first N money attempts.
//
// `createPixTriggerMapper` is the real event→trigger logic: a
// `payment.status_changed` event carries an orderId + newStatus but NO
// customerId (the session/memory routing key), so the mapper resolves the
// order's customer and qualifies the failed/expired transition. Pure of infra
// (the order lookup is injected) and unit-tested.

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
  createLiveTriggerRunner,
  type LiveAgentConductorDeps,
  type ParkedRemediationProposal,
} from "./live-agent-conductor.js";
import type { AgentRunJournal } from "./agent-run-journal.js";
import type { LearningSink } from "../learning-sink-bootstrap.js";
import {
  assertRealMoneyConfirmGuards,
  type RefundCircuitBreaker,
} from "./agent-realmoney-safety.js";
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
      ...(e.causalActorSessionId === undefined
        ? {}
        : { causalActorSessionId: e.causalActorSessionId }),
    };
    return job;
  };
}

// ── Plane boot ────────────────────────────────────────────────────────────────

export interface ManagedAgentPlaneDeps {
  readonly registry: ReadonlyArray<AgentDefinition>;
  /** Live conductor ingredients (ports + REAL tools + model seams + systemChannel). */
  readonly liveConductor: LiveAgentConductorDeps;
  /** Durable agent_runs journal (Postgres in prod; logging ring in tests). */
  readonly journal: AgentRunJournal;
  /** Read/write Redis (kill-switch state). The ledger client satisfies this. */
  readonly redis: RedisLedgerClient;
  /**
   * The trigger-dedup claim surface — F-21.
   *
   * A SEPARATE member from `redis` above, and not a widening of it, because the
   * two need different things. The kill switch reads and writes ordinary
   * strings, which `RedisLedgerClient` covers. The dedup path additionally
   * RELEASES claims, and after F-21 it releases them with an ownership-checked
   * Lua compare-and-delete — a command `RedisLedgerClient` does not have.
   *
   * Until F-21 that gap was papered over here with
   * `deps.redis as unknown as TriggerDedupRedis`. The cast type-checked and was
   * false: `buildLedgerClient()` returns an object literal carrying only
   * `set`/`get`/`del`, so any Lua issued through it would have thrown at
   * runtime. Composed via `createTriggerDedupRedis()` from a client that really
   * can `eval`, the cast is gone and the requirement is checked by `tsc`.
   */
  readonly dedupRedis: TriggerDedupRedis;
  /** Pub/sub Redis (a separate subscriber connection) for kill-switch propagation. */
  readonly pubsub: RedisPubSubClient;
  /** Stage-1 approval engine (the confirm-gated resolution surface; B2 target). */
  readonly approvals: AgentApprovalEngine;
  /** Proactive per-agent/per-window refund circuit breaker (real-money parks). */
  readonly refundBreaker?: RefundCircuitBreaker;
  /** P4 producer seam: persist a remediation proposal when an approval parks. */
  readonly proposalSink?: (proposal: ParkedRemediationProposal) => void | Promise<void>;
  /** ERDS-060 learning telemetry sink — best-effort `learning.event.v1` per turn. */
  readonly learningSink?: LearningSink;
  /** Kinds the composed kernel policy confirm-gates (B1) — fail-closed assertion input. */
  readonly realMoneyConfirmKinds: ReadonlySet<string>;
  /** Resolves an order's customer for the trigger mapper. */
  readonly resolveCustomer: OrderCustomerResolver;
  /** ISO clock for the agent_runs journal. */
  readonly now: () => string;
}

/**
 * Compose + start the managed-agent plane IF `IBX_AGENTS_ENABLED=true`; else a
 * no-op returning null. Asserts roster integrity AND real-money confirm-guard
 * conformance fail-closed (crashes the boot if an agent declares a money kind
 * without the B1 confirm guard composed), then wires the bridge over a
 * kill-guarded LIVE trigger runner and boots the kill-switch pollers + bridge.
 * Returns the started {@link AgentPlane} (call `.stop()` on shutdown / reset).
 */
export async function startManagedAgentPlane(
  deps: ManagedAgentPlaneDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentPlane | null> {
  if (!agentsEnabled(env)) return null;

  // Fail-closed before composing anything that opens an agent capsule.
  assertAgentRosterIntegrity(deps.registry);
  // Fail-closed: refuse to boot a live plane where a declared real-money kind
  // lacks a composed sessionId-confirm guard (the blast-radius callout).
  assertRealMoneyConfirmGuards(deps.registry, deps.realMoneyConfirmKinds);

  const killSwitch: AgentKillSwitchManager = createAgentKillSwitchManager({
    registry: deps.registry,
    redis: deps.redis,
    pubsub: deps.pubsub,
  });

  const liveRunner = createLiveTriggerRunner({
    conductor: deps.liveConductor,
    systemChannel: deps.liveConductor.systemChannel,
    journal: deps.journal,
    approvals: deps.approvals,
    ...(deps.refundBreaker === undefined ? {} : { refundBreaker: deps.refundBreaker }),
    ...(deps.proposalSink === undefined ? {} : { proposalSink: deps.proposalSink }),
    ...(deps.learningSink === undefined ? {} : { learningSink: deps.learningSink }),
    now: deps.now,
  });

  // T3-5 host-side pre-openCapsule kill check wrapping the live runner.
  const runner = killGuardedRunner(liveRunner, (ns) => killSwitch.isKilled(ns));

  const plane = composeAgentPlane({
    registry: deps.registry,
    runner,
    killSwitch,
    approvals: deps.approvals,
    redis: deps.dedupRedis,
    mapEvent: createPixTriggerMapper(deps.resolveCustomer),
  });

  await plane.start();
  logger.info(
    {
      component: "managed-agent-plane",
      agents: deps.registry.map((a) => a.id),
      namespace: AGENT_SESSION_NAMESPACE,
    },
    "managed-agent plane ENABLED + started (LIVE — single path; refunds confirm-gated)",
  );
  return plane;
}
