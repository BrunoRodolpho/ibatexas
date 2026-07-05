// Live agent conductor — the post-turn handling (B2 park-seam + agent_runs
// journal + intentKind derivation), tested with synthetic TurnResults so no
// real conductor/handleTurn is needed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentDefinition } from "@ibatexas/agents";
import type { IntentEnvelope } from "@adjudicate/core";
import type { ModelProvider, TurnResult } from "@claustrum/core";
import {
  composeLiveAgentConductor,
  deriveIntentKind,
  processLiveTurnResult,
  type LiveAgentConductorDeps,
  type LiveTriggerRunnerDeps,
} from "../claustrum/live-agent-conductor.js";
import type { TriggerTurnInput } from "../claustrum/agent-trigger-bridge.js";
import type { AgentRunRecord } from "../claustrum/agent-run-journal.js";
import type { RefundCircuitBreaker } from "../claustrum/agent-realmoney-safety.js";
import type { LearningEvent } from "../learning-sink-bootstrap.js";
import type { ClaimsSeams } from "../claustrum/claims-pipeline.js";
import type { ClaimAwarePlannerPort } from "../claustrum/ibatexas-planner.js";

// composeLiveAgentConductor delegates to @claustrum/core's createConductor; spy
// on it (keeping every other export real, e.g. sessionKeyAwareLockKey) so a test
// can inspect the composed ConductorOptions — the only way to observe that the
// claims-seam factory wraps the SAME planner the conductor plans with (Q6b).
const { createConductorSpy } = vi.hoisted(() => ({
  createConductorSpy: vi.fn((_opts: unknown) => ({
    openCapsule: async () => ({}),
    closeCapsule: async () => {},
  })),
}));
vi.mock("@claustrum/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claustrum/core")>();
  return { ...actual, createConductor: createConductorSpy };
});

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

  it("P4 producer seam: writes a remediation proposal on a successful park", async () => {
    const proposals: Array<{ proposalId: string; action: string; approvalToken: string }> = [];
    const { deps: d } = deps({
      proposalSink: (p) =>
        void proposals.push({ proposalId: p.proposalId, action: p.action, approvalToken: p.approvalToken }),
    });
    await processLiveTurnResult(d, INPUT, turn("REQUEST_CONFIRMATION", ["pix.charge.refund"]), 1);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      proposalId: "ibatexas.payment.status_changed:pay-1:failed",
      action: "pix.charge.refund",
      approvalToken: "t",
    });
  });

  it("P4 producer seam: NO proposal when the park is suppressed (breaker tripped)", async () => {
    const proposals: unknown[] = [];
    const tripped: RefundCircuitBreaker = { tryConsume: vi.fn(async () => false) };
    const { deps: d } = deps({
      refundBreaker: tripped,
      proposalSink: (p) => void proposals.push(p),
    });
    await processLiveTurnResult(d, INPUT, turn("REQUEST_CONFIRMATION", ["pix.charge.refund"]), 1);
    expect(proposals).toHaveLength(0);
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

  // ERDS-060 learning telemetry — emitted AFTER the journal, outside the kernel.
  it("emits a learning.event.v1 for the completed turn when a sink is wired", async () => {
    const events: LearningEvent[] = [];
    const { deps: d } = deps({
      learningSink: { recordLearningEvent: async (e) => void events.push(e) },
    });
    await processLiveTurnResult(d, INPUT, turn("EXECUTE", ["payment.pix.regenerate"]), 3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      at: "2026-06-14T00:00:00.000Z",
      agentId: "pix-payment-failure-remediation",
      sessionId: INPUT.sessionId,
      kind: "agent.turn",
      decisionKind: "EXECUTE",
      detail: { entity: "order:order-1", intentKind: "payment.pix.regenerate", modelCalls: 3 },
    });
  });

  it("a learning-sink failure is swallowed (turn unaffected)", async () => {
    const { deps: d, records } = deps({
      learningSink: {
        recordLearningEvent: async () => {
          throw new Error("learning boom");
        },
      },
    });
    const result = await processLiveTurnResult(
      d,
      INPUT,
      turn("EXECUTE", ["payment.pix.regenerate"]),
      1,
    );
    expect(result.decisionKind).toBe("EXECUTE");
    expect(records).toHaveLength(1); // journaled despite the learning emit failure
  });
});

