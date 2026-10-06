/**
 * BKL-216 — TURN-SEAM e2e: naming an order in an amend message must mutate THAT
 * order, through a full `handleTurn`.
 *
 * WHY THIS LEVEL (the repo's hard lesson, LE2-002): a resolver-level test can pass
 * while the feature is dead through the gate. The failure mode this file exists to
 * catch is precisely a threading one — the amend resolution now depends on the raw
 * utterance reaching `resolveAndAssemble` (via `ResolverPort.resolve` →
 * `cognition.perception.text`). Nothing below `handleTurn` proves the conductor
 * actually hands that text over, nor that the resolved orderId is what the kernel
 * adjudicates and the executor receives.
 *
 * Composition under test — production wiring except the leaves:
 *   - REAL `createIbatexasResolver()`      the resolve stage that carries the fix.
 *   - REAL composed policy router          `composePolicyRouter(buildIbatexasPolicyPacks(
 *                                          IBATEXAS_COMPOSED_PACKS))`, i.e. the same
 *                                          pack-orders guards production adjudicates
 *                                          against (so the CLARIFY arm proves the guard
 *                                          is WIRED, not merely unit-correct).
 *   - REAL kernel `adjudicate()`           the decision is a real kernel verdict.
 *   - fake planner                         emits the amend envelope with NO orderId,
 *                                          with production's customer-plane actor shape
 *                                          (`principal: "llm"`, sessionId = conversationId).
 *   - spy executor                         captures the orderId the mutation lands on.
 *   - mocked `@ibatexas/domain`            two OWNED orders (owner-scoped read), no DB.
 *
 * Zero model tokens: the planner/responder ports are fakes, no ModelProvider exists.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope, type Decision, type IntentEnvelope } from "@adjudicate/core";
import {
  asCapability,
  createConductor,
  createToolRegistry,
  handleTurn,
  type Adjudicator,
  type AuditVerification,
  type ChannelDriver,
  type ChannelMessage,
  type Conductor,
  type GroundingPort,
  type IntentKind,
  type MemoryPort,
  type PlannerPort,
  type ResponderPort,
  type Session,
  type SessionPort,
  type TenantResolver,
} from "@claustrum/core";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";

// ── Mutable domain-read controls (no DB; the owner-scoped reads are mocked) ───

const CUSTOMER = "cus_bkl216";
const NEWEST = { id: "ord_newest", displayId: 960763 };
const OLDER = { id: "ord_older", displayId: 933869 };

/** `listByCustomer` is OWNER-SCOPED: it only ever returns THIS customer's orders,
 *  which is what makes the in-message reference match IDOR-safe. Most-recent first. */
const orderListByCustomer: (
  cid: string,
) => Promise<{ orders: unknown[]; count: number }> = async () => ({
  orders: [
    { ...NEWEST, customerId: CUSTOMER, fulfillmentStatus: "preparing" },
    { ...OLDER, customerId: CUSTOMER, fulfillmentStatus: "preparing" },
  ],
  count: 2,
});

/** The stored OrderProjection read (`loadOrderCtx`) — customer-scoped ownership
 *  confirmation for the kernel authority graph. */
const orderGetById: (id: string) => Promise<unknown> = async () => ({
  customerId: CUSTOMER,
  paymentMethod: "pix",
  paymentStatus: "paid",
  fulfillmentStatus: "preparing",
  totalInCentavos: 8_900,
});

/** The LIVE order fetch the granular amend uses to resolve `itemId` from a title
 *  (`resolveOrderLineItem`). Records WHICH order was fetched — a second, independent
 *  witness that the named order (not the most-recent one) drove the whole leg. */
const lineItemFetches: string[] = [];
const orderServiceGetOrder: (
  orderId: string,
  customerId?: string,
) => Promise<unknown> = async (orderId) => {
  lineItemFetches.push(orderId);
  return {
    order: { items: [{ id: `li_${orderId}`, title: "Coca-Cola", variant_id: "v_coca" }] },
    ownershipValid: true,
  };
};

vi.mock("@ibatexas/tools", () => ({
  rk: (s: string) => s,
  getRedisClient: async () => ({ get: async () => null }),
  medusaAdmin: {},
  medusaStore: async () => ({}),
  reaisToCentavos: (reais: number) => Math.round(reais * 100),
  searchProducts: async () => ({ products: [] }),
}));
vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({
    getById: (id: string) => orderGetById(id),
    listByCustomer: (cid: string) => orderListByCustomer(cid),
    findByDisplayId: async () => [],
  }),
  createOrderService: () => ({
    getOrder: (orderId: string, customerId?: string) =>
      orderServiceGetOrder(orderId, customerId),
  }),
  createPaymentQueryService: () => ({
    getById: async () => null,
    getActiveByOrderId: async () => null,
    listByOrderId: async () => ({ payments: [], count: 0 }),
  }),
  createCustomerService: () => ({
    getById: async () => null,
    getProfileData: async () => ({ customerPrefs: null }),
  }),
  createReservationService: () => ({
    getById: async () => null,
    listByCustomer: async () => ({ reservations: [], total: 0 }),
    checkAvailability: async () => [],
  }),
  prisma: { timeSlot: { findUnique: async () => null } },
}));

