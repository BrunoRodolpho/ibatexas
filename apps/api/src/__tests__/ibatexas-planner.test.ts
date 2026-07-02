/**
 * RC-A1 Stage 2 (Phase A.1) — production planner.
 *
 * Verification floor for `createIbatexasPlanner` (green-at-commit):
 *   - schema: every emitted envelope is a well-formed v2 IntentEnvelope whose
 *     intentHash matches its canonical content (re-derivable by the kernel).
 *   - golden-set: a mocked model expressing a given capability yields an
 *     envelope of the matching intent kind.
 *   - properties (N ≥ 100): actor.principal === "llm", kind ∈ allowedIntents,
 *     sessionId === conversationId; out-of-plan capabilities never become
 *     envelopes.
 *   - claustrum Hard Rule #1/#7: the LLM sees exactly one mutating tool
 *     (`express_intent`) and NEVER an internal tool id.
 *
 * The model is mocked — these bound the planner's *mapping* floor. Live LLM
 * intent-extraction accuracy (the empirical ceiling) is a separate, observed
 * measurement (Phase C), not a green-at-commit gate.
 */

import { describe, expect, it, vi } from "vitest";
import { deriveIntentHash, isIntentEnvelope } from "@adjudicate/core";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import type {
  CognitiveState,
  Completion,
  CompletionRequest,
  ModelProvider,
} from "@claustrum/core";
import {
  createIbatexasPlanner,
  EXPRESS_INTENT_TOOL,
} from "../claustrum/ibatexas-planner.js";
import {
  deriveIbatexasPlannerContext,
  agentCtxFromState,
  withAuthenticatedOwner,
} from "../claustrum-bootstrap.js";
import type { AgentContext } from "@ibatexas/types";

// ── Doubles ──────────────────────────────────────────────────────────────────

type ToolCall = { id: string; name: string; input: unknown };

/** A ModelProvider whose `complete` returns canned tool calls and records the request. */
function mockModel(toolCalls: ToolCall[]): {
  model: ModelProvider;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(
    async (_req: CompletionRequest): Promise<Completion> => ({
      model: "mock",
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      text: "",
      toolCalls,
      inputTokens: 0,
      outputTokens: 0,
    }),
  );
  const model: ModelProvider = {
    complete,
    stream: () => {
      throw new Error("stream not used by planner");
    },
    embed: async () => {
      throw new Error("embed not used by planner");
    },
  };
  return { model, complete };
}

function capPlanner(
  visibleReadTools: string[],
  allowedIntents: string[],
): CapabilityPlanner<unknown, unknown> {
  return { plan: () => ({ visibleReadTools, allowedIntents }) };
}

function mkState(text: string, conversationId = "conv-1"): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-05-29T00:00:00.000Z" },
    memory: {},
    retrieval: { docs: [], retrievedAt: "2026-05-29T00:00:00.000Z", modelId: "m" },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId,
    turnId: "turn-1",
  } as unknown as CognitiveState;
}

const ORDER_INTENTS = ["order.item.add", "order.cart.ensure", "order.coupon.apply"];
const ORDER_READS = ["get_cart", "check_order_status"];

function expressIntent(capability: string, payload: unknown = { ok: true }): ToolCall {
  return { id: `tc-${capability}`, name: EXPRESS_INTENT_TOOL, input: { capability, payload } };
}

// ── Golden-set / mapping ─────────────────────────────────────────────────────

