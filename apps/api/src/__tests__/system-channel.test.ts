// T3-1 — SystemChannel ChannelDriver (adopter-side, channel kind "system").
//
// Two layers:
//
//  1. Driver units: perceive() normalization + rejection contract (the
//     `${sourceSubject}:${eventId}` externalId IS the deterministic-nonce
//     carrier — defaulting any of its inputs would corrupt replay dedup),
//     the byte-pinned deterministic perception template, render()-journals-
//     never-delivers, attest() HMAC round-trip, matchToParked ≡ null.
//
//  2. Acceptance: one FULL turn (openCapsule → handleTurn → closeCapsule →
//     render) through a Conductor composed WITH the SystemChannel, driven by
//     the T2-6b content-keyed scripted ModelProvider at zero tokens. The
//     scripted fixture's request content embeds the EXPECTED perception text
//     as a hardcoded literal — NOT derived via renderTriggerPerceptionText —
//     so a template drift breaks the content key loudly (the same property
//     the golden-conversation suite pins for chat prompts). Asserted:
//     perception.externalId shape at the planner seam, channel "system"
//     end-to-end, the deterministic trigger nonce on the adjudicated
//     envelope, exactly one tool execution for EXECUTE, and DR-4 sessionKey
//     threading (sessionKeyAwareLockKey composition locks the caller-named
//     entity domain `web:<customerId>`; the default composition locks
//     `system:<customerId>` — threading is composition-supplied).
//
// The production conductor is deliberately NOT touched (T3-6 owns the shadow
// composition): the Conductor here is test-local, mirroring the upstream
// T3-0 trigger-vs-chat serialization harness stubs against claustrum 0.3.0.

import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  type AuditRecord,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  asCapability,
  createConductor,
  createToolRegistry,
  handleTurn,
  sessionKeyAwareLockKey,
  verifyGatewayAttestation,
  type Adjudicator,
  type AuditVerification,
  type CognitiveState,
  type Conductor,
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
} from "@claustrum/core";
import {
  SystemChannel,
  isTriggerEvent,
  renderTriggerPerceptionText,
  triggerConversationId,
  triggerExternalId,
  type SystemRenderJournalEntry,
  type TriggerEvent,
} from "../claustrum/system-channel.js";
import { createScriptedModelProvider } from "./helpers/scripted-model-provider.js";

// ── Synthetic trigger (the acceptance event) ─────────────────────────────────

const FIXED_NOW = "2026-06-12T12:00:00.000Z";
const CUSTOMER = "cus_t31";
// D-017 agent identity format: `agent:<id>@<ver>:entity:<entityId>`, the
// UNHASHED `agent:` prefix the T1b-3/T2-4 namespace filters expect.
const AGENT_SESSION_ID = `agent:pix-remediation@0.1.0:entity:${CUSTOMER}`;

const SIGNING_KEY =
  "ibx-test-system-gateway-signing-key-0123456789abcdef0123456789abcdef";
const GATEWAY = "ibatexas-agent-host-test";

const TRIGGER: TriggerEvent = {
  sourceSubject: "ibatexas.payment.status_changed",
  eventId: "evt-pix-0001",
  kind: "payment.status_changed",
  payload: {
    paymentId: "pay_123",
    orderId: "ord_456",
    newStatus: "failed",
    method: "pix",
  },
  entityRef: { kind: "order", id: "ord_456", customerId: CUSTOMER },
  occurredAt: FIXED_NOW,
};

// HARDCODED expected rendering (deliberately not derived from
// renderTriggerPerceptionText — this literal is the template pin; the
// payload line is the kernel's canonicalJson, key-sorted).
const EXPECTED_PERCEPTION_TEXT = [
  "system trigger: payment.status_changed",
  "subject: ibatexas.payment.status_changed",
  "event-id: evt-pix-0001",
  "entity: order ord_456",
  "customer: cus_t31",
  "occurred-at: 2026-06-12T12:00:00.000Z",
  'payload: {"method":"pix","newStatus":"failed","orderId":"ord_456","paymentId":"pay_123"}',
].join("\n");