// Import AFTER the mocks (vitest hoists vi.mock).
const { createIbatexasResolver } = await import("../ibatexas-resolver.js");
const { buildIbatexasPolicyPacks } = await import("../compose-policy-packs.js");
const { composePolicyRouter } = await import("../capability-policy.js");

// The EXACT composed router the customer-plane SUBMIT stage gates on.
const ROUTER = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as Parameters<typeof buildIbatexasPolicyPacks>[0],
  ) as never,
);

const FIXED_NOW = "2026-07-25T12:00:00.000Z";
const CONVERSATION = `web:${CUSTOMER}`;

interface Composition {
  readonly conductor: Conductor;
  /** Every input the amend executor was invoked with (empty ⇒ nothing mutated). */
  readonly executions: Array<Record<string, unknown>>;
  readonly adjudicated: IntentEnvelope[];
}

/** One turn's composition. `kind` is what the (fake) planner proposes — the payload
 *  deliberately carries NO orderId, exactly like a model-driven granular amend
 *  (order-amend-granular.schema.ts forbids the Identity-class field). */
function compose(kind: string): Composition {
  const executions: Array<Record<string, unknown>> = [];
  const adjudicated: IntentEnvelope[] = [];

  const planner: PlannerPort = {
    async propose(cognition) {
      const envelope = buildEnvelope({
        kind,
        payload: { item: "Coca-Cola" },
        // Production's customer-plane envelope actor (ibatexas-planner.ts): the
        // AUTHENTICATED conversation session, never model output.
        actor: { principal: "llm", sessionId: cognition.conversationId },
        taint: "UNTRUSTED",
        nonce: `n-${kind}`,
        createdAt: FIXED_NOW,
      }) as IntentEnvelope;
      return { envelopes: [envelope], capabilities: [kind] };
    },
  };

  // Mirrors production's decision-aware responder (ibatexas-responder.ts): a real
  // REFUSE / REQUEST_CONFIRMATION is MODEL-FREE — the reply is the kernel decision's
  // own user-facing copy, never model prose. That is what makes the CLARIFY arm's
  // text assertion below a statement about what the customer actually sees.
  const responder: ResponderPort = {
    async respond({ decision }) {
      if (decision.kind === "REFUSE") return { text: decision.refusal.userFacing };
      if (decision.kind === "REQUEST_CONFIRMATION") return { text: decision.prompt };
      return { text: `decision=${decision.kind}` };
    },
  };

  // A REAL kernel verdict against the REAL composed router, over the per-envelope
  // state the resolver assembled (`perStates`) — the seam that decides whether the
  // amend executes at all, and against which order.
  const decide = (envelope: IntentEnvelope, state: unknown): Decision => {
    adjudicated.push(envelope);
    return adjudicate(envelope as never, state as never, ROUTER as never);
  };
  const adjudicator: Adjudicator = {
    async adjudicate(envelope, state) {
      return decide(envelope as IntentEnvelope, state);
    },
    async adjudicatePlan(envelopes, state, _policy, perStates) {
      const env = (envelopes as ReadonlyArray<IntentEnvelope>)[0];
      if (env === undefined) return { kind: "REFUSE", basis: [], refusal: undefined } as never;
      return decide(env, perStates?.[0] ?? state);
    },
    async replayEnvelopesByCustomerId() {
      return [];
    },
    streamAuditByIntentHashPrefix: async function* () {},
    async getOutcomes() {
      return [];
    },
    verifyAuditRecord(): AuditVerification {
      return { ok: true };
    },
  };

  const tools = createToolRegistry();
  const capability = asCapability(kind);
  if (capability === undefined) throw new Error(`unreachable: ${kind}`);
  tools.register({
    id: `test:${kind}.recorder`,
    capability,
    intentKind: kind as IntentKind,
    description: "BKL-216 e2e amend executor — records the order it was told to mutate",
    inputSchema: {},
    outputSchema: {},
    riskLevel: "high",
    execute: async (input) => {
      executions.push(input as Record<string, unknown>);
      return { success: true };
    },
  });

  const session: SessionPort = {
    async load(customerId, channel) {
      return {
        id: `${channel}:${customerId}`,
        customerId,
        channel,
        startedAt: FIXED_NOW,
        lastActivityAt: FIXED_NOW,
        pendingConfirmations: [],
        deferredEnvelopes: [],
        activeGoals: [],
        workingMemory: { summary: "", facts: [], updatedAt: FIXED_NOW },
      } satisfies Session;
    },
    async save() {},
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
      return { docs: [], retrievedAt: FIXED_NOW, modelId: "none" };
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
          displayName: "IbateXas BKL-216",
          locale: "pt-BR",
          environment: "dev",
        },
        state: {},
        policy: {},
      };
    },
  };

  const channel: ChannelDriver = {
    kind: "web",
    async perceive(raw) {
      return raw as ChannelMessage;
    },
    async render() {},
    async attest(envelope) {
      return { envelope, signature: "test", keyId: "test", alg: "none" };
    },
    matchToParked() {
      return null;
    },
  };

  const conductor = createConductor({
    adjudicator,
    memory,
    grounding,
    planner,
    responder,
    resolver: createIbatexasResolver(),
    explainer: { render: (r) => r.userFacing },
    handoff: { async queue() {} },
    telemetry: {
      async emitTurn() {},
      async emitLLMTrace() {},
      async emitMemoryAccess() {},
    },
    session,
    tools,
    channels: [channel],
    tenantResolver,
    sessionLock: {
      async acquire(key) {
        return { key, async release() {} };
      },
    },
  });

  return { conductor, executions, adjudicated };
}