describe("createIbatexasPlanner — intent extraction", () => {
  it("maps an in-plan express_intent to a matching IntentEnvelope", async () => {
    const { model } = mockModel([expressIntent("order.item.add", { sku: "x", qty: 2 })]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
    });

    const plan = await planner.propose(mkState("quero adicionar 2 costelas"));

    expect(plan.envelopes).toHaveLength(1);
    const env = plan.envelopes[0]!;
    expect(env.kind).toBe("order.item.add");
    expect(env.actor.principal).toBe("llm");
    expect(env.actor.sessionId).toBe("conv-1");
    expect(env.taint).toBe("UNTRUSTED");
    expect(env.payload).toEqual({ sku: "x", qty: 2 });
    expect(plan.capabilities).toEqual(["order.item.add"]);
  });

  it("supports multi-envelope plans (one envelope per express_intent call)", async () => {
    const { model } = mockModel([
      expressIntent("order.cart.ensure"),
      expressIntent("order.item.add", { sku: "y", qty: 1 }),
    ]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
    });

    const plan = await planner.propose(mkState("monta meu pedido"));
    expect(plan.envelopes.map((e) => e.kind)).toEqual([
      "order.cart.ensure",
      "order.item.add",
    ]);
  });

  it("returns a respond-only plan ([]) when the model proposes no mutation", async () => {
    const { model, complete } = mockModel([]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
    });

    const plan = await planner.propose(mkState("qual o horário de vocês?"));
    expect(plan.envelopes).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("records read-tool calls as enrichment, not envelopes", async () => {
    const { model } = mockModel([
      { id: "r1", name: "get_cart", input: { cartId: "c1" } },
      expressIntent("order.coupon.apply", { code: "WELCOME" }),
    ]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
    });

    const plan = await planner.propose(mkState("aplica o cupom WELCOME"));
    expect(plan.envelopes.map((e) => e.kind)).toEqual(["order.coupon.apply"]);
    expect(plan.readToolCalls).toEqual([{ name: "get_cart", input: { cartId: "c1" } }]);
  });
});

// ── Defense in depth ─────────────────────────────────────────────────────────

describe("createIbatexasPlanner — allowlist enforcement", () => {
  it("DROPS an express_intent whose capability is not in the turn's allowlist", async () => {
    // order.cancel is NOT in ORDER_INTENTS for this state.
    const { model } = mockModel([expressIntent("order.cancel", { orderId: "o1" })]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
    });

    const plan = await planner.propose(mkState("cancela meu pedido"));
    expect(plan.envelopes).toEqual([]);
    expect(plan.rationale).toMatch(/dropped out-of-plan \[order\.cancel\]/);
  });

  it("drops a malformed express_intent payload without throwing", async () => {
    const { model } = mockModel([
      { id: "bad", name: EXPRESS_INTENT_TOOL, input: { nope: true } },
      { id: "bad2", name: EXPRESS_INTENT_TOOL, input: "not-an-object" },
    ]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
    });

    const plan = await planner.propose(mkState("???"));
    expect(plan.envelopes).toEqual([]);
  });

  it("skips the LLM call entirely when nothing is proposable or readable", async () => {
    const { model, complete } = mockModel([expressIntent("order.item.add")]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner([], [])], // empty plan
    });

    const plan = await planner.propose(mkState("oi"));
    expect(plan.envelopes).toEqual([]);
    expect(complete).not.toHaveBeenCalled(); // no proposable intents → no LLM spend
  });
});

// ── claustrum Hard Rule #1 / #7 — tool surface ───────────────────────────────

describe("createIbatexasPlanner — LLM tool surface", () => {
  it("exposes exactly one mutating tool (express_intent) + read tools, never an internal tool id", async () => {
    const { model, complete } = mockModel([]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
    });

    await planner.propose(mkState("oi"));
    const req = complete.mock.calls[0]![0] as CompletionRequest;
    const toolNames = (req.tools ?? []).map((t) => t.name);

    // express_intent is present and is the ONLY non-read tool.
    expect(toolNames).toContain(EXPRESS_INTENT_TOOL);
    const nonRead = toolNames.filter((n) => !ORDER_READS.includes(n));
    expect(nonRead).toEqual([EXPRESS_INTENT_TOOL]);

    // No internal tool id leaks (Hard Rule #1): no versioned/dotted impl ids.
    for (const name of toolNames) {
      expect(name).not.toMatch(/\.v\d+$/);
      expect(name).not.toMatch(/^(ibatexas|medusa|stripe)\./);
    }

    // express_intent's capability enum is exactly the allowed intents.
    const ei = (req.tools ?? []).find((t) => t.name === EXPRESS_INTENT_TOOL)!;
    const schema = ei.inputSchema as {
      properties: { capability: { enum: string[] } };
    };
    expect(new Set(schema.properties.capability.enum)).toEqual(new Set(ORDER_INTENTS));
  });
});

// ── Schema ───────────────────────────────────────────────────────────────────

