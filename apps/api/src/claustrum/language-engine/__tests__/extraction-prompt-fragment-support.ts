// extraction-prompt-fragment-support.ts — TEST SUPPORT (not a *.test.ts, so
// vitest never collects it directly — mirrors ops/__tests__/ops-e2e-harness.ts).
//
// Computes the FRESH "composed per-capability extraction-prompt fragment"
// for a capability (FE-T06's golden byte-identity gate target): the exact
// `express_intent` tool JSON the model receives on the wire when that
// capability is in play (driven through the REAL `createIbatexasPlanner` —
// never a reimplementation of `buildToolSurface`, so the gate is sensitive to
// any drift in the real composition path: `wire-schemas.ts`'s registry, the
// capability's own extraction schema, or `buildToolSurface` itself) PLUS the
// `OPS_PLANNER_PERSONA` excerpt describing that capability (extracted by a
// stable paragraph-boundary marker).
//
// THREE capabilities are covered: `order.status.transition` (FE-T05/T06, the
// first tracer), `payment.refund.issue` (FE-T10, the money-tier slice — per
// the owner's ruling, a money-tier extraction schema is bound under this
// gate FROM BIRTH, not deferred; T11-14 should follow the same precedent),
// and `payment.pix.regenerate` (FE-T11, the customer-plane money-tier slice).
//
// `payment.pix.regenerate` is the FIRST of the three driven through the
// CUSTOMER plane (not ops/staff) — its persona is {@link PLANNER_PERSONA}
// (the generic pt-BR semantic-parser prompt every customer capability
// shares), never {@link OPS_PLANNER_PERSONA}. `PLANNER_PERSONA` carries no
// per-capability paragraphs (unlike `OPS_PLANNER_PERSONA`, which is grown
// with one marker-delimited paragraph per ops capability it describes) — it
// is explicitly documented as "byte-identical to the … golden scripted-
// pipeline surfaces" (personas.ts), a single inviolable fragment composed
// unconditionally for EVERY customer-plane turn. So there is no paragraph to
// excerpt-extract: the whole, unmodified `PLANNER_PERSONA` text IS the
// persona this capability is shown, and IS what this golden fragment pins.

import type { CognitiveState, Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import { createIbatexasPlanner, EXPRESS_INTENT_TOOL } from "../../ibatexas-planner.js";
import { OPS_PLANNER_PERSONA, PLANNER_PERSONA } from "../../prompts/personas.js";

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

/**
 * FE-T10 — the money-tier sibling of {@link extractOrderStatusTransitionPersonaExcerpt}.
 * Extract the stable, self-contained paragraph of `OPS_PLANNER_PERSONA`
 * describing `payment.refund.issue` — from its opening marker line up to (not
 * including) the next capability paragraph's opening marker
 * (`product.availability.set`, the next paragraph in source order).
 */
export function extractPaymentRefundIssuePersonaExcerpt(persona: string): string {
  const startMarker = "Em payment.refund.issue,";
  const nextMarker = "\nEm product.availability.set,";
  const start = persona.indexOf(startMarker);
  if (start === -1) {
    throw new Error(
      `extraction-prompt golden: OPS_PLANNER_PERSONA no longer contains the marker "${startMarker}"`,
    );
  }
  const end = persona.indexOf(nextMarker, start);
  if (end === -1) {
    throw new Error(
      `extraction-prompt golden: OPS_PLANNER_PERSONA no longer contains the boundary marker "${nextMarker}" after the payment.refund.issue paragraph`,
    );
  }
  return persona.slice(start, end);
}

/**
 * FE-T10 — the money-tier sibling of
 * {@link computeOrderStatusTransitionExtractionPromptFragment}. Same
 * methodology: drive the REAL `createIbatexasPlanner` with a capability
 * planner that allows ONLY `payment.refund.issue`, capture the
 * `express_intent` tool's ACTUAL wire shape (sensitive to any drift in
 * `wire-schemas.ts`'s registry, `payment-refund-issue.schema.ts`, or
 * `buildToolSurface` itself) plus the OPS_PLANNER_PERSONA excerpt.
 */
export async function computePaymentRefundIssueExtractionPromptFragment(): Promise<ExtractionPromptFragment> {
  const { model, calls } = noToolCallModel();
  const planner = createIbatexasPlanner({
    model,
    modelId: "claude-test",
    capabilityPlanners: [capPlanner(["payment.refund.issue"])],
  });

  await planner.propose(mkState("oi"));
  const req = calls[0]!;
  const tool = (req.tools ?? []).find((t) => t.name === EXPRESS_INTENT_TOOL);
  if (tool === undefined) {
    throw new Error("extraction-prompt golden: express_intent tool missing from buildToolSurface output");
  }

  return {
    capability: "payment.refund.issue",
    expressIntentTool: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    personaExcerpt: extractPaymentRefundIssuePersonaExcerpt(OPS_PLANNER_PERSONA),
  };
}

/**
 * FE-T11 — the customer-plane money-tier sibling of
 * {@link computePaymentRefundIssueExtractionPromptFragment}. Same
 * methodology: drive the REAL `createIbatexasPlanner` with a capability
 * planner that allows ONLY `payment.pix.regenerate`, capture the
 * `express_intent` tool's ACTUAL wire shape (sensitive to any drift in
 * `wire-schemas.ts`'s registry, `payment-pix-regenerate.schema.ts`, or
 * `buildToolSurface` itself). NO `staffEnvelopeActor` is supplied (the
 * planner's documented customer-plane default), so the composed system
 * prompt is `PLANNER_PERSONA` — the same fragment every customer capability
 * shares, byte-identical, in full (see this module's header for why there is
 * no marker-delimited paragraph to excerpt here).
 */
export async function computePaymentPixRegenerateExtractionPromptFragment(): Promise<ExtractionPromptFragment> {
  const { model, calls } = noToolCallModel();
  const planner = createIbatexasPlanner({
    model,
    modelId: "claude-test",
    capabilityPlanners: [capPlanner(["payment.pix.regenerate"])],
  });

  await planner.propose(mkState("oi"));
  const req = calls[0]!;
  const tool = (req.tools ?? []).find((t) => t.name === EXPRESS_INTENT_TOOL);
  if (tool === undefined) {
    throw new Error("extraction-prompt golden: express_intent tool missing from buildToolSurface output");
  }

  return {
    capability: "payment.pix.regenerate",
    expressIntentTool: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    personaExcerpt: PLANNER_PERSONA,
  };
}
