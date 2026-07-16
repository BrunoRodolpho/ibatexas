// extraction-prompt-fragment-support.ts — TEST SUPPORT (not a *.test.ts, so
// vitest never collects it directly — mirrors ops/__tests__/ops-e2e-harness.ts).
//
// Computes the FRESH "composed per-capability extraction-prompt fragment"
// for `order.status.transition` (FE-T06's golden byte-identity gate target):
// the exact `express_intent` tool JSON the model receives on the wire when
// this capability is in play (driven through the REAL `createIbatexasPlanner`
// — never a reimplementation of `buildToolSurface`, so the gate is sensitive
// to any drift in the real composition path: `wire-schemas.ts`'s registry,
// `order-status-transition.schema.ts`, or `buildToolSurface` itself) PLUS the
// `OPS_PLANNER_PERSONA` excerpt describing this capability (extracted by a
// stable paragraph-boundary marker, never edited by this ticket).

import type { CognitiveState, Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import { createIbatexasPlanner, EXPRESS_INTENT_TOOL } from "../../ibatexas-planner.js";
import { OPS_PLANNER_PERSONA } from "../../prompts/personas.js";

/** The composed artifact this golden gate pins — byte-identity target. */
export interface ExtractionPromptFragment {
  readonly capability: string;
  readonly expressIntentTool: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  };
  readonly personaExcerpt: string;
}

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
    conversationId: "conv-golden",
    turnId: "turn-golden",
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
 * Extract the stable, self-contained paragraph of `OPS_PLANNER_PERSONA`
 * describing `order.status.transition` — from its opening marker line up to
 * (not including) the next capability paragraph's opening marker. Throws if
 * either marker is missing (a persona edit that removed/renamed the section
 * — the golden test surfaces this as a hard failure, not a silent empty diff).
 */
export function extractOrderStatusTransitionPersonaExcerpt(persona: string): string {
  const startMarker = "Em order.status.transition,";
  const nextMarker = "\nEm schedule.override.set,";
  const start = persona.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      `extraction-prompt golden: OPS_PLANNER_PERSONA no longer contains the marker "${startMarker}"`,
    );
  }
  const end = persona.indexOf(nextMarker, start);
  if (end === -1) {
    throw new Error(
      `extraction-prompt golden: OPS_PLANNER_PERSONA no longer contains the boundary marker "${nextMarker}" after the order.status.transition paragraph`,
    );
  }
  return persona.slice(start, end);
}

/**
 * Compute the FRESH extraction-prompt fragment for `order.status.transition`
 * by driving the REAL `createIbatexasPlanner` with a capability planner that
 * allows ONLY this capability (the simplest, cleanest single-capability
 * world) and capturing the `express_intent` tool the model would actually
 * receive.
 */
export async function computeOrderStatusTransitionExtractionPromptFragment(): Promise<ExtractionPromptFragment> {
  const { model, calls } = noToolCallModel();
  const planner = createIbatexasPlanner({
    model,
    modelId: "claude-test",
    capabilityPlanners: [capPlanner(["order.status.transition"])],
  });

  await planner.propose(mkState("oi"));
  const req = calls[0]!;
  const tool = (req.tools ?? []).find((t) => t.name === EXPRESS_INTENT_TOOL);
  if (tool === undefined) {
    throw new Error("extraction-prompt golden: express_intent tool missing from buildToolSurface output");
  }

  return {
    capability: "order.status.transition",
    expressIntentTool: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    personaExcerpt: extractOrderStatusTransitionPersonaExcerpt(OPS_PLANNER_PERSONA),
  };
}