// BKL-003 — the per-trigger claims-seam wiring. createConductor is spied (above),
// so a test can read the composed ConductorOptions the compose call produced.
describe("composeLiveAgentConductor — claims-seam wiring (BKL-003)", () => {
  const MODEL = {} as ModelProvider;

  /** Minimal deps for a compose — every port is inert because createConductor is
   *  mocked; only buildPlanner + the optional seam factory matter here. */
  function conductorDeps(
    over: Partial<LiveAgentConductorDeps> = {},
  ): LiveAgentConductorDeps {
    const base = {
      adjudicator: {},
      memory: {},
      grounding: {},
      explainer: {},
      handoff: {},
      telemetry: {},
      session: {},
      tenantResolver: {},
      sessionLock: {},
      tools: {},
      systemChannel: {},
      modelProvider: {},
      buildPlanner: () => ({}) as ClaimAwarePlannerPort,
      buildResponder: () => ({}),
    } as unknown as LiveAgentConductorDeps;
    return { ...base, ...over };
  }

  /** The last ConductorOptions createConductor was composed with. */
  function lastComposedOptions(): Record<string, unknown> {
    const call = createConductorSpy.mock.calls.at(-1);
    return (call?.[0] ?? {}) as Record<string, unknown>;
  }

  beforeEach(() => createConductorSpy.mockClear());

  it("passes the SAME planner instance to BOTH createConductor and the seam factory (Q6b)", () => {
    const planner = { proposeClaims() {} } as unknown as ClaimAwarePlannerPort;
    const seenByFactory: ClaimAwarePlannerPort[] = [];
    const d = conductorDeps({
      buildPlanner: () => planner,
      buildClaimsSeamsForPlanner: (p) => {
        seenByFactory.push(p);
        return { investigator: {} } as unknown as ClaimsSeams;
      },
    });
    composeLiveAgentConductor(d, MODEL);
    const opts = lastComposedOptions();
    expect(seenByFactory).toEqual([planner]); // the factory saw the planner
    expect(opts.planner).toBe(planner); // the conductor got the same instance
    expect(seenByFactory[0]).toBe(opts.planner); // identity across both surfaces
  });

  it("spreads the factory's seams into the conductor composition", () => {
    const investigator = { tag: "inv" };
    const d = conductorDeps({
      buildClaimsSeamsForPlanner: () =>
        ({ investigator }) as unknown as ClaimsSeams,
    });
    composeLiveAgentConductor(d, MODEL);
    expect(lastComposedOptions().investigator).toBe(investigator);
  });

  it("adds NO claims-seam keys when the factory is ABSENT (byte-identical)", () => {
    composeLiveAgentConductor(conductorDeps(), MODEL);
    const opts = lastComposedOptions();
    expect("investigator" in opts).toBe(false);
    expect("claimPlanner" in opts).toBe(false);
    expect("claimsKernel" in opts).toBe(false);
    expect("claimsRenderer" in opts).toBe(false);
  });

  it("adds NO keys when the factory returns {} (pipeline OFF path)", () => {
    const d = conductorDeps({
      buildClaimsSeamsForPlanner: () => ({}) as ClaimsSeams,
    });
    composeLiveAgentConductor(d, MODEL);
    const opts = lastComposedOptions();
    expect("investigator" in opts).toBe(false);
    expect("claimPlanner" in opts).toBe(false);
  });

  it("propagates a seam-factory throw (fail-closed: a broken registry refuses agent turns too)", () => {
    const d = conductorDeps({
      buildClaimsSeamsForPlanner: () => {
        throw new Error("claim registry invalid");
      },
    });
    expect(() => composeLiveAgentConductor(d, MODEL)).toThrow(
      "claim registry invalid",
    );
    // The throw happens BEFORE createConductor — no half-composed conductor.
    expect(createConductorSpy).not.toHaveBeenCalled();
  });
});
