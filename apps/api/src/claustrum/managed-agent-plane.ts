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
import { setAgentKillStateReader } from "./compose-policy-packs.js";
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
 * conformance before composing anything, then wires the bridge over a
 * kill-guarded LIVE trigger runner and boots the kill-switch pollers + bridge.
 * Returns the started {@link AgentPlane} (call `.stop()` on shutdown / reset).
 *
 * SCOPE OF "FAIL-CLOSED" (F-52 / F-71): a failed assertion stops THIS PLANE, not
 * the process. The throw propagates to claustrum-bootstrap.ts, which catches it,
 * logs, and continues serving with the agent plane off. This doc used to say it
 * "crashes the boot" — it does not, and never did.
 */
export async function startManagedAgentPlane(
  deps: ManagedAgentPlaneDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentPlane | null> {
  if (!agentsEnabled(env)) return null;

  // Fail-closed before composing anything that opens an agent capsule.
  assertAgentRosterIntegrity(deps.registry);
  // Refuse to start a live PLANE where a declared real-money kind lacks a
  // composed sessionId-confirm guard (the blast-radius callout). Closed for the
  // plane, not for the process — the caller swallows this throw.
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

  // T3-5 KERNEL-side leg (F-51). Point the AUTH-phase kill guard's late-bound
  // holder at THIS manager — the same instance the host-side leg above reads, so
  // both legs answer from one store rather than two that can disagree. Until
  // this call landed the holder kept its never-killed default in every process:
  // `agentKillSwitchGuard` is authGuards[0] of every composed pack and it read
  // constant-false, so the in-pipeline backstop the host-side leg is documented
  // to complement did not exist. What that leaves uncovered without this line is
  // exactly what the host-side check cannot reach: a turn already past
  // openCapsule when the switch flips, and the agent-approvals RESUME
  // re-adjudication (a killed agent's parked envelope, re-adjudicated on a
  // manager's accept, never passes through the runner at all).
  //
  // Late binding is what makes the placement safe: `agentKillSwitchGuard` is a
  // module-level const built at import — before any manager exists — over a
  // closure that reads the holder at DECISION time, so packs composed before
  // this call still see the live state. Composition order is not load-bearing.
  setAgentKillStateReader((ns) => killSwitch.isKilled(ns));

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
