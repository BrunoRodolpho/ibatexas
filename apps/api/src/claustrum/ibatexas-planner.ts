/**
 * Production planner — RC-A1 Stage 2 (Phase A.1).
 *
 * Replaces `naivePlanner` (which emits `[]`) with an LLM-driven intent
 * extractor. Implements the claustrum `PlannerPort`: reads the assembled
 * `CognitiveState` and proposes `IntentEnvelope[]` for the cognitive loop to
 * adjudicate. NO mutation happens here — the planner only *proposes*; the
 * kernel disposes (claustrum Hard Rule #1 / #3).
 *
 * Tool surface exposed to the LLM (claustrum Hard Rule #1 — "the LLM is a
 * semantic parser with zero state-mutation authority; it sees exactly one
 * mutating tool: express_intent(capability, payload)"):
 *
 *   - `express_intent` — the single mutation-proposing tool. Its `capability`
 *     argument is constrained (enum) to the union of the installed packs'
 *     `allowedIntents` for THIS turn's state. Those allowed intents are domain
 *     intent KINDS (`order.item.add`, `payment.charge.create`, …) — the
 *     capability-level contract. Internal tool ids (`ibatexas.cart.addItem.v1`,
 *     `medusa.cart.add`) are NEVER exposed.
 *   - the turn's visible READ tools — read-only enrichment the LLM may call.
 *
 * The pack `CapabilityPlanner`s decide, per state, which read tools are visible
 * and which intents are proposable — that is the security allowlist. The
 * planner enforces it twice: it only advertises allowed intents, and it DROPS
 * any `express_intent` whose capability is not in the allowlist (defense in
 * depth against a hallucinated capability).
 *
 * Every proposed envelope is built via `@adjudicate/core`'s `buildEnvelope`
 * (canonical v2 hash) with `actor.principal = "llm"` and `taint = "UNTRUSTED"`
 * — the kernel's tamper-evidence + taint gate then apply. The composition root
 * pairs this with `composePolicyRouter` (capability-policy.ts) so a proposed
 * envelope is adjudicated against its owning pack's PolicyBundle.
 *
 * v1 scope — SINGLE LLM pass. The model may, in one turn, call read tools
 * (recorded in `readToolCalls` for telemetry) and/or `express_intent` (→
 * envelopes). A multi-hop enrichment loop (execute a read tool, feed the result
 * back, re-prompt) is a documented follow-up; the single pass covers the common
 * "user expresses an action" case correctly and deterministically.
 *
 * Pure + dependency-injected (model + capability planners passed in), so it is
 * unit-testable with a mocked `ModelProvider` and hand-built capability
 * planners. Wired into `createConductor` by `claustrum-bootstrap.ts`.
 */

import { randomUUID } from "node:crypto";
import { buildEnvelope } from "@adjudicate/core";
import type { IntentEnvelope } from "@adjudicate/core";
import type {
  CapabilityPlanner,
  Plan as CapabilityPlan,
} from "@adjudicate/core/llm";
import type {
  CognitiveState,
  CompletionRequest,
  ModelProvider,
  Plan,
  PlannerPort,
} from "@claustrum/core";

/** Per claustrum Hard Rule #1 — the single mutation-proposing tool name. */
export const EXPRESS_INTENT_TOOL = "express_intent";

const DEFAULT_MAX_TOKENS = 1024;

// Empirically tuned against the Phase-A live ceiling: the first prompt
// under-extracted ID-dependent intents (remove/update/checkout/cancel) ~33% of
// the time because the model withheld the call when it lacked an item/order id.
// Instructing it to express the intent with a natural-language payload and let
// the handler resolve identifiers took the synthetic ceiling 66.7% → 100%.
const DEFAULT_SYSTEM_PROMPT = [
  "Você é o interpretador de intenções do atendimento da IbateXas.",
  `Sua única função é traduzir o pedido do cliente em uma chamada de "${EXPRESS_INTENT_TOOL}".`,
  "Você NUNCA executa ações nem altera dados — apenas declara a intenção.",
  "",
  "REGRA PRINCIPAL: se o cliente pede QUALQUER ação (adicionar, remover, atualizar",
  "quantidade, aplicar cupom, criar carrinho, finalizar/pagar, cancelar, adicionar",
  `observação, reservar, etc.), você DEVE chamar "${EXPRESS_INTENT_TOOL}" com a capability`,
  "correspondente (exatamente uma das opções do enum). Faça isso MESMO que falte algum",
  "detalhe (ex.: o id exato do item, do pedido ou do carrinho) — preencha o payload com",
  "o que o cliente disse em linguagem natural (ex.: { item: 'linguiça' } ou",
  "{ quantidade: 3 }); o handler resolve os identificadores depois. NÃO peça confirmação",
  "e NÃO faça perguntas de esclarecimento aqui.",
  "",
  "Use as ferramentas de leitura apenas para consultar informações. Não invente",
  `capabilities fora da lista. Só NÃO chame "${EXPRESS_INTENT_TOOL}" quando o cliente`,
  "claramente não pede nenhuma ação (ex.: perguntas sobre horário, cardápio ou preço).",
].join("\n");