describe("createIbatexasPlanner — envelope schema", () => {
  it("emits well-formed v2 envelopes whose intentHash re-derives (kernel-verifiable)", async () => {
    const { model } = mockModel([expressIntent("order.item.add", { sku: "z", qty: 3 })]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
    });

    const plan = await planner.propose(mkState("adiciona z"));
    const env = plan.envelopes[0]!;
    expect(isIntentEnvelope(env)).toBe(true);
    expect(env.version).toBe(2);
    // The hash must match the canonical content — else the kernel REFUSEs it
    // with schema:intent_hash_mismatch.
    expect(deriveIntentHash(env)).toBe(env.intentHash);
  });
});

// ── Properties (N ≥ 100) ─────────────────────────────────────────────────────

describe("createIbatexasPlanner — invariants (property)", () => {
  it("holds plan invariants across ≥100 generated cases", async () => {
    const pool = [
      "order.item.add",
      "order.cart.ensure",
      "order.coupon.apply",
      "payment.charge.create",
      "reservation.book",
    ];
    let checked = 0;

    for (let i = 0; i < 120; i++) {
      // Deterministic variation by index (no RNG → no flakiness).
      const allowed = pool.slice(0, (i % pool.length) + 1);
      const expressed = pool[i % pool.length]!; // always the i-th allowed-or-not
      const outOfPlanAlso = pool[(i + 3) % pool.length]!; // may or may not be allowed
      const { model } = mockModel([
        expressIntent(expressed, { i }),
        expressIntent(outOfPlanAlso, { i }),
      ]);
      const planner = createIbatexasPlanner({
        model,
        modelId: "claude-test",
        capabilityPlanners: [capPlanner(["get_cart"], allowed)],
      });

      const plan = await planner.propose(mkState(`msg-${i}`, `conv-${i}`));

      for (const env of plan.envelopes) {
        expect(env.actor.principal).toBe("llm");
        expect(env.actor.sessionId).toBe(`conv-${i}`);
        expect(allowed).toContain(env.kind); // never out-of-plan
        expect(env.taint).toBe("UNTRUSTED");
      }
      // Count of emitted envelopes equals count of expressed-and-allowed.
      const expectedCount = [expressed, outOfPlanAlso].filter((k) =>
        allowed.includes(k),
      ).length;
      expect(plan.envelopes).toHaveLength(expectedCount);
      checked++;
    }

    expect(checked).toBeGreaterThanOrEqual(100);
  });
});

// ── WS3 — deriveIbatexasPlannerContext (real actor threading) ────────────────

/** Build a CognitiveState whose recalled memory carries `customerId`. */
function mkStateWithCustomer(
  customerId: string | undefined,
  channel: "web" | "whatsapp" = "web",
): CognitiveState {
  return {
    perception: { text: "oi", channel, receivedAt: "2026-06-05T00:00:00.000Z" },
    memory:
      customerId === undefined
        ? {}
        : {
            customerId,
            episodic: [],
            semantic: [],
            procedural: [],
            relational: [],
            assembledAt: "2026-06-05T00:00:00.000Z",
          },
    retrieval: { docs: [], retrievedAt: "2026-06-05T00:00:00.000Z", modelId: "m" },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  } as unknown as CognitiveState;
}

interface DerivedCtx {
  customerId: string | null;
  isAuthenticated: boolean;
  channel: string;
  staffId: string | null;
}

function ctxOf(state: CognitiveState): DerivedCtx {
  const derived = deriveIbatexasPlannerContext(state);
  return (derived.state as { ctx: DerivedCtx }).ctx;
}

