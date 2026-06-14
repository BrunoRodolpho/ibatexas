// Live agent conductor — the post-turn handling (B2 park-seam + agent_runs
// journal + intentKind derivation), tested with synthetic TurnResults so no
// real conductor/handleTurn is needed.

import { describe, it, expect, vi } from "vitest";
import type { AgentDefinition } from "@ibatexas/agents";
import type { IntentEnvelope } from "@adjudicate/core";
import type { TurnResult } from "@claustrum/core";
import {
  deriveIntentKind,
  processLiveTurnResult,
  type LiveTriggerRunnerDeps,
} from "../claustrum/live-agent-conductor.js";
import type { TriggerTurnInput } from "../claustrum/agent-trigger-bridge.js";
import type { AgentRunRecord } from "../claustrum/agent-run-journal.js";
import type { RefundCircuitBreaker } from "../claustrum/agent-realmoney-safety.js";

const AGENT: AgentDefinition = {
  id: "pix-payment-failure-remediation",
  version: "0.1.0",
} as AgentDefinition;

const INPUT: TriggerTurnInput = {
  agent: AGENT,
  event: {
    sourceSubject: "ibatexas.payment.status_changed",
    eventId: "pay-1:failed",
    kind: "payment.status_changed",
    payload: {},
    entityRef: { kind: "order", id: "order-1", customerId: "cust-1" },
  },
  sessionId: "agent:pix-payment-failure-remediation@0.1.0:entity:order-1",
  signal: new AbortController().signal,
  maxModelCalls: 4,
};

function env(kind: string): IntentEnvelope {
  return {
    kind,
    actor: { principal: "llm", sessionId: INPUT.sessionId },
    payload: {},
    intentHash: "h",
    nonce: "n",
    taint: "UNTRUSTED",
  } as unknown as IntentEnvelope;
}

function turn(decisionKind: string, kinds: string[], prompt = "confirm?"): TurnResult {
  const decision =
    decisionKind === "REQUEST_CONFIRMATION"
      ? { kind: "REQUEST_CONFIRMATION", prompt, basis: [] }
      : { kind: decisionKind, basis: [] };
  return {
    decision,
    plan: { envelopes: kinds.map(env) },
  } as unknown as TurnResult;
}

function deps(over: Partial<LiveTriggerRunnerDeps> = {}): {
  deps: LiveTriggerRunnerDeps;
  records: AgentRunRecord[];
  requested: Array<{ kind: string }>;
} {
  const records: AgentRunRecord[] = [];
  const requested: Array<{ kind: string }> = [];
  const base: LiveTriggerRunnerDeps = {
    conductor: {} as LiveTriggerRunnerDeps["conductor"],
    systemChannel: {} as LiveTriggerRunnerDeps["systemChannel"],
    journal: { record: (r) => void records.push(r) },
    approvals: {
      request: async ({ envelope }) => {
        requested.push({ kind: envelope.kind });
        return { token: "t" } as never;
      },
      resolve: async () => ({}) as never,
      list: () => [],
      get: () => null,
    },
    now: () => "2026-06-14T00:00:00.000Z",
    ...over,
  };
  return { deps: base, records, requested };
}

describe("deriveIntentKind", () => {
  it("empty → ''", () => expect(deriveIntentKind([])).toBe(""));
  it("single → its kind", () =>
    expect(deriveIntentKind([env("pix.charge.refund")])).toBe("pix.charge.refund"));
  it("multi → joined with +", () =>
    expect(deriveIntentKind([env("a"), env("b")])).toBe("a+b"));
});

describe("processLiveTurnResult", () => {
  it("parks an approval on REQUEST_CONFIRMATION + journals the turn", async () => {
    const { deps: d, records, requested } = deps();
    const result = await processLiveTurnResult(
      d,
      INPUT,
      turn("REQUEST_CONFIRMATION", ["pix.charge.refund"]),
      2,
    );
    expect(result).toEqual({ decisionKind: "REQUEST_CONFIRMATION", modelCalls: 2 });
    expect(requested).toEqual([{ kind: "pix.charge.refund" }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      agentId: "pix-payment-failure-remediation",
      decisionKind: "REQUEST_CONFIRMATION",
      intentKind: "pix.charge.refund",
      externalId: "ibatexas.payment.status_changed:pay-1:failed",
      entity: "order:order-1",
      modelCalls: 2,
    });
  });

  it("does NOT park on a non-confirm decision (EXECUTE)", async () => {
    const { deps: d, records, requested } = deps();
    await processLiveTurnResult(d, INPUT, turn("EXECUTE", ["payment.pix.regenerate"]), 1);
    expect(requested).toEqual([]);
    expect(records[0]?.decisionKind).toBe("EXECUTE");
    expect(records[0]?.intentKind).toBe("payment.pix.regenerate");
  });

  it("real-money park is SUPPRESSED when the refund breaker trips", async () => {
    const tripped: RefundCircuitBreaker = { tryConsume: vi.fn(async () => false) };
    const { deps: d, requested } = deps({ refundBreaker: tripped });
    await processLiveTurnResult(d, INPUT, turn("REQUEST_CONFIRMATION", ["pix.charge.refund"]), 1);
    expect(tripped.tryConsume).toHaveBeenCalledWith("pix-payment-failure-remediation");
    expect(requested).toEqual([]); // breaker tripped → not parked
  });

  it("real-money park PROCEEDS when the breaker allows", async () => {
    const ok: RefundCircuitBreaker = { tryConsume: vi.fn(async () => true) };
    const { deps: d, requested } = deps({ refundBreaker: ok });
    await processLiveTurnResult(d, INPUT, turn("REQUEST_CONFIRMATION", ["pix.charge.refund"]), 1);
    expect(requested).toEqual([{ kind: "pix.charge.refund" }]);
  });

  it("a park failure is swallowed (the turn still journals)", async () => {
    const { deps: d, records } = deps({
      approvals: {
        request: async () => {
          throw new Error("park boom");
        },
        resolve: async () => ({}) as never,
        list: () => [],
        get: () => null,
      },
    });
    const result = await processLiveTurnResult(
      d,
      INPUT,
      turn("REQUEST_CONFIRMATION", ["pix.charge.refund"]),
      1,
    );
    expect(result.decisionKind).toBe("REQUEST_CONFIRMATION");
    expect(records).toHaveLength(1); // journaled despite the park failure
  });
});
