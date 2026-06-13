// Per-agent kill switch (T3-2/T3-9 safety; plan-v2 T3-5).
//
// A managed agent must be stoppable in seconds, fleet-wide, WITHOUT taking down
// chat/WhatsApp or the rest of the kernel. The upstream distributed kill switch
// (@adjudicate/audit) is GLOBAL — tripping it sets a `RuntimeContext.killSwitch`
// that REFUSEs every intent in that context. So this module composes ONE
// distributed poller per agent, each bound to a DEDICATED throwaway
// RuntimeContext (never the process default), and reads the live state through
// the poller's `onApply` callback into a per-agent map. The kernel never sees
// these contexts; the map is the source of truth for two enforcement points:
//
//   - HOST-SIDE (outside the seal pipeline): the trigger bridge / agent runner
//     calls {@link AgentKillSwitchManager.isKilled} BEFORE opening a capsule, so
//     a killed agent never even runs a turn (T3-6/T3-9 wire this in).
//   - KERNEL-SIDE (inside adjudication, AUTH phase): {@link
//     createAgentKillSwitchGuard} (agent-guards.ts) REFUSEs every envelope from a
//     killed agent with basis `kill.ACTIVE` — defense in depth for an in-flight
//     turn that passed the host check before the switch flipped.
//
// Propagation: each poller layers Redis pub/sub (<100 ms warm) over polling
// (eventual consistency within `pollMs*2`), so a flip stops the next trigger
// within ~1 s fleet-wide (plan-v2 §5 T3-5 acceptance). The Redis key is
// `rk(agent.killSwitchKey)`; the operator/ops flips it via {@link
// AgentKillSwitchManager.trip}/`clear`, or directly against that key.

import {
  startDistributedKillSwitchPubSub,
  type DistributedKillSwitchPubSubHandle,
  type RedisLedgerClient,
  type RedisPubSubClient,
} from "@adjudicate/audit";
import { createRuntimeContext } from "@adjudicate/core/kernel";
import { rk } from "@ibatexas/tools";
import { type AgentDefinition } from "@ibatexas/agents";
import { logger } from "../lib/logger.js";

export interface AgentKillSwitchManagerDeps {
  readonly registry: ReadonlyArray<AgentDefinition>;
  /** Read/write Redis client (same surface the execution ledger uses). */
  readonly redis: RedisLedgerClient;
  /**
   * Pub/sub Redis client — node-redis requires a SEPARATE subscriber connection
   * from the read/write one. One subscriber connection may carry every agent's
   * channel, so a single client is shared across all pollers.
   */
  readonly pubsub: RedisPubSubClient;
  /** Polling fallback cadence (ms). Default 1000 (≤2 s eventual consistency). */
  readonly pollMs?: number;
}

export interface AgentKillSwitchManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Whether the agent owning this namespace (`agent:<id>@<version>`, i.e. an
   * AgentDefinition.sessionIdPrefix) is currently killed. Unknown namespaces →
   * false (a non-agent / unregistered namespace is never "killed" here; the
   * scope guard owns unregistered-namespace refusal).
   */
  isKilled(agentNamespace: string): boolean;
  /** Trip a specific agent's switch (writes Redis + broadcasts). Ops/tests. */
  trip(agentId: string, reason: string): Promise<void>;
  /** Clear a specific agent's switch. Ops/tests. */
  clear(agentId: string): Promise<void>;
}

/** Redis key holding the `{active, reason, …}` JSON for one agent's switch. */
export function agentKillSwitchKey(agent: AgentDefinition): string {
  return rk(agent.killSwitchKey);
}

function agentKillSwitchChannel(agent: AgentDefinition): string {
  return `${agentKillSwitchKey(agent)}:channel`;
}

/**
 * Compose the per-agent kill-switch manager over the registry. Each agent gets
 * one pub/sub-accelerated poller bound to its own throwaway RuntimeContext; the
 * live killed-state is read off `onApply` into a map keyed by the agent's
 * `sessionIdPrefix` (what {@link isKilled} and the kernel guard look up).
 */
export function createAgentKillSwitchManager(
  deps: AgentKillSwitchManagerDeps,
): AgentKillSwitchManager {
  // namespace (`agent:<id>@<ver>`) → killed?  Seeded false for every agent.
  const killed = new Map<string, boolean>(
    deps.registry.map((a) => [a.sessionIdPrefix, false]),
  );
  const handles = new Map<string, DistributedKillSwitchPubSubHandle>();

  return {
    async start() {
      for (const agent of deps.registry) {
        // A DEDICATED context per agent: the poller calls
        // `context.killSwitch.set()` on every transition; binding it to a
        // throwaway context (never the process default) keeps one agent's kill
        // from ever blocking chat or another agent. We read state via onApply.
        const isolatedContext = createRuntimeContext();
        const handle = startDistributedKillSwitchPubSub({
          redis: deps.redis,
          pubsub: deps.pubsub,
          key: agentKillSwitchKey(agent),
          channel: agentKillSwitchChannel(agent),
          ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
          context: isolatedContext,
          logger: {
            warn: (e) =>
              logger.warn(
                { component: "agent-kill-switch", agentId: agent.id, ...e },
                "agent kill-switch poll degraded",
              ),
          },
          onApply: (e) => {
            killed.set(agent.sessionIdPrefix, e.active);
            logger.info(
              {
                component: "agent-kill-switch",
                agentId: agent.id,
                active: e.active,
                source: e.source,
                reason: e.reason,
              },
              `agent kill-switch ${e.active ? "ENGAGED" : "cleared"}`,
            );
          },
        });
        handles.set(agent.id, handle);
      }
    },

    async stop() {
      await Promise.all(
        [...handles.values()].map((h) =>
          h.stop().catch(() => {
            /* best-effort teardown */
          }),
        ),
      );
      handles.clear();
    },

    isKilled(agentNamespace) {
      return killed.get(agentNamespace) ?? false;
    },

    async trip(agentId, reason) {
      const handle = handles.get(agentId);
      if (handle === undefined) {
        throw new Error(`agent kill-switch: unknown or unstarted agent "${agentId}"`);
      }
      await handle.trip(reason);
    },

    async clear(agentId) {
      const handle = handles.get(agentId);
      if (handle === undefined) {
        throw new Error(`agent kill-switch: unknown or unstarted agent "${agentId}"`);
      }
      await handle.clear();
    },
  };
}
