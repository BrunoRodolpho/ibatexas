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
