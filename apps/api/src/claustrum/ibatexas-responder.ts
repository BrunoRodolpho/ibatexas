// Decision-aware responder (Phase A — the bug fix; Phase B/C — content-addressed
// prompts + per-call LLM trace).
//
// The previous `naiveResponder` rendered a reply from ONLY the user's text and
// ignored the kernel `Decision` it was handed, so the chat could say "não tenho
// acesso ao sistema de pedidos" while the audited decision was `REFUSE ·
// order.not_found`. Chat text contradicting the audit ledger is a
// correctness/compliance defect.
//
// This responder branches on `input.decision.kind`:
//   REFUSE (a proposed action was refused)  → ExplainerPort.render(refusal)
//       VERBATIM, model-free, SECURITY-safe, deterministic.
//   REFUSE on an EMPTY plan (small-talk; the `empty_plan` "nothing to authorize"
//       sentinel)               → conversational model reply (persona prompt).
//   REQUEST_CONFIRMATION         → decision.prompt.
//   ESCALATE                     → a fixed pt-BR handoff line (model-free).
//   EXECUTE / REWRITE / DEFER    → a model reply GROUNDED in decision.kind +
//       a narrowed `acted` (DispatchResult) + capabilities.
//
// Phase B/C: the two model-call branches compose their system prompt via the
// claustrum PromptComposer (content-addressed fragments) and, when a
// TelemetryPort is wired, emit a bounded LLMTrace per call (id@hash manifest).
// When neither is injected (unit tests), it falls back to the static personas
// and emits nothing — byte-identical to the Phase-A behavior.

import type {
  DraftResponse,
  ExplainerPort,
  ModelProvider,
  ResponderPort,
  TelemetryPort,
} from "@claustrum/core";
import type { Decision } from "@adjudicate/core";
import {
  RESPONDER_ESCALATE_PTBR,
  RESPONDER_GROUNDED_PERSONA_PTBR,
  RESPONDER_PERSONA_PTBR,
} from "./prompts/personas.js";
import {
  RESPONDER_CONVERSATIONAL_SURFACE,
  RESPONDER_GROUNDED_SURFACE,
  type IbatexasPromptComposer,
} from "./prompts/ibatexas-prompts.js";
import { emitModelCallTrace } from "./llm-trace.js";

// Re-export so existing importers (tests) keep their import site.
export {
  RESPONDER_ESCALATE_PTBR,
  RESPONDER_GROUNDED_PERSONA_PTBR,
  RESPONDER_PERSONA_PTBR,
};

const DEFAULT_MAX_TOKENS = 1024;
const PROMPT_BUDGET = { maxTokens: 100_000 } as const;

export interface IbatexasResponderDeps {
  /** Consumed surface is exactly the ModelProvider port (`.complete()`). */
  readonly model: ModelProvider;
  /** Resolved fail-fast at boot by bootstrapClaustrum() — no fallback. */
  readonly modelId: string;
  /** Renders kernel/pack refusals to pt-BR (reused; see ibatexasExplainer). */
  readonly explainer: ExplainerPort;
  readonly maxTokens?: number;
  /** Content-addressed prompt composer (Phase B). When present, the model-call
   * branches compose their system from registered fragments. */
  readonly promptComposer?: IbatexasPromptComposer;
  /** Telemetry sink for the per-model-call LLMTrace (C1). */
  readonly telemetry?: TelemetryPort;
}

/** Best-effort, BOUNDED summary of the dispatch result for model grounding.
 * Never throws; surfaces only what the reply needs ("what was done"). */
function summarizeActed(acted: unknown): Record<string, unknown> | undefined {
  if (acted === null || typeof acted !== "object") return undefined;
  const a = acted as { kind?: unknown; toolId?: unknown; result?: unknown };
  if (typeof a.kind !== "string") return undefined;
  const out: Record<string, unknown> = { dispatch: a.kind };
  const env = (acted as { envelope?: { kind?: unknown } }).envelope;
  if (env && typeof env.kind === "string") out.executed = env.kind;
  const execs = (
    acted as { executions?: ReadonlyArray<{ envelope?: { kind?: unknown } }> }
  ).executions;
  if (Array.isArray(execs)) {
    out.executed = execs
      .map((e) => e.envelope?.kind)
      .filter((k): k is string => typeof k === "string");
  }
  if ("result" in a && a.result !== undefined) out.result = a.result;
  const signal = (acted as { signal?: unknown }).signal;
  if (typeof signal === "string") out.signal = signal;
  const message = (acted as { message?: unknown }).message;
  if (typeof message === "string") out.message = message;
  return out;
}