describe("deriveIbatexasPlannerContext — real actor threading", () => {
  it("derives an AUTHENTICATED context from a real recalled customerId", () => {
    const ctx = ctxOf(mkStateWithCustomer("cus_42"));
    expect(ctx.customerId).toBe("cus_42");
    expect(ctx.isAuthenticated).toBe(true);
  });

  it("derives an UNAUTHENTICATED context when no customer is recalled", () => {
    const ctx = ctxOf(mkStateWithCustomer(undefined));
    expect(ctx.customerId).toBeNull();
    expect(ctx.isAuthenticated).toBe(false);
  });

  it("treats a guest: marker as unauthenticated (mirrors agentCtxFromCapsule)", () => {
    const ctx = ctxOf(mkStateWithCustomer("guest:abc"));
    expect(ctx.customerId).toBeNull();
    expect(ctx.isAuthenticated).toBe(false);
  });

  it("carries the perception channel through", () => {
    expect(ctxOf(mkStateWithCustomer("cus_1", "whatsapp")).channel).toBe("whatsapp");
  });

  it("makes authenticated order intents proposable end-to-end", async () => {
    // With a real customer, the orders pack planner exposes the authenticated
    // subset (order.checkout.create etc.). Prove the derived ctx flips that on.
    const { ordersCapabilityPlanner } = await import("@ibatexas/pack-orders");
    // The production planner unions over CapabilityPlanner<unknown, unknown>;
    // calling the typed pack planner directly here requires erasing the
    // (state, context) to its declared param shape — the derived ctx is exactly
    // what the union'd planner feeds in production.
    const plan = (s: { state: unknown; context: unknown }) =>
      (
        ordersCapabilityPlanner as unknown as {
          plan: (state: unknown, context: unknown) => { allowedIntents: string[] };
        }
      ).plan(s.state, s.context).allowedIntents;
    const authedIntents = plan(deriveIbatexasPlannerContext(mkStateWithCustomer("cus_99")));
    const guestIntents = plan(deriveIbatexasPlannerContext(mkStateWithCustomer(undefined)));
    expect(authedIntents).toContain("order.checkout.create");
    expect(authedIntents).toContain("order.cancel");
    expect(guestIntents).not.toContain("order.checkout.create");
    expect(guestIntents).toContain("order.item.add"); // always proposable
  });
});

// ── BKL-027 (F2): one-hop read-tool enrichment loop ───────────────────────────

/** A ModelProvider whose `complete` returns a DIFFERENT canned completion per
 *  call (index-based), so a read-only first pass can be followed by an
 *  intent-proposing second pass. Reports 1 in/1 out token per call. */
function mockModelSequence(sequences: ToolCall[][]): {
  model: ModelProvider;
  complete: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const complete = vi.fn(async (_req: CompletionRequest): Promise<Completion> => {
    const toolCalls = sequences[Math.min(i, sequences.length - 1)] ?? [];
    i += 1;
    return {
      model: "mock",
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      text: "",
      toolCalls,
      inputTokens: 1,
      outputTokens: 1,
    };
  });
  const model: ModelProvider = {
    complete,
    stream: () => {
      throw new Error("stream not used by planner");
    },
    embed: async () => {
      throw new Error("embed not used by planner");
    },
  };
  return { model, complete };
}

function readCall(name: string, input: unknown = {}): ToolCall {
  return { id: `rc-${name}`, name, input };
}

