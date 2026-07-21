// reservation-convenience-extraction-prompt-fragment-support.ts — TEST
// SUPPORT (not a *.test.ts, so vitest never collects it directly — mirrors
// order-cart-item-extraction-prompt-fragment-support.ts's convention).
//
// FE-T14 — computes the FRESH composed `express_intent` tool JSON for the
// pack-reservations family (reservation.create, reservation.modify,
// reservation.cancel, reservation.waitlist.join) when all four are
// simultaneously in the allowed-intent set.
//
// NO persona excerpt — see order-amend-granular-extraction-prompt-fragment-
// support.ts's header for why.

import type { CognitiveState, Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import { createIbatexasPlanner, EXPRESS_INTENT_TOOL } from "../../ibatexas-planner.js";

/** The composed artifact this golden gate pins — byte-identity target. */
export interface ReservationConvenienceExtractionPromptFragment {
  readonly capabilities: readonly string[];
  readonly expressIntentTool: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  };
}

const RESERVATION_CONVENIENCE_CAPABILITIES = [
  "reservation.create",
  "reservation.modify",
  "reservation.cancel",
  "reservation.waitlist.join",
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
    conversationId: "conv-golden-reservation",
    turnId: "turn-golden-reservation",
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
 * Compute the FRESH extraction-prompt fragment for the reservation group by
 * driving the REAL `createIbatexasPlanner` with a capability planner that
 * allows all four kinds and capturing the `express_intent` tool the model
 * would actually receive.
 */
export async function computeReservationConvenienceExtractionPromptFragment(): Promise<ReservationConvenienceExtractionPromptFragment> {
  const { model, calls } = noToolCallModel();
  const planner = createIbatexasPlanner({
    model,
    modelId: "claude-test",
    capabilityPlanners: [capPlanner([...RESERVATION_CONVENIENCE_CAPABILITIES])],
  });

  await planner.propose(mkState("oi"));
  const req = calls[0]!;
  const tool = (req.tools ?? []).find((t) => t.name === EXPRESS_INTENT_TOOL);
  if (tool === undefined) {
    throw new Error("extraction-prompt golden (reservation-convenience): express_intent tool missing from buildToolSurface output");
  }

  return {
    capabilities: RESERVATION_CONVENIENCE_CAPABILITIES,
    expressIntentTool: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
  };
}