const EXPECTED_EXTERNAL_ID = "ibatexas.payment.status_changed:evt-pix-0001";

function makeDriver(journal?: (entry: SystemRenderJournalEntry) => void) {
  return new SystemChannel({
    gatewaySigningKey: SIGNING_KEY,
    gateway: GATEWAY,
    ...(journal !== undefined ? { journal } : {}),
  });
}

// ── Driver units ─────────────────────────────────────────────────────────────

describe("SystemChannel.perceive", () => {
  it("normalizes a synthetic payment.status_changed trigger into an inbound ChannelMessage", async () => {
    const inbound = await makeDriver().perceive(TRIGGER);

    expect(inbound.channel).toBe("system");
    expect(inbound.customerId).toBe(CUSTOMER);
    expect(inbound.conversationId).toBe(
      "trigger:payment.status_changed:order:ord_456",
    );
    // THE per-turn deterministic-nonce carrier (T3-2's deriveNonce input).
    expect(inbound.externalId).toBe(EXPECTED_EXTERNAL_ID);
    expect(inbound.externalId).toBe(
      `${TRIGGER.sourceSubject}:${TRIGGER.eventId}`,
    );
    expect(inbound.text).toBe(EXPECTED_PERCEPTION_TEXT);
    expect(inbound.receivedAt).toBe(FIXED_NOW);
    expect(inbound.raw).toBe(TRIGGER);
  });

  it("is deterministic: re-perceiving the same event yields byte-identical text and externalId (redelivery stability)", async () => {
    const driver = makeDriver();
    const first = await driver.perceive(TRIGGER);
    const second = await driver.perceive({ ...TRIGGER });
    expect(second.text).toBe(first.text);
    expect(second.externalId).toBe(first.externalId);
    expect(second.conversationId).toBe(first.conversationId);
    // The exported helpers agree with the driver (T3-2 reuses them).
    expect(triggerExternalId(TRIGGER)).toBe(first.externalId);
    expect(triggerConversationId(TRIGGER)).toBe(first.conversationId);
    expect(renderTriggerPerceptionText(TRIGGER)).toBe(first.text);
  });

  it("omits the occurred-at line and falls back to now() for receivedAt when the event has no occurredAt", async () => {
    const { occurredAt: _dropped, ...withoutOccurredAt } = TRIGGER;
    const inbound = await makeDriver().perceive(withoutOccurredAt);
    expect(inbound.text).not.toContain("occurred-at:");
    expect(Number.isNaN(Date.parse(inbound.receivedAt))).toBe(false);
    // externalId is unaffected — the carrier never depends on wall clock.
    expect(inbound.externalId).toBe(EXPECTED_EXTERNAL_ID);
  });

  it("rejects structurally-invalid triggers (port rejection contract: every checked field feeds routing or the nonce carrier)", async () => {
    const driver = makeDriver();
    const invalid: ReadonlyArray<unknown> = [
      null,
      "payment.status_changed",
      {},
      { ...TRIGGER, eventId: "" },
      { ...TRIGGER, sourceSubject: undefined },
      { ...TRIGGER, kind: "" },
      { ...TRIGGER, payload: "not-an-object" },
      { ...TRIGGER, entityRef: undefined },
      { ...TRIGGER, entityRef: { ...TRIGGER.entityRef, customerId: "" } },
      { ...TRIGGER, entityRef: { ...TRIGGER.entityRef, id: "" } },
    ];
    for (const raw of invalid) {
      expect(isTriggerEvent(raw), JSON.stringify(raw)).toBe(false);
      await expect(driver.perceive(raw)).rejects.toThrow(
        /SystemChannel\.perceive/,
      );
    }
    expect(isTriggerEvent(TRIGGER)).toBe(true);
  });
});

