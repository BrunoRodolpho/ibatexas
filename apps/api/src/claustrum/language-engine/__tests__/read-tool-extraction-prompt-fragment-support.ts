// read-tool-extraction-prompt-fragment-support.ts — TEST SUPPORT (not a
// *.test.ts, so vitest never collects it directly — mirrors
// extraction-prompt-fragment-support.ts's own convention).
//
// Computes the FRESH "composed read-tool extraction-prompt fragment"
// (FE-T13's golden byte-identity gate target): the exact `tools` array
// entries the model receives on the wire for the 12 chat-plane read tools,
// driven through the REAL `createIbatexasPlanner` → `buildToolSurface`
// (never a reimplementation), so the gate is sensitive to any drift in the
// real composition path: `read-tool-schemas.ts`'s registry or
// `buildToolSurface` itself.
//
// Unlike `extraction-prompt-fragment-support.ts` (order.status.transition /
// payment.refund.issue), there is no OPS_PLANNER_PERSONA excerpt here — that
// per-capability paragraph convention is specific to the ops/staff persona's
// governance-tier verbs (confirmation guidance for a mutating, adjudicated
// kind). Read tools carry no such paragraph; this fragment pins the tool
// SCHEMA only.

import type { CognitiveState, Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import { createIbatexasPlanner } from "../../ibatexas-planner.js";
import { READ_TOOL_AUTHORED_SCHEMAS } from "../read-tool-schemas.js";

/** The composed artifact this golden gate pins — byte-identity target. */
export interface ReadToolExtractionPromptFragment {
  readonly reads: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  }>;
}

function capPlanner(visibleReadTools: string[]): CapabilityPlanner<unknown, unknown> {
  return { plan: () => ({ visibleReadTools, allowedIntents: [] }) };
}

function mkState(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-16T00:00:00.000Z" },
    memory: {},
    retrieval: { docs: [], retrievedAt: "2026-07-16T00:00:00.000Z", modelId: "m" },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv-golden-reads",
    turnId: "turn-golden-reads",
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
 * Compute the FRESH extraction-prompt fragment for the full 12-tool
 * read roster by driving the REAL `createIbatexasPlanner` with a capability
 * planner that advertises every authored read tool (declaration order,
 * `READ_TOOL_AUTHORED_SCHEMAS`) and NO mutating intent (the simplest,
 * cleanest read-only world), capturing every read tool entry the model
 * would actually receive.
 */
export async function computeReadToolExtractionPromptFragment(): Promise<ReadToolExtractionPromptFragment> {
  const { model, calls } = noToolCallModel();
  const readNames = READ_TOOL_AUTHORED_SCHEMAS.map((s) => s.capability);
  const planner = createIbatexasPlanner({
    model,
    modelId: "claude-test",
    capabilityPlanners: [capPlanner(readNames)],
  });

  await planner.propose(mkState("oi"));
  const req = calls[0]!;
  const reads = (req.tools ?? []).filter((t) => readNames.includes(t.name));
  if (reads.length !== readNames.length) {
    throw new Error(
      `extraction-prompt golden (reads): expected ${readNames.length} read tools on the wire, got ${reads.length}`,
    );
  }

  return {
    reads: reads.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}