export interface IbatexasPlannerDeps {
  /** LLM port (claustrum ModelProvider — AnthropicProvider in production). */
  readonly model: ModelProvider;
  /** Model id, e.g. process.env.ANTHROPIC_MODEL. */
  readonly modelId: string;
  /**
   * The installed packs' capability planners. Each returns, for the turn's
   * (state, context), the visible read tools + proposable intent kinds. The
   * planner unions them.
   */
  readonly capabilityPlanners: ReadonlyArray<CapabilityPlanner<unknown, unknown>>;
  /**
   * Map the claustrum `CognitiveState` onto the (state, context) shape the pack
   * capability planners expect. Defaults to a minimal pass-through carrying the
   * tenant + locale; adopters with a richer pack-state shape inject their own.
   */
  readonly deriveContext?: (state: CognitiveState) => {
    readonly state: unknown;
    readonly context: unknown;
  };
  /** Override the system prompt (defaults to the pt-BR semantic-parser prompt). */
  readonly system?: string;
  readonly maxTokens?: number;
  /**
   * Per-envelope nonce source (T3-2). The nonce is the kernel's replay key:
   * `intentHash` folds it, so a deterministic nonce is what lets the Execution
   * Ledger and the kernel dedup a re-delivered trigger. The default
   * ({@link deriveDeterministicNonce}) reads `state.perception.externalId` —
   * the `${sourceSubject}:${eventId}` carrier the SystemChannel (T3-1) sets on
   * trigger turns — and falls back to `randomUUID()` for conversational turns
   * (web/WhatsApp leave `externalId` unset), so ONE planner instance serves
   * both surfaces. `envelopeIndex` disambiguates a multi-envelope plan
   * (otherwise every envelope in one redelivered trigger would collide on the
   * same hash). Adopters may inject their own, but it MUST stay deterministic
   * across redeliveries.
   */
  readonly deriveNonce?: (state: CognitiveState, envelopeIndex: number) => string;
}

/**
 * Default {@link IbatexasPlannerDeps.deriveNonce} (T3-2): deterministic when a
 * trigger carrier is present, random otherwise.
 *
 * - Trigger turns (SystemChannel): `state.perception.externalId` is
 *   `${sourceSubject}:${eventId}`; the first envelope reuses it verbatim and
 *   each subsequent envelope appends a `#<index>` suffix. A re-delivered event
 *   therefore reproduces byte-identical nonces → identical `intentHash`es →
 *   ledger/kernel dedup (the host-level BullMQ jobId + cooldown in the trigger
 *   bridge are the PRIMARY loop-breakers; this is the in-hash backstop).
 * - Conversational turns (web/WhatsApp): no `externalId`, so each turn gets a
 *   fresh `randomUUID()` — preserving the pre-T3-2 behavior exactly.
 */
export function deriveDeterministicNonce(
  state: CognitiveState,
  envelopeIndex: number,
): string {
  const externalId = state.perception.externalId;
  if (externalId === undefined || externalId.length === 0) {
    return randomUUID();
  }
  return envelopeIndex === 0 ? externalId : `${externalId}#${envelopeIndex}`;
}

interface ExpressIntentInput {
  readonly capability: string;
  readonly payload?: unknown;
}

function isExpressIntentInput(input: unknown): input is ExpressIntentInput {
  return (
    input !== null &&
    typeof input === "object" &&
    typeof (input as { capability?: unknown }).capability === "string"
  );
}

/** Merge each capability planner's Plan into one union allowlist for the turn. */
function unionPlans(
  planners: ReadonlyArray<CapabilityPlanner<unknown, unknown>>,
  state: unknown,
  context: unknown,
): CapabilityPlan {
  const reads = new Set<string>();
  const intents = new Set<string>();
  for (const planner of planners) {
    const plan = planner.plan(state, context);
    for (const r of plan.visibleReadTools) reads.add(r);
    for (const i of plan.allowedIntents) intents.add(i);
  }
  return {
    visibleReadTools: [...reads],
    allowedIntents: [...intents],
  };
}

