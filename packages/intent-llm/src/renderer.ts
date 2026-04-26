/**
 * PromptRenderer — cosmetic layer.
 *
 * Takes (state, context, plan) + optional modifiers and produces the prompt
 * text the LLM sees. Consumes the Plan produced by the security-sensitive
 * CapabilityPlanner — does NOT make capability decisions of its own.
 */

import type { Plan } from "./planner.js";

export interface RenderedPrompt {
  readonly systemPrompt: string;
  readonly toolSchemas: ReadonlyArray<ToolSchema>;
  readonly maxTokens: number;
}

/**
 * Anthropic/OpenAI-style tool schema. Framework keeps the shape generic —
 * adopters convert to the SDK-specific type at the responder boundary.
 */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface SupervisorModifiers {
  readonly mode?: string;
  readonly tone?: string;
  readonly momentum?: number;
}

export interface PromptRenderer<S, C = unknown> {
  render(
    state: S,
    context: C,
    plan: Plan,
    modifiers?: SupervisorModifiers,
  ): RenderedPrompt;
}
