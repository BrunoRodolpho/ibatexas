// T3-5 — per-agent kill switch.
//
// Two layers, mirroring the production composition:
//
//   - AgentKillSwitchManager: one distributed (pub/sub + polling) poller per
//     agent, bound to a DEDICATED RuntimeContext (never the global kernel
//     switch), tracking per-agent killed-state via onApply. trip()/clear()
//     propagate through Redis pub/sub; isKilled() reads the live map.
//   - createAgentKillSwitchGuard (AUTH phase): REFUSEs every envelope from a
//     killed agent with basis kill.ACTIVE — even an IN-SCOPE kind that would
//     otherwise EXECUTE — proving the kill check precedes scope/business.
//
// The end-to-end test wires the manager's isKilled into the REAL production
// composition (buildIbatexasPolicyPacks) via setAgentKillStateReader and runs
// the REAL kernel: trip → the next in-scope regenerate REFUSEs; clear → it
// EXECUTEs again (plan-v2 §5 T3-5 acceptance: "flip stops the next trigger").

import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import { paymentsPack } from "@ibatexas/pack-payments";
import { PIX_REMEDIATION_AGENT, agentSessionId } from "@ibatexas/agents";
import type {
  RedisLedgerClient,
  RedisPubSubClient,
} from "@adjudicate/audit";
import {
  AGENT_KILL_SWITCH_REFUSAL_CODE,
  createAgentKillSwitchGuard,
} from "../claustrum/agent-guards.js";
import {
  buildIbatexasPolicyPacks,
  setAgentKillStateReader,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import { createAgentKillSwitchManager } from "../claustrum/agent-kill-switch.js";

type Bundle = PolicyBundle<string, unknown, unknown>;

const AGENT_SESSION = agentSessionId(PIX_REMEDIATION_AGENT, "ord_001");

// ── In-memory Redis (read/write) + pub/sub fakes ─────────────────────────────

function fakeRedis(): RedisLedgerClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async set(key, value, opts) {
      if (opts?.NX === true && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

function fakePubSub(): RedisPubSubClient & {
  handlers: Map<string, Set<(m: string) => void>>;
} {
  const handlers = new Map<string, Set<(m: string) => void>>();
  return {
    handlers,
    async publish(channel, message) {
      const hs = handlers.get(channel);
      if (hs) for (const h of [...hs]) h(message);
      return hs?.size ?? 0;
    },
    async subscribe(channel, handler) {
      let set = handlers.get(channel);
      if (set === undefined) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return async () => {
        set!.delete(handler);
      };
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

// ── Production composition fixtures (mirroring agent-guards.test.ts) ─────────

function composedBundle(pack: unknown): Bundle {
  return buildIbatexasPolicyPacks([pack as ErasedPack])[0]!.policy as Bundle;
}

function regenerateEnvelope(sessionId: string) {
  return buildEnvelope({
    kind: "payment.pix.regenerate",
    payload: { orderId: "ord_001" },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: "nonce-regen-kill",
  });
}

function regenerateState(extraCtx: Record<string, unknown> = {}) {
  return {
    ctx: {
      tenantId: "ibatexas",
      channel: "web",
      customerId: "cust_001",
      isAuthenticated: true,
      orderId: "ord_001",
      exists: true,
      currentStatus: "payment_failed",
      currentMethod: "pix",
      isTerminal: false,
      refundedAmountCentavos: 0,
      amountInCentavos: 5_000,
      regenerationCount: 0,
      sessionTokensConsumed: 0,
      ...extraCtx,
    },
  };
}

// The kill guard reads a MODULE-GLOBAL reader; always reset it so a killed
// state never leaks into a later test in this file.
afterEach(() => setAgentKillStateReader(() => false));

// ── Manager: trip/clear propagate to isKilled ────────────────────────────────

describe("AgentKillSwitchManager", () => {
  it("starts not-killed, then trip()/clear() flip isKilled via pub/sub", async () => {
    const manager = createAgentKillSwitchManager({
      registry: [PIX_REMEDIATION_AGENT],
      redis: fakeRedis(),
      pubsub: fakePubSub(),
      pollMs: 60_000, // rely on pub/sub for immediacy; large poll = no interference
    });
    await manager.start();
    try {
      expect(manager.isKilled(PIX_REMEDIATION_AGENT.sessionIdPrefix)).toBe(false);

      await manager.trip(PIX_REMEDIATION_AGENT.id, "ops: runaway remediation");
      await tick();
      expect(manager.isKilled(PIX_REMEDIATION_AGENT.sessionIdPrefix)).toBe(true);

      await manager.clear(PIX_REMEDIATION_AGENT.id);
      await tick();
      expect(manager.isKilled(PIX_REMEDIATION_AGENT.sessionIdPrefix)).toBe(false);
    } finally {
      await manager.stop();
    }
  });

  it("writes the kill state under the agent's rk(killSwitchKey) so any replica's poller converges", async () => {
    const redis = fakeRedis();
    const manager = createAgentKillSwitchManager({
      registry: [PIX_REMEDIATION_AGENT],
      redis,
      pubsub: fakePubSub(),
      pollMs: 60_000,
    });
    await manager.start();
    try {
      await manager.trip(PIX_REMEDIATION_AGENT.id, "ops");
      // The Redis payload carries the kernel-readable {active:true,...}.
      const written = [...redis.store.entries()].find(([k]) =>
        k.includes("agent:pix-payment-failure-remediation"),
      );
      expect(written).toBeDefined();
      expect(written![1]).toContain('"active":true');
    } finally {
      await manager.stop();
    }
  });

  it("trip() on an unknown agent id throws (fail-closed)", async () => {
    const manager = createAgentKillSwitchManager({
      registry: [PIX_REMEDIATION_AGENT],
      redis: fakeRedis(),
      pubsub: fakePubSub(),
      pollMs: 60_000,
    });
    await manager.start();
    try {
      await expect(manager.trip("no-such-agent", "x")).rejects.toThrow(/unknown/);
    } finally {
      await manager.stop();
    }
  });
});

// ── Kernel-side guard (unit) ─────────────────────────────────────────────────

describe("createAgentKillSwitchGuard", () => {
  it("REFUSEs a killed agent's envelope with code + kill.ACTIVE basis; passes live agents and non-agent traffic", () => {
    const killed = new Set([PIX_REMEDIATION_AGENT.sessionIdPrefix]);
    const guard = createAgentKillSwitchGuard((ns) => killed.has(ns));

    const refused = guard(regenerateEnvelope(AGENT_SESSION), {});
    expect(refused).not.toBeNull();
    if (refused === null || refused.kind !== "REFUSE") throw new Error("expected REFUSE");
    expect(refused.refusal.code).toBe(AGENT_KILL_SWITCH_REFUSAL_CODE);
    expect(refused.refusal.kind).toBe("SECURITY");
    expect(refused.basis[0]?.category).toBe("kill");
    expect(refused.basis[0]?.code).toBe("active");

    // Non-agent traffic (a real customer sessionId) is untouched.
    expect(guard(regenerateEnvelope("cust_001"), {})).toBeNull();
    // A live agent (not in the killed set) passes.
    const liveGuard = createAgentKillSwitchGuard(() => false);
    expect(liveGuard(regenerateEnvelope(AGENT_SESSION), {})).toBeNull();
  });
});

// ── End-to-end: flip stops the next trigger through the real kernel ──────────

describe("T3-5 acceptance — flipping the switch stops the next agent turn", () => {
  it("not-killed regenerate EXECUTEs; trip → REFUSE(kill); clear → EXECUTE again", async () => {
    const manager = createAgentKillSwitchManager({
      registry: [PIX_REMEDIATION_AGENT],
      redis: fakeRedis(),
      pubsub: fakePubSub(),
      pollMs: 60_000,
    });
    await manager.start();
    setAgentKillStateReader((ns) => manager.isKilled(ns));
    try {
      const bundle = composedBundle(paymentsPack);
      const env = () => regenerateEnvelope(AGENT_SESSION);

      // Live agent: the in-scope regenerate EXECUTEs (matches agent-guards T3-4).
      expect(adjudicate(env(), regenerateState(), bundle).kind).toBe("EXECUTE");

      // Flip the switch → the very next turn REFUSEs with the kill basis, even
      // though the kind is in-scope and the state would otherwise EXECUTE.
      await manager.trip(PIX_REMEDIATION_AGENT.id, "ops: emergency stop");
      await tick();
      const killedDecision = adjudicate(env(), regenerateState(), bundle);
      expect(killedDecision.kind).toBe("REFUSE");
      if (killedDecision.kind !== "REFUSE") throw new Error("unreachable");
      expect(killedDecision.refusal.code).toBe(AGENT_KILL_SWITCH_REFUSAL_CODE);
      expect(killedDecision.basis.some((b) => b.category === "kill")).toBe(true);

      // Clear → back to normal operation.
      await manager.clear(PIX_REMEDIATION_AGENT.id);
      await tick();
      expect(adjudicate(env(), regenerateState(), bundle).kind).toBe("EXECUTE");
    } finally {
      await manager.stop();
    }
  });
});
