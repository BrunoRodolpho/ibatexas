// The WORKFLOW-SCOPED ACCESS CLASS, proven NON-VACUOUSLY at the real planner
// (LE2-020).
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// The e2e's negative test asserts that `order.reorder` is neither advertised
// nor accepted on a real customer turn. That assertion is TRUE but, on its own,
// VACUOUS: no capability planner advertises `order.reorder` today, so the kind
// would be absent from the roster — and therefore absent from the wire and
// dropped at the parse seam — even if the access class did not exist at all.
// Measured directly: neutering `withoutWorkflowScopedKinds` to a pass-through
// left the entire e2e green.
//
// A gate that cannot fail is not a gate. So this file supplies the ONE input
// that makes the subtraction load-bearing — a capability planner that DOES
// advertise the workflow-scoped kind — and asserts both halves against it. That
// is also the real scenario the class protects: the danger is not today's
// roster, it is the day someone adds `order.reorder` to a planner's
// `allowedIntents` (or a pack widens one) and nothing notices.
//
// Everything below the model is the REAL production planner
// (`createIbatexasPlanner`) — the same seam the turn uses.

import { describe, expect, it, vi } from "vitest";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import type { CognitiveState, Completion, ModelProvider } from "@claustrum/core";
import { createIbatexasPlanner } from "../../ibatexas-planner.js";

const SCOPED_KIND = "order.reorder";
const ORDINARY_KIND = "order.checkout.create";

/**
 * A capability planner that advertises the workflow-scoped kind alongside an
 * ordinary one. The ordinary kind is the CONTROL: without it, "the enum does
 * not contain order.reorder" could just mean the enum is empty.
 */
const ADVERTISES_SCOPED_KIND: CapabilityPlanner<unknown, unknown> = {
  plan: () => ({
    visibleReadTools: [],
    allowedIntents: [ORDINARY_KIND, SCOPED_KIND],
  }),
} as unknown as CapabilityPlanner<unknown, unknown>;

function state(text: string): CognitiveState {
  return {
    turnId: "turn-access",
    conversationId: "conv-access",
    tenantId: "ibatexas",
    locale: "pt-BR",
    perception: { text, channel: "web" },
    memory: { customerId: "cus_access" },
  } as unknown as CognitiveState;
}

/** A model that emits whatever tool calls the test scripts, once. */
function modelEmitting(toolCalls: ReadonlyArray<{ name: string; input: unknown }>): {
  provider: ModelProvider;
  requests: Array<{ tools?: ReadonlyArray<{ name: string; inputSchema: unknown }> }>;
} {
  const requests: Array<{ tools?: ReadonlyArray<{ name: string; inputSchema: unknown }> }> =
    [];
  let fired = false;
  const provider: ModelProvider = {
    complete: vi.fn(async (req: unknown): Promise<Completion> => {
      const request = req as { tools?: ReadonlyArray<{ name: string; inputSchema: unknown }> };
      requests.push(request);
      const isPlanner = (request.tools?.length ?? 0) > 0;
      const emit = isPlanner && !fired;
      if (emit) fired = true;
      return {
        model: "mock",
        stopReason: "end_turn",
        text: emit ? "" : "ok",
        toolCalls: emit ? toolCalls.map((c, i) => ({ id: `t${i}`, ...c })) : [],
        inputTokens: 1,
        outputTokens: 1,
      } as Completion;
    }),
    stream: () => {
      throw new Error("unused");
    },
    embed: async () => {
      throw new Error("unused");
    },
  };
  return { provider, requests };
}

function plannerOver(model: ModelProvider) {
  return createIbatexasPlanner({
    model,
    modelId: "mock-model",
    capabilityPlanners: [ADVERTISES_SCOPED_KIND],
    deriveContext: () => ({ state: {}, context: {} }),
  });
}

/** The `express_intent` capability enum the model was actually shown. */
function advertisedEnum(
  requests: ReadonlyArray<{ tools?: ReadonlyArray<{ name: string; inputSchema: unknown }> }>,
): readonly string[] {
  const plannerCall = requests.find((r) => (r.tools?.length ?? 0) > 0);
  const expressIntent = plannerCall?.tools?.find((t) => t.name === "express_intent");
  return (
    expressIntent?.inputSchema as {
      properties: { capability: { enum: readonly string[] } };
    }
  ).properties.capability.enum;
}

describe("the access class bites even when a capability planner advertises the kind", () => {
  it("NEVER ADVERTISED: the kind is subtracted from the enum the model is shown", async () => {
    const { provider, requests } = modelEmitting([]);
    await plannerOver(provider).propose(state("repete meu último pedido"));

    const advertised = advertisedEnum(requests);
    expect(advertised).not.toContain(SCOPED_KIND);
    // The control — the planner really did authorize two kinds, so the absence
    // above is the subtraction and not an empty roster.
    expect(advertised).toContain(ORDINARY_KIND);
  });

  it("NEVER ACCEPTED: an express_intent naming the kind is DROPPED, not adjudicated", async () => {
    const { provider } = modelEmitting([
      { name: "express_intent", input: { capability: SCOPED_KIND, payload: {} } },
    ]);
    const plan = await plannerOver(provider).propose(state("repete meu último pedido"));

    // No envelope was built at all, so the kernel never sees it. That is
    // stronger than a refusal: a refusal would mean the kind reached
    // adjudication and was turned away there.
    expect(plan.envelopes).toEqual([]);
    expect(plan.capabilities).toEqual([]);
  });

  it("the ORDINARY kind still parses through unchanged — the subtraction is targeted", async () => {
    const { provider } = modelEmitting([
      { name: "express_intent", input: { capability: ORDINARY_KIND, payload: {} } },
    ]);
    const plan = await plannerOver(provider).propose(state("fecha meu pedido"));

    expect(plan.capabilities).toEqual([ORDINARY_KIND]);
    expect(plan.envelopes).toHaveLength(1);
  });
});
