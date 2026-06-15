// T3-9 — agent plane composition + the T3-5 host-side kill check.

import { describe, expect, it, vi } from "vitest";
import { PIX_REMEDIATION_AGENT, agentSessionId } from "@ibatexas/agents";
import type { TriggerEvent } from "../claustrum/system-channel.js";
import type {
  TriggerDedupRedis,
  TriggerTurnInput,
  TriggerTurnRunner,
} from "../claustrum/agent-trigger-bridge.js";
import {
  composeAgentPlane,
  killGuardedRunner,
} from "../claustrum/agent-plane.js";
import type { AgentKillSwitchManager } from "../claustrum/agent-kill-switch.js";
import type { AgentApprovalEngine } from "../claustrum/agent-approvals.js";

const ORDER = "ord_456";
const AGENT_SESSION = agentSessionId(PIX_REMEDIATION_AGENT, ORDER);

function triggerInput(): TriggerTurnInput {
  const event: TriggerEvent = {
    sourceSubject: "ibatexas.payment.status_changed",
    eventId: "evt-1",
    kind: "payment.status_changed",
    payload: { orderId: ORDER },
    entityRef: { kind: "order", id: ORDER, customerId: "cus_1" },
  };
  return {
    agent: PIX_REMEDIATION_AGENT,
    event,
    sessionId: AGENT_SESSION,
    signal: new AbortController().signal,
    maxModelCalls: 4,
  };
}

describe("killGuardedRunner — T3-5 host-side pre-openCapsule check", () => {
  it("delegates to the inner runner when the agent is live", async () => {
    const inner = vi.fn<TriggerTurnRunner>(async () => ({
      decisionKind: "EXECUTE",
      modelCalls: 1,
    }));
    const guarded = killGuardedRunner(inner, () => false);

    const result = await guarded(triggerInput());

    expect(result).toEqual({ decisionKind: "EXECUTE", modelCalls: 1 });
    expect(inner).toHaveBeenCalledOnce();
  });

  it("suppresses (no capsule, no model call) when the agent is killed", async () => {
    const inner = vi.fn<TriggerTurnRunner>(async () => ({
      decisionKind: "EXECUTE",
      modelCalls: 1,
    }));
    // Killed for exactly this agent's namespace.
    const guarded = killGuardedRunner(
      inner,
      (ns) => ns === PIX_REMEDIATION_AGENT.sessionIdPrefix,
    );

    const result = await guarded(triggerInput());

    expect(result).toEqual({ decisionKind: "REFUSE", modelCalls: 0 });
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("composeAgentPlane — wiring", () => {
  it("composes the bridge over the injected runner and exposes killSwitch + approvals", () => {
    const killSwitch = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isKilled: () => false,
      trip: async () => {},
      clear: async () => {},
    } satisfies AgentKillSwitchManager;
    const approvals = {} as AgentApprovalEngine;
    const redis = {} as TriggerDedupRedis;

    const plane = composeAgentPlane({
      registry: [PIX_REMEDIATION_AGENT],
      runner: async () => ({ decisionKind: "EXECUTE", modelCalls: 1 }),
      killSwitch,
      approvals,
      redis,
      mapEvent: () => null,
    });

    expect(plane.bridge).toBeDefined();
    expect(plane.killSwitch).toBe(killSwitch);
    expect(plane.approvals).toBe(approvals);
    expect(typeof plane.start).toBe("function");
    expect(typeof plane.stop).toBe("function");
  });
});