/**
 * Build the LLM tool surface for this turn: the single `express_intent` tool
 * (its `capability` constrained to the allowed intents) plus the visible read
 * tools. Returns `tools` empty-safe — when no intent is proposable and no read
 * tool is visible, the LLM simply has nothing to call.
 */
function buildToolSurface(plan: CapabilityPlan): CompletionRequest["tools"] {
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }> = [];

  if (plan.allowedIntents.length > 0) {
    tools.push({
      name: EXPRESS_INTENT_TOOL,
      description:
        "Declarar uma intenção de mutação para o kernel adjudicar. " +
        "Use `capability` (uma das opções do enum) e `payload` com os dados.",
      inputSchema: {
        type: "object",
        properties: {
          capability: {
            type: "string",
            enum: [...plan.allowedIntents],
            description: "A capability/intent kind a ser proposta.",
          },
          payload: {
            type: "object",
            description: "Dados da intenção (campos específicos da capability).",
          },
        },
        required: ["capability", "payload"],
        additionalProperties: false,
      },
    });
  }

  for (const read of plan.visibleReadTools) {
    tools.push({
      name: read,
      description: `Ferramenta de leitura: ${read}. Apenas consulta, não altera dados.`,
      inputSchema: { type: "object", additionalProperties: true },
    });
  }

  return tools;
}

/**
 * Create the production ibatexas planner.
 *
 * The returned `PlannerPort.propose` performs ONE LLM completion with the
 * turn's tool surface and translates each in-plan `express_intent` call into an
 * `IntentEnvelope`. Out-of-plan capabilities are dropped (recorded in the
 * rationale); read-tool calls are recorded in `readToolCalls`.
 */
export function createIbatexasPlanner(deps: IbatexasPlannerDeps): PlannerPort {
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const system = deps.system ?? DEFAULT_SYSTEM_PROMPT;
  const deriveNonce = deps.deriveNonce ?? deriveDeterministicNonce;

  return {
    async propose(state: CognitiveState): Promise<Plan> {
      const derived = deps.deriveContext?.(state) ?? {
        state: { tenantId: state.tenantId, locale: state.locale },
        context: {},
      };
      const plan = unionPlans(
        deps.capabilityPlanners,
        derived.state,
        derived.context,
      );

      // Nothing proposable and nothing to read → skip the LLM entirely; the
      // response phase still runs (envelopes:[] is a valid "respond-only" plan).
      const tools = buildToolSurface(plan);
      if (tools === undefined || tools.length === 0) {
        return {
          envelopes: [],
          rationale: "ibatexas-planner: no proposable intents for this state",
          capabilities: [],
          readToolCalls: [],
        };
      }

      const allowed = new Set(plan.allowedIntents);
      const completion = await deps.model.complete({
        model: deps.modelId,
        system,
        messages: [{ role: "user", content: state.perception.text }],
        tools,
        maxTokens,
      });

      const envelopes: IntentEnvelope[] = [];
      const capabilities: string[] = [];
      const readToolCalls: Array<{ name: string; input: unknown }> = [];
      const dropped: string[] = [];

      for (const call of completion.toolCalls ?? []) {
        if (call.name === EXPRESS_INTENT_TOOL) {
          if (!isExpressIntentInput(call.input)) {
            dropped.push(`${EXPRESS_INTENT_TOOL}(malformed)`);
            continue;
          }
          const { capability, payload } = call.input;
          // Defense in depth: never build an envelope for a capability the
          // pack planners did not authorize this turn, even if the model
          // (or a compromised prompt) emits one.
          if (!allowed.has(capability)) {
            dropped.push(capability);
            continue;
          }
          envelopes.push(
            buildEnvelope({
              kind: capability,
              payload: payload ?? {},
              actor: { principal: "llm", sessionId: state.conversationId },
              taint: "UNTRUSTED",
              nonce: deriveNonce(state, envelopes.length),
            }),
          );
          capabilities.push(capability);
        } else if (plan.visibleReadTools.includes(call.name)) {
          readToolCalls.push({ name: call.name, input: call.input });
        } else {
          dropped.push(call.name);
        }
      }

      const rationale =
        dropped.length > 0
          ? `ibatexas-planner: ${envelopes.length} envelope(s); dropped out-of-plan [${dropped.join(", ")}]`
          : `ibatexas-planner: ${envelopes.length} envelope(s)`;

      // F4 / cost accounting: report this turn's planning-model token usage so
      // the loop folds it onto the TurnRecord (emitTurn → per-session counter).
      return {
        envelopes,
        rationale,
        capabilities,
        readToolCalls,
        usage: {
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
        },
      };
    },
  };
}
