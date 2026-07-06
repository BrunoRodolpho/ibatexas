// ops-read-enrichment — the ops_snapshot READ tool is advertised on the ops
// planner AND executed in the one-hop enrichment loop for a read-only question
// (NEW-032 slice B). Planner-level proof (no conductor/DB): a staff turn whose
// model calls ops_snapshot with no mutating intent runs the executor once.

import { describe, expect, it, vi } from "vitest";
import type {
  CognitiveState,
  Completion,
  CompletionRequest,
  ModelProvider,
} from "@claustrum/core";
import { opsCapabilityPlanner } from "@ibatexas/pack-ops";
import { createIbatexasPlanner } from "../../claustrum/ibatexas-planner.js";
import { OPS_PLANNER_PERSONA } from "../../claustrum/prompts/personas.js";
import { deriveOpsPlannerContext } from "../ops-planner-context.js";

function opsState(text: string): CognitiveState {
  return {
    perception: { text, channel: "system", receivedAt: "2026-07-04T12:00:00.000Z" },
    memory: { customerId: "", recentActions: [], facts: [], episodic: [], semantic: [] },
    retrieval: { docs: [] },
    workingMemory: "",
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "admin:staff_1",
    turnId: "turn-1",
  } as unknown as CognitiveState;
}

/** Model: pass 1 (1 message) → a READ call for `readTool`; pass 2 (3 messages,
 *  the enrichment re-prompt) → plain text, no intent. */
function readThenNoIntentModel(
  readTool = "ops_snapshot",
  reply = "Hoje o caixa fechou positivo.",
): {
  model: ModelProvider;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
    const firstPass = req.messages.length === 1;
    return {
      model: "mock",
      stopReason: "end_turn",
      text: firstPass ? "" : reply,
      toolCalls: firstPass ? [{ id: "r-1", name: readTool, input: {} }] : [],
      inputTokens: 2,
      outputTokens: 2,
    };
  });
  const model: ModelProvider = {
    complete,
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  };
  return { model, complete };
}

describe("ops planner — ops_snapshot enrichment", () => {
  it("advertises ops_snapshot and executes it in the one-hop loop, proposing no mutation", async () => {
    const opsSnapshot = vi.fn(async () => ({ caixa: { netCentavos: 12_345 } }));
    const { model, complete } = readThenNoIntentModel();
    const planner = createIbatexasPlanner({
      model,
      modelId: "mock",
      capabilityPlanners: [opsCapabilityPlanner as never],
      deriveContext: deriveOpsPlannerContext("staff_1"),
      staffEnvelopeActor: { staffId: "staff_1", role: "OWNER" },
      readToolExecutors: { ops_snapshot: opsSnapshot },
      system: OPS_PLANNER_PERSONA,
    });

    const plan = await planner.propose(opsState("como foi o dia?"));

    // The read executor ran exactly once (advertised + executed), and the
    // read-only turn proposed no mutating envelope.
    expect(opsSnapshot).toHaveBeenCalledTimes(1);
    expect(plan.envelopes).toHaveLength(0);
    // Two model passes: the read call, then the enrichment re-prompt.
    expect(complete).toHaveBeenCalledTimes(2);
    // The first pass DID advertise ops_snapshot as a visible read tool.
    const firstReq = complete.mock.calls[0]![0] as CompletionRequest;
    const toolNames = (firstReq.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("ops_snapshot");
  });

  it("advertises ops_sales_analytics and executes it for a sales question, proposing no mutation (NEW-012)", async () => {
    const salesAnalytics = vi.fn(async () => ({
      orders: { ordersCount: 12, revenueCentavos: 144_000, aovCentavos: 12_000 },
    }));
    const { model, complete } = readThenNoIntentModel(
      "ops_sales_analytics",
      "Hoje foram 12 pedidos, R$ 1.440,00 em vendas.",
    );
    const planner = createIbatexasPlanner({
      model,
      modelId: "mock",
      capabilityPlanners: [opsCapabilityPlanner as never],
      deriveContext: deriveOpsPlannerContext("staff_1"),
      staffEnvelopeActor: { staffId: "staff_1", role: "OWNER" },
      readToolExecutors: { ops_sales_analytics: salesAnalytics },
      system: OPS_PLANNER_PERSONA,
    });

    const plan = await planner.propose(opsState("como foram as vendas hoje?"));

    // The sales read executor ran exactly once, and the read-only turn proposed
    // no mutating envelope.
    expect(salesAnalytics).toHaveBeenCalledTimes(1);
    expect(plan.envelopes).toHaveLength(0);
    expect(complete).toHaveBeenCalledTimes(2);
    // The first pass advertised ops_sales_analytics as a visible read tool.
    const firstReq = complete.mock.calls[0]![0] as CompletionRequest;
    const toolNames = (firstReq.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("ops_sales_analytics");
  });
});