describe("SystemChannel.render", () => {
  it("journals the rendered response to the injected sink — no outbound delivery surface exists", async () => {
    const entries: SystemRenderJournalEntry[] = [];
    const driver = makeDriver((entry) => entries.push(entry));

    await driver.render({
      channel: "system",
      customerId: CUSTOMER,
      conversationId: triggerConversationId(TRIGGER),
      text: "remediation turn complete",
      meta: { escalated: false },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      event: "system_channel.render",
      gateway: GATEWAY,
      channel: "system",
      customerId: CUSTOMER,
      conversationId: "trigger:payment.status_changed:order:ord_456",
      text: "remediation turn complete",
      meta: { escalated: false },
    });
  });
});

describe("SystemChannel.attest", () => {
  function envelopeFixture(): IntentEnvelope {
    return buildEnvelope({
      kind: "pix.regenerate",
      payload: { orderId: "ord_456" },
      actor: { principal: "system", sessionId: AGENT_SESSION_ID },
      taint: "SYSTEM",
      nonce: EXPECTED_EXTERNAL_ID,
    });
  }

  it("HMAC-signs the channel/gateway-enriched envelope; verifyGatewayAttestation round-trips", async () => {
    const driver = makeDriver();
    const envelope = envelopeFixture();
    const signed = await driver.attest(envelope);

    expect(signed.alg).toBe("HMAC-SHA256");
    expect(signed.keyId).toBe("system-gateway-default");
    const actor = signed.envelope.actor as typeof envelope.actor & {
      channel?: string;
      gateway?: string;
    };
    expect(actor.channel).toBe("system");
    expect(actor.gateway).toBe(GATEWAY);
    expect(actor.principal).toBe("system");
    expect(actor.sessionId).toBe(AGENT_SESSION_ID);
    // Enrichment is audit metadata only — the replay key is untouched.
    expect(signed.envelope.intentHash).toBe(envelope.intentHash);

    expect(verifyGatewayAttestation(signed, SIGNING_KEY)).toBe(true);
    // Tamper → fail; wrong key → fail.
    expect(
      verifyGatewayAttestation(
        {
          ...signed,
          envelope: { ...signed.envelope, nonce: "forged" } as IntentEnvelope,
        },
        SIGNING_KEY,
      ),
    ).toBe(false);
    expect(
      verifyGatewayAttestation(signed, `${SIGNING_KEY}-other`),
    ).toBe(false);
  });
});

describe("SystemChannel.matchToParked", () => {
  it("returns null unconditionally — trigger events carry no parked-reply semantics", async () => {
    const driver = makeDriver();
    const inbound = await driver.perceive(TRIGGER);
    const session: Session = {
      id: `system:${CUSTOMER}`,
      customerId: CUSTOMER,
      channel: "system",
      startedAt: FIXED_NOW,
      lastActivityAt: FIXED_NOW,
      pendingConfirmations: [],
      deferredEnvelopes: [],
      activeGoals: [],
      workingMemory: { summary: "", facts: [], updatedAt: FIXED_NOW },
    };
    expect(driver.matchToParked(inbound, session)).toBeNull();
  });
});

describe("SystemChannel constructor", () => {
  it("fails closed on a missing signing key or gateway", () => {
    expect(
      () => new SystemChannel({ gatewaySigningKey: "", gateway: GATEWAY }),
    ).toThrow(/gatewaySigningKey required/);
    expect(
      () =>
        new SystemChannel({ gatewaySigningKey: SIGNING_KEY, gateway: "" }),
    ).toThrow(/gateway required/);
  });
});

// ── Acceptance: one full turn through a Conductor composed with SystemChannel ─

// Scripted fixture surface. The planner fixture's request content embeds
// EXPECTED_PERCEPTION_TEXT verbatim: if the perception template drifts, the
// content key misses and the scripted provider throws loudly.
const PLANNER_SYSTEM =
  "T3-1 trigger planner (scripted test double): map the system-trigger perception to express_intent.";