/** Drive ONE real turn: openCapsule → handleTurn → closeCapsule. */
async function runTurn(kind: string, text: string) {
  const setup = compose(kind);
  const inbound: ChannelMessage = {
    channel: "web",
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    text,
    receivedAt: FIXED_NOW,
  };
  const capsule = await setup.conductor.openCapsule({
    channel: "web",
    customerId: CUSTOMER,
    inbound,
  });
  try {
    const result = await handleTurn(capsule, inbound);
    return { ...setup, result };
  } finally {
    await setup.conductor.closeCapsule(capsule);
  }
}

beforeEach(() => {
  lineItemFetches.length = 0;
});

describe("BKL-216 turn seam — an amend that NAMES an order mutates that order", () => {
  // THE defect this ticket exists for: 2 owned orders, the customer names the OLDER
  // one, and before the fix the mutation landed on the most-recent order instead.
  it("order.amend.remove_item: naming the OLDER order lands the mutation on it, not on most-recent", async () => {
    const { result, executions, adjudicated } = await runTurn(
      "order.amend.remove_item",
      "tira a coca do pedido 933869",
    );

    expect(result.decision.kind).toBe("EXECUTE");
    // The mutation actually ran, exactly once, against the NAMED order.
    expect(executions).toHaveLength(1);
    expect(executions[0]?.orderId).toBe(OLDER.id);
    expect(executions[0]?.orderId).not.toBe(NEWEST.id);
    // The envelope the KERNEL adjudicated carries the same order (not just the tool
    // input) — the resolved payload is what was governed.
    expect((adjudicated[0]?.payload as { orderId?: string }).orderId).toBe(OLDER.id);
    // Independent witness: the live line-item fetch went to the named order too.
    expect(lineItemFetches).toContain(OLDER.id);
    expect(lineItemFetches).not.toContain(NEWEST.id);
  });

  it("order.amend.update_qty: same binding through a different amend kind", async () => {
    const { result, executions } = await runTurn(
      "order.amend.update_qty",
      "no pedido 933869 deixa 3 cocas",
    );
    expect(result.decision.kind).toBe("EXECUTE");
    expect(executions[0]?.orderId).toBe(OLDER.id);
  });

  // Regression bar: the unnamed turn keeps the blind most-recent resolution AND its
  // confirm gate (the pre-BKL-216 behavior), so the fix is additive.
  it("naming NO order keeps the most-recent resolution behind the autoresolve confirm", async () => {
    const { result, executions } = await runTurn(
      "order.amend.remove_item",
      "tira a coca do meu pedido",
    );
    expect(result.decision.kind).toBe("REQUEST_CONFIRMATION");
    // A confirm-gated turn must NOT mutate anything yet.
    expect(executions).toHaveLength(0);
  });

  // IDOR through the real seam: a foreign display number can never bind. The turn
  // degrades to the customer's own most-recent order behind the confirm gate — it
  // never executes against the named foreign order.
  it("naming an order the customer does NOT own never binds it (IDOR-safe end-to-end)", async () => {
    const { result, executions, adjudicated } = await runTurn(
      "order.amend.remove_item",
      "tira a coca do pedido 111222",
    );
    expect(result.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(executions).toHaveLength(0);
    const governed = (adjudicated[0]?.payload as { orderId?: string }).orderId;
    expect(governed).toBe(NEWEST.id); // their OWN most-recent, never a foreign order
  });

  // ≥2 named owned orders → the CLARIFY refusal, proving the resolver's payload
  // markers survive to the kernel AND that the pack guard is wired in the COMPOSED
  // router (a pack-only unit test would pass even if it were never composed).
  it("naming TWO owned orders CLARIFIes which one instead of guessing or dead-ending", async () => {
    const { result, executions } = await runTurn(
      "order.amend.remove_item",
      "tira a coca do 933869 e do 960763",
    );
    expect(result.decision.kind).toBe("REFUSE");
    if (result.decision.kind !== "REFUSE") return;
    expect(result.decision.refusal.code).toBe("order.ambiguous_reference");
    // NOT the misleading `order.not_found` — the orders were found.
    expect(result.decision.refusal.code).not.toBe("order.not_found");
    // The reply names both of the customer's own order numbers.
    expect(result.response.text).toContain("#933869");
    expect(result.response.text).toContain("#960763");
    expect(executions).toHaveLength(0);
  });
});
