// Decision-aware responder (Phase A — the bug fix).
//
// The previous `naiveResponder` rendered a reply from ONLY the user's text
// (`input.cognition.perception.text`) and ignored the kernel `Decision` it was
// already handed. So the chat could say "não tenho acesso ao sistema de
// pedidos" while the audited decision was `REFUSE · order.not_found`. Chat text
// contradicting the audit ledger is a correctness/compliance defect.
//
// This responder branches on `input.decision.kind` (claustrum Hard Rule: the
// ResponderPort is handed the decision — `@claustrum/core` ports/responder.ts):
//
//   REFUSE (a proposed action was refused)  → ExplainerPort.render(refusal)
//       VERBATIM, model-free. Single-sources the pt-BR refusal and is
//       SECURITY-safe via the explainer's own SECURITY branch. Determinism on
//       REFUSE is a hard requirement (any "warmer refusals" demand is met by
//       editing the pt-BR registry, never by reintroducing a decision-blind
//       synthesis path).
//   REFUSE on an EMPTY plan (nothing proposed — small-talk that the audited
//       bridge fail-closes into REFUSE·empty_plan) → conversational model reply.
//       There is no proposed action to contradict, so a normal reply is correct
//       (and matches the `empty_plan` golden). Uses the SAME persona prompt the
//       old naiveResponder used, so a no-action turn is byte-identical.
//   REQUEST_CONFIRMATION  → decision.prompt (the confirm question the guard set).
//   ESCALATE              → a fixed pt-BR handoff line (model-free, deterministic).
//   EXECUTE / REWRITE / DEFER → a model reply GROUNDED in decision.kind + a
//       narrowed `acted` (DispatchResult) + the proposed capabilities, so the
//       reply states what actually happened and never contradicts the action.
//
// B/C will swap the two model-call system prompts for a claustrum
// `PromptComposer` composition (content-addressed) and inject a `TelemetryPort`
// so each model call emits an `LLMTrace`. The `system`/`composeSystem` seam +
// optional `onModelCall` hook below are the forward-compatible seams for that.

import type { ModelProvider } from "@claustrum/core";
import type { DraftResponse, ResponderPort } from "@claustrum/core";
import type { Decision } from "@adjudicate/core";
import type { ExplainerPort } from "@claustrum/core";

/** Persona used for a no-action / conversational turn (kept byte-identical to
 * the legacy naiveResponder so the `empty_plan` golden stays green). */
export const RESPONDER_PERSONA_PTBR =
  "Você é o atendente da IbateXas. Responda em pt-BR de forma curta e clara.";

/** Persona for a turn where the kernel DECIDED + the runtime ACTED — the reply
 * must communicate what happened, grounded in the decision context. */
export const RESPONDER_GROUNDED_PERSONA_PTBR = [
  "Você é o atendente da IbateXas. Responda em pt-BR de forma curta, clara e cordial.",
  "O sistema JÁ avaliou o pedido do cliente e tomou uma decisão (registrada e auditada),",
  "e executou (ou registrou) a ação correspondente. Sua tarefa é APENAS comunicar ao",
  "cliente o que aconteceu, com base no CONTEXTO abaixo.",
  "NUNCA diga que não tem acesso ao sistema nem contradiga a decisão tomada.",
  "Não invente dados que não estejam no contexto, nem prometa ações que não foram decididas.",
].join("\n");

/** Fixed pt-BR handoff line for ESCALATE (model-free, deterministic). */
export const RESPONDER_ESCALATE_PTBR =
  "Vou transferir você para um de nossos atendentes. Só um momento, por favor.";

const DEFAULT_MAX_TOKENS = 1024;

export interface IbatexasResponderDeps {
  /** Consumed surface is exactly the ModelProvider port (`.complete()`). */
  readonly model: ModelProvider;
  /** Resolved fail-fast at boot by bootstrapClaustrum() — no fallback. */
  readonly modelId: string;
  /** Renders kernel/pack refusals to pt-BR (reused; see ibatexasExplainer). */
  readonly explainer: ExplainerPort;
  readonly maxTokens?: number;
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
  const execs = (acted as { executions?: ReadonlyArray<{ envelope?: { kind?: unknown } }> })
    .executions;
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

  async function completeWith(
    system: string,
    userText: string,
  ): Promise<DraftResponse> {
    const completion = await deps.model.complete({
      model: deps.modelId,
      maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    });
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

      switch (decision.kind) {
        case "REFUSE": {
          // A REFUSE on an EMPTY plan is the "nothing to authorize" sentinel
          // (small-talk / informational turn) — there is no proposed action to
          // contradict, so reply conversationally (model-free determinism is
          // reserved for refusals of an actual proposed action).
          if (input.plan.envelopes.length === 0) {
            return completeWith(RESPONDER_PERSONA_PTBR, userText);
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
          const context = {
            decision: decision.kind,
            capabilities,
            acted: summarizeActed(input.acted),
          };
          const system =
            `${RESPONDER_GROUNDED_PERSONA_PTBR}\n\n` +
            `CONTEXTO DA DECISÃO (fonte da verdade, não inventar):\n` +
            JSON.stringify(context);
          return completeWith(system, userText);
        }

        default: {
          // Exhaustiveness guard — a new Decision kind must be handled here.
          const _exhaustive: never = decision;
          void _exhaustive;
          return completeWith(RESPONDER_PERSONA_PTBR, userText);
        }
      }
    },
  };
}
