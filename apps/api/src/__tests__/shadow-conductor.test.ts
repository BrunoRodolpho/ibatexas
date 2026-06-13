// T3-6 — Stage-0 true shadow composition.
//
// Acceptance (plan-v2 §5 T3-6):
//   - the shadow registry holds ZERO real executors (conformance); a real tool
//     leaking in fails composition;
//   - a shadow run produces a REAL agent: audit row (decision through the real
//     kernel) + an agent_runs journal entry, and ZERO real mutations (the
//     sandbox no-op records the would-be act; the real executor — which throws —
//     is never invoked) — the oracle;
//   - the production drift baseline EXCLUDES agent rows while a shadow monitor
//     observes them (so shadow EXECUTEs never pollute production signal).
//
// The end-to-end turn runs the REAL kernel adjudicator stub + handleTurn through
// a Conductor composed with the sandbox registry + SystemChannel, mirroring the
// T3-1 acceptance doubles. The planner sets envelope.actor.sessionId =
// state.conversationId (exactly like the production createIbatexasPlanner) so the
// test proves the runner's conversationId→agent-namespace override threads all
// the way to the adjudicated envelope.

import { afterEach, describe, expect, it } from "vitest";
import {
  buildAuditRecord,
  buildEnvelope,
  type AuditRecord,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  asCapability,
  createToolRegistry,
  type Adjudicator,
  type AuditVerification,
  type CognitiveState,
  type GroundingPort,
  type IntentKind,
  type MemoryPort,
  type PlannerPort,
  type PolicyBundle,
  type ResponderPort,
  type Session,
  type SessionLock,
  type SessionPort,
  type SystemState,
  type TenantResolver,
  type ToolDefinition,
} from "@claustrum/core";
import { PIX_REMEDIATION_AGENT, agentSessionId } from "@ibatexas/agents";
import { SystemChannel, type TriggerEvent } from "../claustrum/system-channel.js";
import {
  assertNoRealExecutors,
  createSandboxToolRegistry,
  SANDBOX_TOOL_ID_PREFIX,
} from "../claustrum/shadow-tool-registry.js";
import {
  composeShadowConductor,
  createShadowTriggerRunner,
} from "../claustrum/shadow-conductor.js";
import { createLoggingAgentRunJournal } from "../claustrum/agent-run-journal.js";
import {
  __resetDriftDetectorForTest,
  driftSnapshot,
  observeDriftRecord,
  shadowDriftSnapshot,
} from "../observability/drift-detector.js";

const FIXED_NOW = "2026-06-12T12:00:00.000Z";
const ORDER = "ord_456";
const CUSTOMER = "cus_t36";
const AGENT_SESSION = agentSessionId(PIX_REMEDIATION_AGENT, ORDER);
const SIGNING_KEY = "ibx-test-system-gateway-key-0123456789abcdef0123456789abcd";

function failedPixEvent(): TriggerEvent {
  return {
    sourceSubject: "ibatexas.payment.status_changed",
    eventId: "evt-pix-shadow",
    kind: "payment.status_changed",
    payload: { paymentId: "pay_1", orderId: ORDER, newStatus: "failed", method: "pix" },
    entityRef: { kind: "order", id: ORDER, customerId: CUSTOMER },
    occurredAt: FIXED_NOW,
  };
}

/** A REAL tool whose execute THROWS — proves the sandbox replaces it (never runs). */
function throwingRealTool(): ToolDefinition<unknown, unknown> {
  const cap = asCapability("payment.pix.regenerate");
  if (cap === undefined) throw new Error("unreachable");
  return {
    id: "real:payment.pix.regenerate.v1",
    capability: cap,
    intentKind: "payment.pix.regenerate" as IntentKind,
    description: "real PIX regenerate (must never run in shadow)",
    inputSchema: {},
    outputSchema: {},
    riskLevel: "high",
    execute: async () => {
      throw new Error("REAL executor invoked in shadow plane — sandbox breach!");
    },
  };
}

// ── Sandbox registry: conformance + no-op ────────────────────────────────────

