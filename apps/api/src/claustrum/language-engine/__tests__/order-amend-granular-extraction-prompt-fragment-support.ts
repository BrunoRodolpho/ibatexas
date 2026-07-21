// order-amend-granular-extraction-prompt-fragment-support.ts — TEST SUPPORT
// (not a *.test.ts, so vitest never collects it directly — mirrors
// extraction-prompt-fragment-support.ts's own convention).
//
// FE-T14 BACKFILL: FE-T09 (D-a, the amend inversion) authored the three
// granular post-checkout amend extraction schemas (order-amend-granular.
// schema.ts) and registered them on the wire (wire-schemas.ts), but never
// pinned a golden byte-identity fragment or a schema-binding entry for
// them — this file closes that gap, mirroring extraction-prompt-fragment-
// support.ts's methodology exactly.
//
// Computes the FRESH "composed per-capability-group extraction-prompt
// fragment": the exact `express_intent` tool JSON the model receives on the
// wire when all three granular amend kinds are simultaneously in the
// allowed-intent set (the real shape any customer-plane turn offering them
// together produces — see surfaces.json's own allOf, which already carries
// exactly these three entries), driven through the REAL
// `createIbatexasPlanner` → `buildToolSurface` (never a reimplementation).
//
// NO persona excerpt (unlike order-status-transition/payment-refund-issue,
// which pin an OPS_PLANNER_PERSONA paragraph): the three amend kinds are
// customer-plane capabilities governed by PLANNER_PERSONA, which — unlike
// OPS_PLANNER_PERSONA — carries no per-capability paragraph structure at
// all (it is one short, capability-agnostic block). There is nothing
// stable to extract a marker-bounded excerpt from, so this fragment pins
// the tool SCHEMA only — the same posture read-tool-extraction-prompt-
// fragment-support.ts already established for the read roster.

import type { CognitiveState, Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import { createIbatexasPlanner, EXPRESS_INTENT_TOOL } from "../../ibatexas-planner.js";

/** The composed artifact this golden gate pins — byte-identity target. */
export interface OrderAmendGranularExtractionPromptFragment {
  readonly capabilities: readonly string[];
  readonly expressIntentTool: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  };
}

const ORDER_AMEND_GRANULAR_CAPABILITIES = [
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
] as const;

function capPlanner(allowedIntents: string[]): CapabilityPlanner<unknown, unknown> {
  return { plan: () => ({ visibleReadTools: [], allowedIntents }) };
}

function mkState(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-16T00:00:00.000Z" },
    memory: {},
    retrieval: { docs: [], retrievedAt: "2026-07-16T00:00:00.000Z", modelId: "m" },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv-golden-amend-granular",
    turnId: "turn-golden-amend-granular",
  } as unknown as CognitiveState;
}

/** Plain manual capture (no vitest `vi.fn` dependency) — this module doubles
 *  as a regeneration script runnable outside the vitest runtime. */
function noToolCallModel(): { model: ModelProvider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const complete = async (req: CompletionRequest): Promise<Completion> => {
    calls.push(req);
    return {
      model: "mock",
      stopReason: "end_turn",
      text: "ok (mock planner pass — nothing to propose)",
      toolCalls: [],
      inputTokens: 1,
      outputTokens: 1,
    };
  };
  return {
    model: {
      complete,
      stream: () => {
        throw new Error("stream not used");
      },
      embed: async () => {
        throw new Error("embed not used");
      },
    },
    calls,
  };
}

/**
 * Compute the FRESH extraction-prompt fragment for the granular amend group
 * by driving the REAL `createIbatexasPlanner` with a capability planner that
 * allows all three granular amend kinds (declaration order, matching
 * surfaces.json's own allOf ordering) and capturing the `express_intent`
 * tool the model would actually receive.
 */
export async function computeOrderAmendGranularExtractionPromptFragment(): Promise<OrderAmendGranularExtractionPromptFragment> {
  const { model, calls } = noToolCallModel();
  const planner = createIbatexasPlanner({
    model,
    modelId: "claude-test",
    capabilityPlanners: [capPlanner([...ORDER_AMEND_GRANULAR_CAPABILITIES])],
  });

  await planner.propose(mkState("oi"));
  const req = calls[0]!;
  const tool = (req.tools ?? []).find((t) => t.name === EXPRESS_INTENT_TOOL);
  if (tool === undefined) {
    throw new Error("extraction-prompt golden (order-amend-granular): express_intent tool missing from buildToolSurface output");
  }

  return {
    capabilities: ORDER_AMEND_GRANULAR_CAPABILITIES,
    expressIntentTool: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
  };
}