describe("createIbatexasPlanner — read-tool enrichment loop (BKL-027)", () => {
  it("read-only first pass runs the reads then re-prompts ONCE → second-pass intent", async () => {
    const { model, complete } = mockModelSequence([
      [readCall("get_cart", { cartId: "c1" })], // pass 1: reads only, no intent
      [expressIntent("order.item.add", { sku: "x" })], // pass 2: intent after results
    ]);
    const execCalls: Array<{ input: unknown; customerId: unknown }> = [];
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
      readToolExecutors: {
        get_cart: async (input, state) => {
          execCalls.push({
            input,
            customerId: (state.memory as { customerId?: unknown }).customerId,
          });
          return { cart: { items: [] } };
        },
      },
    });

    const plan = await planner.propose(mkStateWithCustomer("cus_1"));

    expect(complete).toHaveBeenCalledTimes(2); // exactly one extra hop
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.input).toEqual({ cartId: "c1" });
    // The executor receives the AUTHENTICATED turn state (identity ← state).
    expect(execCalls[0]!.customerId).toBe("cus_1");
    expect(plan.envelopes.map((e) => e.kind)).toEqual(["order.item.add"]);
    // Read record carries both passes' read calls (here just pass 1's).
    expect(plan.readToolCalls?.map((c) => c.name)).toContain("get_cart");
  });

  it("does NOT loop when no readToolExecutors are wired (single pass — byte-identical)", async () => {
    const { model, complete } = mockModelSequence([[readCall("get_cart", { cartId: "c1" })]]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
    });

    const plan = await planner.propose(mkStateWithCustomer("cus_1"));

    expect(complete).toHaveBeenCalledTimes(1);
    expect(plan.envelopes).toHaveLength(0);
    expect(plan.readToolCalls).toEqual([{ name: "get_cart", input: { cartId: "c1" } }]);
  });

  it("does NOT loop when the first pass already proposed a mutating intent", async () => {
    const { model, complete } = mockModelSequence([
      [readCall("get_cart"), expressIntent("order.item.add")],
    ]);
    let execd = 0;
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
      readToolExecutors: {
        get_cart: async () => {
          execd += 1;
          return {};
        },
      },
    });

    const plan = await planner.propose(mkStateWithCustomer("cus_1"));

    expect(complete).toHaveBeenCalledTimes(1);
    expect(execd).toBe(0);
    expect(plan.envelopes.map((e) => e.kind)).toEqual(["order.item.add"]);
  });

  it("a read executor that throws never crashes the turn — best-effort, re-prompts anyway", async () => {
    const { model, complete } = mockModelSequence([
      [readCall("get_cart")],
      [expressIntent("order.item.add")],
    ]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
      readToolExecutors: {
        get_cart: async () => {
          throw new Error("boom");
        },
      },
    });

    const plan = await planner.propose(mkStateWithCustomer("cus_1"));

    expect(complete).toHaveBeenCalledTimes(2);
    expect(plan.envelopes.map((e) => e.kind)).toEqual(["order.item.add"]);
  });

  it("skips an advertised read with no executor (no_executor) and still re-prompts", async () => {
    const { model, complete } = mockModelSequence([
      [readCall("check_order_status")], // advertised but absent from the executor map
      [expressIntent("order.item.add")],
    ]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
      readToolExecutors: { get_cart: async () => ({}) },
    });

    const plan = await planner.propose(mkStateWithCustomer("cus_1"));

    expect(complete).toHaveBeenCalledTimes(2);
    expect(plan.envelopes.map((e) => e.kind)).toEqual(["order.item.add"]);
  });

  it("sums token usage across both completions", async () => {
    const { model } = mockModelSequence([
      [readCall("get_cart")],
      [expressIntent("order.item.add")],
    ]);
    const planner = createIbatexasPlanner({
      model,
      modelId: "claude-test",
      capabilityPlanners: [capPlanner(ORDER_READS, ORDER_INTENTS)],
      readToolExecutors: { get_cart: async () => ({}) },
    });

    const plan = await planner.propose(mkStateWithCustomer("cus_1"));
    expect(plan.usage).toEqual({ inputTokens: 2, outputTokens: 2 });
  });
});

describe("agentCtxFromState — read-executor identity (BKL-027)", () => {
  it("authenticated customer → customerId + userType 'customer'", () => {
    const ctx = agentCtxFromState(mkStateWithCustomer("cus_7"));
    expect(ctx.customerId).toBe("cus_7");
    expect(ctx.userType).toBe("customer");
    expect(ctx.sessionId).toBe("conv-1");
    expect(ctx.channel).toBe("web");
  });

  it("guest marker → no customerId, userType 'guest'", () => {
    const ctx = agentCtxFromState(mkStateWithCustomer("guest:abc"));
    expect(ctx.customerId).toBeUndefined();
    expect(ctx.userType).toBe("guest");
  });

  it("no recalled customer → no customerId, userType 'guest'", () => {
    const ctx = agentCtxFromState(mkStateWithCustomer(undefined));
    expect(ctx.customerId).toBeUndefined();
    expect(ctx.userType).toBe("guest");
  });

  it("carries the perception channel through", () => {
    expect(agentCtxFromState(mkStateWithCustomer("cus_1", "whatsapp")).channel).toBe("whatsapp");
  });
});

describe("withAuthenticatedOwner — IDOR override (BKL-027)", () => {
  const authed: AgentContext = {
    channel: "web" as AgentContext["channel"],
    sessionId: "s",
    customerId: "cus_me",
    userType: "customer",
  };

  it("overrides a model-forged customerId with the authenticated one", () => {
    const out = withAuthenticatedOwner(
      { customerId: "VICTIM", status: "confirmed" },
      authed,
    );
    expect(out).toEqual({ customerId: "cus_me", status: "confirmed" });
  });

  it("injects undefined customerId for a guest (owned reads then reject)", () => {
    const guest: AgentContext = {
      channel: "web" as AgentContext["channel"],
      sessionId: "s",
      userType: "guest",
    };
    const out = withAuthenticatedOwner({ customerId: "VICTIM" }, guest) as {
      customerId?: string;
    };
    expect(out.customerId).toBeUndefined();
  });

  it("is a no-op for null / non-object input", () => {
    expect(withAuthenticatedOwner(null, authed)).toBeNull();
    expect(withAuthenticatedOwner("x", authed)).toBe("x");
  });
});