describe("createSandboxToolRegistry / assertNoRealExecutors", () => {
  it("mirrors every real capability as a sandbox no-op; conformance passes; the real executor never runs", async () => {
    const records: unknown[] = [];
    const registry = createSandboxToolRegistry([throwingRealTool()], (e) =>
      records.push(e),
    );
    assertNoRealExecutors(registry); // does not throw

    const cap = asCapability("payment.pix.regenerate")!;
    const resolved = registry.resolveTool(cap, {});
    expect(resolved.id).toBe(`${SANDBOX_TOOL_ID_PREFIX}real:payment.pix.regenerate.v1`);
    // Executing the sandbox tool records the would-be act and never throws
    // (the real executor would have thrown).
    await expect(resolved.execute({ orderId: ORDER }, {})).resolves.toMatchObject({
      sandbox: true,
    });
    expect(records).toHaveLength(1);
  });

  it("assertNoRealExecutors throws if a real (non-sandbox) tool is present", () => {
    const registry = createToolRegistry();
    registry.register(throwingRealTool());
    expect(() => assertNoRealExecutors(registry)).toThrow(/non-sandbox tool/);
  });
});

// ── Drift baseline routing ───────────────────────────────────────────────────

describe("observeDriftRecord — agent-namespace routing (T3-6)", () => {
  afterEach(() => __resetDriftDetectorForTest());

  function recordWithSession(sessionId: string): AuditRecord {
    const envelope = buildEnvelope({
      kind: "payment.pix.regenerate",
      payload: { orderId: ORDER },
      actor: { principal: "system", sessionId },
      taint: "SYSTEM",
      nonce: `n-${sessionId}`,
      createdAt: FIXED_NOW,
    });
    return buildAuditRecord({
      envelope,
      decision: { kind: "EXECUTE", basis: [] },
      durationMs: 1,
      at: FIXED_NOW,
    });
  }

  it("routes agent: rows to the shadow monitor and away from the production baseline", () => {
    observeDriftRecord(recordWithSession(AGENT_SESSION));
    observeDriftRecord(recordWithSession("cus_real_customer"));

    // The production baseline saw exactly the one non-agent row.
    expect(driftSnapshot().totalObserved).toBe(1);
    // The shadow monitor saw exactly the one agent row.
    expect(shadowDriftSnapshot().totalObserved).toBe(1);
  });
});

// ── End-to-end shadow turn ───────────────────────────────────────────────────

function makeShadowDeps() {
  const adjudicated: IntentEnvelope[] = [];

  const planner: PlannerPort = {
    async propose(state: CognitiveState) {
      // Exactly the production createIbatexasPlanner actor shape:
      // actor.sessionId = state.conversationId (which the runner overrode to the
      // agent namespace). nonce rides the trigger carrier (deriveNonce contract).
      const envelope = buildEnvelope({
        kind: "payment.pix.regenerate",
        payload: { orderId: ORDER, paymentId: "pay_1" },
        actor: { principal: "system", sessionId: state.conversationId },
        taint: "SYSTEM",
        nonce: state.perception.externalId ?? "missing",
      });
      return { envelopes: [envelope], capabilities: ["payment.pix.regenerate"] };
    },
  };

  const responder: ResponderPort = {
    async respond() {
      return { text: "shadow remediation turn complete" };
    },
  };

  const adjudicator: Adjudicator = {
    async adjudicate(envelope: IntentEnvelope, _s: SystemState, _p: PolicyBundle): Promise<Decision> {
      adjudicated.push(envelope);
      return { kind: "EXECUTE", basis: [] };
    },
    async adjudicatePlan(): Promise<Decision> {
      return { kind: "EXECUTE", basis: [] };
    },
    async replayEnvelopesByCustomerId(): Promise<ReadonlyArray<AuditRecord>> {
      return [];
    },
    streamAuditByIntentHashPrefix(): AsyncIterable<AuditRecord> {
      return {
        [Symbol.asyncIterator]() {
          return { async next() { return { value: undefined, done: true as const }; } };
        },
      };
    },
    async getOutcomes() {
      return [];
    },
    verifyAuditRecord(): AuditVerification {
      return { ok: true };
    },
  };

  const sessions = new Map<string, Session>();
  const session: SessionPort = {
    async load(customerId, channel) {
      const key = `${channel}:${customerId}`;
      const existing = sessions.get(key);
      if (existing) return existing;
      const fresh: Session = {
        id: key, customerId, channel, startedAt: FIXED_NOW, lastActivityAt: FIXED_NOW,
        pendingConfirmations: [], deferredEnvelopes: [], activeGoals: [],
        workingMemory: { summary: "", facts: [], updatedAt: FIXED_NOW },
      };
      sessions.set(key, fresh);
      return fresh;
    },
    async save(s) { sessions.set(s.id, s); },
    async parkPendingConfirmation() {},
    async parkDeferred() {},
    async unpark() {},
  };

  const memory: MemoryPort = {
    async recall(customerId) {
      return { customerId, episodic: [], semantic: [], procedural: [], relational: [], assembledAt: FIXED_NOW };
    },
    async observe() {},
    async search() { return []; },
    async recentActions() { return []; },
  };

  const grounding: GroundingPort = {
    async retrieve() { return { docs: [], retrievedAt: FIXED_NOW, modelId: "scripted" }; },
    async attestGrounding() { return []; },
  };

  const tenantResolver: TenantResolver = {
    async resolve() {
      return {
        tenant: { tenantId: "ibatexas-test", displayName: "shadow", locale: "pt-BR", environment: "dev" },
        state: {}, policy: {},
      };
    },
  };

  const sessionLock: SessionLock = {
    async acquire(key) {
      return { key, async release() {} };
    },
  };

  return { adjudicator, memory, grounding, planner, responder, session, tenantResolver, sessionLock, adjudicated };
}