export function createIbatexasResponder(
  deps: IbatexasResponderDeps,
): ResponderPort {
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;

  /** Compose the system for a model-call branch; falls back to the static
   * persona when no composer is wired. Returns the (possibly empty) manifest. */
  async function composeSystem(
    surface: string,
    fallback: string,
    cognition: unknown,
    capabilities: ReadonlyArray<string>,
  ): Promise<{ system: string; fragmentManifest: ReadonlyArray<string> }> {
    if (deps.promptComposer === undefined) {
      return { system: fallback, fragmentManifest: [] };
    }
    const composed = await deps.promptComposer.composer.compose(
      {
        cognition: cognition as never,
        capabilities: [...capabilities],
        extra: { surface },
      },
      PROMPT_BUDGET,
    );
    return {
      system: composed.system,
      fragmentManifest: composed.fragmentManifest,
    };
  }

  async function completeWith(args: {
    system: string;
    fragmentManifest: ReadonlyArray<string>;
    userText: string;
    turnId: string;
    intentHash?: string;
  }): Promise<DraftResponse> {
    const startedAt = Date.now();
    const completion = await deps.model.complete({
      model: deps.modelId,
      maxTokens,
      system: args.system,
      messages: [{ role: "user", content: args.userText }],
    });
    const durationMs = Date.now() - startedAt;

    if (deps.promptComposer !== undefined && deps.telemetry !== undefined) {
      await emitModelCallTrace({
        telemetry: deps.telemetry,
        registry: deps.promptComposer.registry,
        turnId: args.turnId,
        model: deps.modelId,
        fragmentManifest: args.fragmentManifest,
        completionText: completion.text,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        durationMs,
        at: new Date().toISOString(),
        ...(args.intentHash !== undefined ? { intentHash: args.intentHash } : {}),
      });
    }

    return {
      text: completion.text,
      // F4 / cost accounting: report this turn's synthesis-model token usage so
      // the loop sums it (plan.usage + draft.usage) onto the TurnRecord.
      usage: {
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      },
    };
  }

  return {
    async respond(input): Promise<DraftResponse> {
      const decision = input.decision as Decision;
      const userText = input.cognition.perception.text;
      const turnId = input.cognition.turnId;
      const firstEnvelope = input.plan.envelopes[0] as
        | { intentHash?: string }
        | undefined;
      const intentHash = firstEnvelope?.intentHash;

      switch (decision.kind) {
        case "REFUSE": {
          // A REFUSE on an EMPTY plan is the "nothing to authorize" sentinel
          // (small-talk / informational turn) — reply conversationally.
          if (input.plan.envelopes.length === 0) {
            const { system, fragmentManifest } = await composeSystem(
              RESPONDER_CONVERSATIONAL_SURFACE,
              RESPONDER_PERSONA_PTBR,
              input.cognition,
              [],
            );
            return completeWith({ system, fragmentManifest, userText, turnId });
          }
          // A real action refusal: render the pt-BR refusal VERBATIM (model-free,
          // single-sourced, SECURITY-safe). This is the bug fix.
          return { text: deps.explainer.render(decision.refusal) };
        }

        case "REQUEST_CONFIRMATION":
          // The guard already authored the confirm question; surface it verbatim.
          return { text: decision.prompt };

        case "ESCALATE":
          return { text: RESPONDER_ESCALATE_PTBR };

        case "EXECUTE":
        case "REWRITE":
        case "DEFER": {
          // The kernel decided + the runtime acted — ground the reply in what
          // happened so it can never contradict the audited action.
          const capabilities =
            input.plan.capabilities ??
            input.plan.envelopes.map((e) => String(e.kind));
          const { system: baseSystem, fragmentManifest } = await composeSystem(
            RESPONDER_GROUNDED_SURFACE,
            RESPONDER_GROUNDED_PERSONA_PTBR,
            input.cognition,
            capabilities,
          );
          const context = {
            decision: decision.kind,
            capabilities,
            acted: summarizeActed(input.acted),
          };
          const system =
            `${baseSystem}\n\n` +
            `CONTEXTO DA DECISÃO (fonte da verdade, não inventar):\n` +
            JSON.stringify(context);
          return completeWith({
            system,
            fragmentManifest,
            userText,
            turnId,
            ...(intentHash !== undefined ? { intentHash } : {}),
          });
        }

        default: {
          // Exhaustiveness guard — a new Decision kind must be handled here.
          const _exhaustive: never = decision;
          void _exhaustive;
          const { system, fragmentManifest } = await composeSystem(
            RESPONDER_CONVERSATIONAL_SURFACE,
            RESPONDER_PERSONA_PTBR,
            input.cognition,
            [],
          );
          return completeWith({ system, fragmentManifest, userText, turnId });
        }
      }
    },
  };
}