const RESPONDER_SYSTEM =
  "T3-1 trigger responder (scripted test double): summarize the turn outcome for the run journal.";
const EXPRESS_INTENT_TOOL = {
  name: "express_intent",
  description: "Express a mutating intent as {capability, payload}.",
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string" },
      payload: { type: "object" },
    },
    required: ["capability", "payload"],
  },
};

interface Composition {
  readonly conductor: Conductor;
  readonly driver: SystemChannel;
  readonly provider: ReturnType<typeof createScriptedModelProvider>;
  readonly plannerSeen: CognitiveState[];
  readonly adjudicated: IntentEnvelope[];
  readonly executions: unknown[];
  readonly journal: SystemRenderJournalEntry[];
  readonly lockEvents: Array<{ op: "acquire" | "release"; key: string }>;
}

function makeComposition(opts: { sessionKeyAware: boolean }): Composition {
  const plannerSeen: CognitiveState[] = [];
  const adjudicated: IntentEnvelope[] = [];
  const executions: unknown[] = [];
  const journal: SystemRenderJournalEntry[] = [];
  const lockEvents: Array<{ op: "acquire" | "release"; key: string }> = [];

  const provider = createScriptedModelProvider({
    entries: [
      {
        label: "planner:pix-failed-trigger",
        request: {
          system: PLANNER_SYSTEM,
          messages: [{ role: "user", content: EXPECTED_PERCEPTION_TEXT }],
          tools: [EXPRESS_INTENT_TOOL],
        },
        response: {
          toolCalls: [
            {
              id: "tu_t31_1",
              name: "express_intent",
              input: {
                capability: "pix.regenerate",
                payload: { orderId: "ord_456", paymentId: "pay_123" },
              },
            },
          ],
        },
      },
      {
        label: "responder:remediation-trace",
        request: {
          system: RESPONDER_SYSTEM,
          messages: [{ role: "user", content: "decision=EXECUTE acted=executed" }],
        },
        response: { text: "remediation turn complete" },
      },
    ],
  });

  // Planner: records the CognitiveState it was handed (the perception seam
  // under test), then drives the scripted model and maps express_intent to a
  // kernel envelope. nonce = perception.externalId — the T3-2 deriveNonce
  // contract this channel exists to carry.
  const planner: PlannerPort = {
    async propose(cognition) {
      plannerSeen.push(cognition);
      const completion = await provider.complete({
        model: "scripted",
        system: PLANNER_SYSTEM,
        messages: [{ role: "user", content: cognition.perception.text }],
        tools: [EXPRESS_INTENT_TOOL],
      });
      const call = completion.toolCalls?.[0];
      if (call === undefined) return { envelopes: [] };
      const input = call.input as {
        capability: string;
        payload: Record<string, unknown>;
      };
      const envelope = buildEnvelope({
        kind: input.capability,
        payload: input.payload,
        actor: { principal: "system", sessionId: AGENT_SESSION_ID },
        taint: "SYSTEM",
        nonce: cognition.perception.externalId ?? "missing-external-id",
      });
      return { envelopes: [envelope], capabilities: [input.capability] };
    },
  };

  const responder: ResponderPort = {
    async respond({ decision, acted }) {
      const actedKind = (acted as { kind?: string } | undefined)?.kind ?? "none";
      const completion = await provider.complete({
        model: "scripted",
        system: RESPONDER_SYSTEM,
        messages: [
          { role: "user", content: `decision=${decision.kind} acted=${actedKind}` },
        ],
      });
      return { text: completion.text };
    },
  };

  const adjudicator: Adjudicator = {
    async adjudicate(
      envelope: IntentEnvelope,
      _state: SystemState,
      _policy: PolicyBundle,
    ): Promise<Decision> {
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
          return {
            async next() {
              return { value: undefined, done: true as const };
            },
          };
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

  const tools = createToolRegistry();
  const pixRegenerate = asCapability("pix.regenerate");
  if (pixRegenerate === undefined) throw new Error("unreachable");
  tools.register({
    id: "test:pix.regenerate.recorder",
    capability: pixRegenerate,
    description: "T3-1 test executor — records invocations only",
    inputSchema: {},
    outputSchema: {},
    intentKind: "pix.regenerate" as IntentKind,
    riskLevel: "low",
    execute: async (input) => {
      executions.push(input);
      return { ok: true };
    },
  });

  const sessions = new Map<string, Session>();
  const session: SessionPort = {
    async load(customerId, channel) {
      const key = `${channel}:${customerId}`;
      const existing = sessions.get(key);
      if (existing !== undefined) return existing;
      const fresh: Session = {
        id: key,
        customerId,
        channel,
        startedAt: FIXED_NOW,
        lastActivityAt: FIXED_NOW,
        pendingConfirmations: [],
        deferredEnvelopes: [],
        activeGoals: [],
        workingMemory: { summary: "", facts: [], updatedAt: FIXED_NOW },
      };
      sessions.set(key, fresh);
      return fresh;
    },
    async save(s) {
      sessions.set(s.id, s);
    },
    async parkPendingConfirmation() {},
    async parkDeferred() {},
    async unpark() {},
  };

  const memory: MemoryPort = {
    async recall(customerId) {
      return {
        customerId,
        episodic: [],
        semantic: [],
        procedural: [],
        relational: [],
        assembledAt: FIXED_NOW,
      };
    },
    async observe() {},
    async search() {
      return [];
    },
    async recentActions() {
      return [];
    },
  };

  const grounding: GroundingPort = {
    async retrieve() {
      return { docs: [], retrievedAt: FIXED_NOW, modelId: "scripted" };
    },
    async attestGrounding() {
      return [];
    },
  };

  const tenantResolver: TenantResolver = {
    async resolve() {
      return {
        tenant: {
          tenantId: "ibatexas-test",
          displayName: "IbateXas T3-1",
          locale: "pt-BR",
          environment: "dev",
        },
        state: {},
        policy: {},
      };
    },
  };

  const sessionLock: SessionLock = {
    async acquire(key) {
      lockEvents.push({ op: "acquire", key });
      return {
        key,
        async release() {
          lockEvents.push({ op: "release", key });
        },
      };
    },
  };

  const driver = makeDriver((entry) => journal.push(entry));

  const conductor = createConductor({
    adjudicator,
    memory,
    grounding,
    planner,
    responder,
    explainer: { render: (r) => r.userFacing },
    handoff: { async queue() {} },
    telemetry: {
      async emitTurn() {},
      async emitLLMTrace() {},
      async emitMemoryAccess() {},
    },
    session,
    tools,
    channels: [driver],
    tenantResolver,
    sessionLock,
    ...(opts.sessionKeyAware ? { lockKeyStrategy: sessionKeyAwareLockKey } : {}),
  });

  return {
    conductor,
    driver,
    provider,
    plannerSeen,
    adjudicated,
    executions,
    journal,
    lockEvents,
  };
}

describe("acceptance — full turn through a Conductor composed with SystemChannel", () => {
  it("opens a capsule from the synthetic payment.status_changed trigger and runs one kernel-gated turn at zero tokens", async () => {
    const setup = makeComposition({ sessionKeyAware: true });

    // The conductor routes channel kind "system" to this driver.
    expect(setup.conductor.channels.system).toBe(setup.driver);

    const inbound = await setup.driver.perceive(TRIGGER);
    const capsule = await setup.conductor.openCapsule({
      channel: "system",
      customerId: CUSTOMER,
      // DR-4: the trigger turn names the entity-scoped serialization domain
      // (the customer's chat lock key) as its sessionKey.
      sessionKey: `web:${CUSTOMER}`,
      actor: {
        principal: "system",
        role: "system",
        sessionId: AGENT_SESSION_ID,
        customerId: CUSTOMER,
      },
      inbound,
    });

    try {
      expect(capsule.channel).toBe("system");
      expect(capsule.actor.sessionId).toBe(AGENT_SESSION_ID);
      expect(capsule.conversationId).toBe(
        "trigger:payment.status_changed:order:ord_456",
      );

      const result = await handleTurn(capsule, inbound);

      // Perception seam: the planner saw channel "system" and THE carrier.
      expect(setup.plannerSeen).toHaveLength(1);
      const perception = setup.plannerSeen[0]!.perception;
      expect(perception.channel).toBe("system");
      expect(perception.externalId).toBe(EXPECTED_EXTERNAL_ID);
      expect(perception.externalId).toBe(
        `${TRIGGER.sourceSubject}:${TRIGGER.eventId}`,
      );

      // Content-key proof: both scripted entries resolved — the perception
      // template reached the model byte-for-byte (planner fixture embeds the
      // hardcoded literal), and the synthesize leg ran.
      expect(setup.provider.calls.map((c) => c.label)).toEqual([
        "planner:pix-failed-trigger",
        "responder:remediation-trace",
      ]);

      // Kernel seam: adjudicated exactly once; the envelope carries the
      // deterministic trigger nonce (perception.externalId) and the agent
      // actor identity (unhashed `agent:` prefix, D-017).
      expect(setup.adjudicated).toHaveLength(1);
      expect(setup.adjudicated[0]!.nonce).toBe(EXPECTED_EXTERNAL_ID);
      expect(setup.adjudicated[0]!.actor.sessionId).toBe(AGENT_SESSION_ID);
      expect(setup.adjudicated[0]!.kind).toBe("pix.regenerate");

      // EXECUTE → exactly one tool invocation with the planned payload.
      expect(result.decision.kind).toBe("EXECUTE");
      expect(result.acted.kind).toBe("executed");
      expect(setup.executions).toEqual([
        { orderId: "ord_456", paymentId: "pay_123" },
      ]);

      // The response goes back out as a JOURNAL entry, never a delivery.
      expect(result.response.channel).toBe("system");
      await setup.driver.render(result.response);
      expect(setup.journal).toHaveLength(1);
      expect(setup.journal[0]).toMatchObject({
        event: "system_channel.render",
        channel: "system",
        customerId: CUSTOMER,
        conversationId: "trigger:payment.status_changed:order:ord_456",
        text: "remediation turn complete",
      });
    } finally {
      await setup.conductor.closeCapsule(capsule);
    }

    // sessionKey threading: this composition installs sessionKeyAwareLockKey,
    // so the supplied sessionKey IS the lock key — the trigger turn serialized
    // in the caller-named entity domain and released it on close.
    expect(setup.lockEvents).toEqual([
      { op: "acquire", key: `web:${CUSTOMER}` },
      { op: "release", key: `web:${CUSTOMER}` },
    ]);
  });

  it("default composition (no lockKeyStrategy): the same turn locks the channel-scoped key — sessionKey threading is composition-supplied", async () => {
    const setup = makeComposition({ sessionKeyAware: false });
    const inbound = await setup.driver.perceive(TRIGGER);
    const capsule = await setup.conductor.openCapsule({
      channel: "system",
      customerId: CUSTOMER,
      sessionKey: `web:${CUSTOMER}`,
      actor: {
        principal: "system",
        role: "system",
        sessionId: AGENT_SESSION_ID,
        customerId: CUSTOMER,
      },
      inbound,
    });
    try {
      const result = await handleTurn(capsule, inbound);
      expect(result.decision.kind).toBe("EXECUTE");
    } finally {
      await setup.conductor.closeCapsule(capsule);
    }
    // Default defaultLockKey ignores sessionKey: `${channel}:${customerId}`.
    expect(setup.lockEvents).toEqual([
      { op: "acquire", key: `system:${CUSTOMER}` },
      { op: "release", key: `system:${CUSTOMER}` },
    ]);
  });
});