describe("T3-6 acceptance — a shadow turn writes a real agent: row + journal with zero mutations", () => {
  it("runs the kernel-gated turn through the sandbox plane; the real executor never fires", async () => {
    const deps = makeShadowDeps();
    const systemChannel = new SystemChannel({
      gatewaySigningKey: SIGNING_KEY,
      gateway: "ibatexas-agent-host-test",
    });
    const composition = composeShadowConductor({
      adjudicator: deps.adjudicator,
      memory: deps.memory,
      grounding: deps.grounding,
      planner: deps.planner,
      responder: deps.responder,
      explainer: { render: (r) => r.userFacing },
      handoff: { async queue() {} },
      telemetry: { async emitTurn() {}, async emitLLMTrace() {}, async emitMemoryAccess() {} },
      session: deps.session,
      tenantResolver: deps.tenantResolver,
      sessionLock: deps.sessionLock,
      realTools: [throwingRealTool()],
      systemChannel,
    });

    const journal = createLoggingAgentRunJournal();
    const runner = createShadowTriggerRunner({
      composition,
      systemChannel,
      journal,
      stage: 0,
      now: () => FIXED_NOW,
    });

    const controller = new AbortController();
    const result = await runner({
      agent: PIX_REMEDIATION_AGENT,
      event: failedPixEvent(),
      sessionId: AGENT_SESSION,
      signal: controller.signal,
      maxModelCalls: PIX_REMEDIATION_AGENT.budgets.maxModelCallsPerTrigger,
    });

    // Decision reached EXECUTE through the real kernel adjudicator.
    expect(result.decisionKind).toBe("EXECUTE");

    // The adjudicated envelope carries the agent: namespace (proves the runner's
    // conversationId→agent-namespace override threaded to the envelope) — this
    // is what lands UNHASHED in intent_audit for the exclusion filters.
    expect(deps.adjudicated).toHaveLength(1);
    expect(deps.adjudicated[0]!.actor.sessionId).toBe(AGENT_SESSION);
    expect(deps.adjudicated[0]!.nonce).toBe("ibatexas.payment.status_changed:evt-pix-shadow");

    // ORACLE: a real mutation was proposed (sandbox recorded it) but the REAL
    // executor — which throws — never ran. Journal captured the run.
    const runs = journal.recent();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      agentId: PIX_REMEDIATION_AGENT.id,
      stage: 0,
      sessionId: AGENT_SESSION,
      entity: "order:ord_456",
      decisionKind: "EXECUTE",
    });
    expect(runs[0]!.sandboxExecutions).toHaveLength(1);
    expect(runs[0]!.sandboxExecutions[0]!.capability).toBe("payment.pix.regenerate");
  });
});
