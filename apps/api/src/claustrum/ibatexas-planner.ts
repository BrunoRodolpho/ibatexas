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
import type { CandidateClaim, IntentEnvelope, TurnTerminal } from "@adjudicate/core";
import {
  CLAIM_REGISTRY,
  checkCompleteness,
  constrainClaimGeneration,
  deriveCandidateValues,
  hasUnmappedSpan,
  routeSafety,
  type ProposedClaim,
  type RequestSpan,
  type SafetyRoutingInput,
  type SpanCompleteness,
} from "./claim-registry.js";
import type {
  CapabilityPlanner,
  Plan as CapabilityPlan,
} from "@adjudicate/core/llm";
import type {
  CognitiveState,
  Completion,
  CompletionRequest,
  ModelProvider,
  Plan,
  PlannerPort,
  TelemetryPort,
} from "@claustrum/core";
import {
  CLAIM_PLANNER_PERSONA,
  EXPRESS_INTENT_TOOL,
  PLANNER_PERSONA,
} from "./prompts/personas.js";
import {
  PLANNER_SURFACE,
  type IbatexasPromptComposer,
} from "./prompts/ibatexas-prompts.js";
import { emitModelCallTrace } from "./llm-trace.js";
import {
  closedHoursPromptNote,
  type ScheduleSignal,
} from "./closed-hours.js";

// Re-export so existing importers (tests, registry) keep their import site.
export { EXPRESS_INTENT_TOOL };

const DEFAULT_MAX_TOKENS = 1024;

/**
 * The single CLAIM-proposing tool (Q6b — SDD §H/§P3; claim-registry v0.1 §1).
 * The CLAIM analogue of `express_intent`: the model SELECTS a registry claim
 * type (its `type` arg constrained by `enum` to {@link CLAIM_REGISTRY}) and
 * binds runtime params — it never free-generates a claim type. Out-of-enum
 * proposals are dropped by the constrained-generation wall
 * (`constrainClaimGeneration`), exactly as a hallucinated `express_intent`
 * capability is dropped by the `allowedIntents` guard.
 */
export const PROPOSE_CLAIM_TOOL = "propose_claim";

// Token budget for the persona composition — the persona is tiny, so any
// generous budget keeps the inviolable fragment.
const PROMPT_BUDGET = { maxTokens: 100_000 } as const;

// Empirically tuned against the Phase-A live ceiling: the first prompt
// under-extracted ID-dependent intents (remove/update/checkout/cancel) ~33% of
// the time because the model withheld the call when it lacked an item/order id.
// Instructing it to express the intent with a natural-language payload and let
// the handler resolve identifiers took the synthetic ceiling 66.7% → 100%.
// The persona text now lives in claustrum/prompts/personas.ts (PLANNER_PERSONA)
// so it can be registered as a content-addressed PromptFragment (Phase B);
// kept byte-identical to the recorded golden surface.
const DEFAULT_SYSTEM_PROMPT = PLANNER_PERSONA;

export interface IbatexasPlannerDeps {
  /** LLM port (claustrum ModelProvider — AnthropicProvider in production). */
  readonly model: ModelProvider;
  /** Model id, e.g. process.env.ANTHROPIC_MODEL. */
  readonly modelId: string;
  /**
   * Content-addressed prompt composer (Phase B). When present, the planner
   * composes its system prompt from the registered persona fragment (so the
   * `fragmentManifest` — id@hash — can be recorded in the turn trace) instead
   * of using the static string. The composed system is byte-identical to
   * DEFAULT_SYSTEM_PROMPT (single inviolable fragment).
   */
  readonly promptComposer?: IbatexasPromptComposer;
  /**
   * Telemetry sink for the per-model-call LLMTrace (C1). When present (with a
   * composer), the planner emits a bounded trace after the model completion.
   */
  readonly telemetry?: TelemetryPort;
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
  /**
   * Resolve the current structured open/closed signal for THIS turn (fix B,
   * Stage 1). When it reports `isClosed`, a pt-BR closed-hours note is appended
   * to the planner's LLM context so planning knows the store is closed (the soft
   * layer; the deterministic backstop lives in the responder). Time-dependent, so
   * it is invoked per `propose()`. Omitted in unit tests → no prompt change.
   */
  readonly resolveScheduleSignal?: () =>
    | Promise<ScheduleSignal | undefined>
    | ScheduleSignal
    | undefined;
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

/**
 * The raw shape of a `propose_claim` tool call's `input` (Q6b — SDD §H). The
 * model proposes a `type` (a FREE string — it may hallucinate one outside the
 * registry; the constrained-generation wall constrains it) and a same-subject
 * `subject` key. tag-then-derive (STEP 1): there is NO `value` field — the model
 * never authors a value; it is derived first-party downstream. Validated
 * structurally before it becomes a `ProposedClaim`.
 */
interface ProposeClaimInput {
  readonly type: string;
  readonly subject?: string;
  readonly actor?: unknown;
  readonly resources?: Readonly<Record<string, unknown>>;
  /** Free-text safety markers the model flagged on the request (SDD §O#8/§O#9). */
  readonly safetyMarkers?: readonly string[];
  /**
   * The request spans the model segmented (SDD §O#8) with each span's mapped
   * claim type (or absent for an unmapped span) — the P4 completeness input.
   */
  readonly spans?: ReadonlyArray<{ text: string; mappedClaimType?: string }>;
}

function isProposeClaimInput(input: unknown): input is ProposeClaimInput {
  return (
    input !== null &&
    typeof input === "object" &&
    typeof (input as { type?: unknown }).type === "string"
  );
}

/**
 * The output of the claim-aware planner port (Q6b — SDD §H/§P3/§P4/§O#9). The
 * deterministically-walled result the claustrum CLAIMS-VALIDATE stage (Q6a)
 * consumes: the typed candidates feed `runClaimsKernel`; the completeness map +
 * the forced terminal carry the two safe-state decisions the kernel does NOT
 * make (P4 completeness, §O#9 safety routing) so a span never silently drops
 * and an unrecognized safety framing never passes through.
 */
export interface ClaimPlan {
  /**
   * The typed `@adjudicate/core` `CandidateClaim`s that PASSED the registry-enum
   * constrained-generation wall (SDD §H/§P3). Exactly the `runClaimsKernel`
   * input shape (Q6a). A model-proposed out-of-enum type is NOT here.
   */
  readonly candidates: readonly CandidateClaim[];
  /**
   * The P4 completeness map (SDD §C P4 / §J.8): every request span paired with
   * its deterministic disposition (a registry type / `UNKNOWN` / `ESCALATE` /
   * `CLARIFY`). An unmapped span is a `CLARIFY` here — never silently dropped.
   */
  readonly completeness: readonly SpanCompleteness[];
  /**
   * The FORCED turn terminal, when a deterministic wall overrides normal
   * rendering: `ESCALATE` from the §O#9 closed-taxonomy safety router (an
   * unrecognized/any safety marker), or `CLARIFY` from P4 (an unmapped span).
   * `undefined` when no wall forced a terminal — the turn proceeds to the
   * Claims kernel over `candidates`. The §O#9 ESCALATE takes precedence over a
   * P4 CLARIFY (a safety escalation outranks a disambiguation).
   */
  readonly forcedTerminal?: Extract<TurnTerminal, "ESCALATE" | "CLARIFY">;
  /** Out-of-enum claim types the constrained-generation wall dropped (telemetry). */
  readonly droppedClaimTypes: readonly string[];
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
 * Translate the model's tool calls into the planner's outputs (RC-A1): each
 * in-plan `express_intent` becomes an `IntentEnvelope`; a visible read tool is
 * recorded in `readToolCalls`; a malformed/out-of-plan/unknown call is dropped
 * (recorded in `dropped` for the rationale). Pure over the call list + the
 * turn's allowlist — the same "model proposes, deterministic checks dispose"
 * shape as `propose`, extracted so `propose` stays within complexity budget.
 */
function translateToolCalls(args: {
  readonly toolCalls: Completion["toolCalls"];
  readonly allowed: ReadonlySet<string>;
  readonly visibleReadTools: ReadonlyArray<string>;
  readonly state: CognitiveState;
  readonly deriveNonce: (state: CognitiveState, envelopeIndex: number) => string;
}): {
  envelopes: IntentEnvelope[];
  capabilities: string[];
  readToolCalls: Array<{ name: string; input: unknown }>;
  dropped: string[];
} {
  const envelopes: IntentEnvelope[] = [];
  const capabilities: string[] = [];
  const readToolCalls: Array<{ name: string; input: unknown }> = [];
  const dropped: string[] = [];

  for (const call of args.toolCalls ?? []) {
    if (call.name === EXPRESS_INTENT_TOOL) {
      if (!isExpressIntentInput(call.input)) {
        dropped.push(`${EXPRESS_INTENT_TOOL}(malformed)`);
        continue;
      }
      const { capability, payload } = call.input;
      // Defense in depth: never build an envelope for a capability the
      // pack planners did not authorize this turn, even if the model
      // (or a compromised prompt) emits one.
      if (!args.allowed.has(capability)) {
        dropped.push(capability);
        continue;
      }
      envelopes.push(
        buildEnvelope({
          kind: capability,
          payload: payload ?? {},
          actor: { principal: "llm", sessionId: args.state.conversationId },
          taint: "UNTRUSTED",
          nonce: args.deriveNonce(args.state, envelopes.length),
        }),
      );
      capabilities.push(capability);
    } else if (args.visibleReadTools.includes(call.name)) {
      readToolCalls.push({ name: call.name, input: call.input });
    } else {
      dropped.push(call.name);
    }
  }

  return { envelopes, capabilities, readToolCalls, dropped };
}

/**
 * The CLAIM-AWARE planner port (Q6b — SDD §H/§P3/§P4/§O#9; §M ibatexas half of
 * §Q.6). A `PlannerPort` (the existing intent path, UNCHANGED) PLUS the
 * claim-aware `proposeClaims` seam: the additive ibatexas-specific surface the
 * claustrum CLAIMS-VALIDATE stage (Q6a) calls to get the deterministically-
 * walled `ClaimPlan`. Structurally a superset of `PlannerPort`, so every
 * existing consumer that expects a `PlannerPort` keeps working (the extra
 * method is invisible to them).
 */
export interface ClaimAwarePlannerPort extends PlannerPort {
  /**
   * Propose typed `CandidateClaim`s for the turn through the three deterministic
   * walls (SDD §8 / §Q.6): constrained generation over the registry enum
   * (pre-planning), P4 completeness (post-planning), and §O#9 closed-taxonomy
   * safety routing. Returns the {@link ClaimPlan} the Claims kernel + renderer
   * consume. Like `propose`, it only PROPOSES — the kernel disposes.
   */
  proposeClaims(state: CognitiveState): Promise<ClaimPlan>;
}

/**
 * Create the production ibatexas planner.
 *
 * The returned port's `PlannerPort.propose` performs ONE LLM completion with the
 * turn's tool surface and translates each in-plan `express_intent` call into an
 * `IntentEnvelope`. Out-of-plan capabilities are dropped (recorded in the
 * rationale); read-tool calls are recorded in `readToolCalls`.
 *
 * It ALSO exposes `proposeClaims` (Q6b — SDD §H/§P3/§P4/§O#9): the claim-aware
 * seam that runs the constrained-generation wall over the registry enum, the P4
 * completeness post-check, and the §O#9 closed-taxonomy safety router, producing
 * the typed `CandidateClaim`s the claustrum CLAIMS-VALIDATE stage (Q6a) feeds to
 * `runClaimsKernel`. The two surfaces share the same injected `model`.
 */
export function createIbatexasPlanner(
  deps: IbatexasPlannerDeps,
): ClaimAwarePlannerPort {
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
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

      // Compose the system prompt (content-addressed) when a composer is wired.
      // The single inviolable persona fragment makes composed.system ===
      // DEFAULT_SYSTEM_PROMPT, so the recorded golden surfaces stay green; the
      // composed fragmentManifest (id@hash) feeds the turn trace.
      let system = deps.system ?? DEFAULT_SYSTEM_PROMPT;
      let fragmentManifest: ReadonlyArray<string> = [];
      if (deps.system === undefined && deps.promptComposer !== undefined) {
        const composed = await deps.promptComposer.composer.compose(
          { cognition: state, extra: { surface: PLANNER_SURFACE } },
          PROMPT_BUDGET,
        );
        system = composed.system;
        fragmentManifest = composed.fragmentManifest;
      }

      // fix B (Stage 1) — soft layer: when the store is closed, tell the planner
      // so it does not propose immediate-fulfillment intents / so the model knows
      // the real state. Empty string when open → prompt byte-identical to today.
      const scheduleSignal = deps.resolveScheduleSignal
        ? ((await deps.resolveScheduleSignal()) ?? undefined)
        : undefined;
      system += closedHoursPromptNote(scheduleSignal);

      const allowed = new Set(plan.allowedIntents);
      const startedAt = Date.now();
      const completion = await deps.model.complete({
        model: deps.modelId,
        system,
        messages: [{ role: "user", content: state.perception.text }],
        tools,
        maxTokens,
      });
      const durationMs = Date.now() - startedAt;

      // C1 — emit the planner-call LLMTrace (turnId is the correlation key; no
      // intentHash, as the intent is not yet formed at plan time). Best-effort.
      if (deps.promptComposer !== undefined && deps.telemetry !== undefined) {
        await emitModelCallTrace({
          telemetry: deps.telemetry,
          registry: deps.promptComposer.registry,
          turnId: state.turnId,
          model: deps.modelId,
          fragmentManifest,
          completionText: JSON.stringify({
            text: completion.text,
            toolCalls: completion.toolCalls ?? [],
          }),
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          durationMs,
          at: new Date().toISOString(),
        });
      }

      const { envelopes, capabilities, readToolCalls, dropped } =
        translateToolCalls({
          toolCalls: completion.toolCalls,
          allowed,
          visibleReadTools: plan.visibleReadTools,
          state,
          deriveNonce,
        });

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

    // Q6b — the claim-aware seam (SDD §H/§P3/§P4/§O#9). ONE LLM completion over
    // the `propose_claim` tool (its `type` constrained by `enum` to the registry
    // — the pre-planning wall), then the two deterministic post-walls. Mirrors
    // `propose`'s "model proposes, deterministic checks dispose" shape.
    async proposeClaims(state: CognitiveState): Promise<ClaimPlan> {
      // PRE-planning wall, part 1 (SDD §H/§P3): the model's `propose_claim` tool
      // exposes `type` as an `enum` over the registry — the model can only
      // SELECT an in-enum type, never type a free string into the schema. The
      // post-completion `constrainClaimGeneration` is the defense-in-depth
      // backstop (a compromised prompt that bypasses the enum is still dropped).
      const claimTool = {
        name: PROPOSE_CLAIM_TOOL,
        // tag-then-derive (STEP 1 — tag protocol): the model SELECTS only a claim
        // `type` (enum-constrained) + its `subject`. It does NOT — and CANNOT —
        // author a `value`: the value is DERIVED downstream from the first-party
        // ledger read the type's `valueBinding` names (claim-registry.ts
        // `deriveCandidateValues`), so the kernel's C6 value-binding is satisfied
        // by a LEDGER-sourced value, never a 4B confabulation. A typed enum is a
        // harder constraint than a free-text value — far more 4B-robust.
        description:
          "Propor uma afirmação (claim) para o kernel de claims validar. " +
          "Selecione APENAS `type` (uma das opções do enum do registro) e " +
          "`subject` (a chave do recurso). NÃO escreva o valor/proposição — o " +
          "sistema deriva o valor da fonte primária. Nunca invente um tipo fora do enum.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [...CLAIM_REGISTRY],
              description: "O tipo de claim do registro a ser proposto.",
            },
            subject: { type: "string", description: "Chave do recurso/assunto." },
            safetyMarkers: {
              type: "array",
              items: { type: "string" },
              description: "Marcadores de saúde/segurança detectados (se houver).",
            },
            spans: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  mappedClaimType: { type: "string" },
                },
                required: ["text"],
              },
              description: "Os trechos do pedido e o claim mapeado a cada um.",
            },
          },
          required: ["type", "subject"],
          additionalProperties: false,
        },
      };

      // tag-then-derive (STEP 1): the CLAIM path uses a CLAIM-framed persona, NOT
      // the intent persona (DEFAULT_SYSTEM_PROMPT) — the intent persona's "sua
      // única função é express_intent" SUPPRESSES the propose_claim call on a 4B
      // (verified live on nemotron-3-nano:4b). `deps.system` still overrides (tests).
      const system = deps.system ?? CLAIM_PLANNER_PERSONA;
      const completion = await deps.model.complete({
        model: deps.modelId,
        system,
        messages: [{ role: "user", content: state.perception.text }],
        tools: [claimTool],
        maxTokens,
      });

      // Collect the model's proposals + the safety/span inputs from the call(s).
      const proposals: ProposedClaim[] = [];
      const spans: RequestSpan[] = [];
      const safety: SafetyRoutingInput = { markers: collectSafetyMarkers(completion.toolCalls) };
      for (const call of completion.toolCalls ?? []) {
        if (call.name !== PROPOSE_CLAIM_TOOL || !isProposeClaimInput(call.input)) {
          continue;
        }
        const input = call.input;
        proposals.push({
          // `type` is carried VERBATIM (possibly out-of-enum) so the
          // constrained-generation wall — not this collection step — is the
          // single gate that drops a hallucinated type.
          type: input.type,
          subject: input.subject ?? "",
          actor: input.actor ?? { principal: "llm", sessionId: state.conversationId },
          ...(input.resources === undefined ? {} : { resources: input.resources }),
          // tag-then-derive (STEP 1): the model NEVER authors a value — the
          // `value` field was removed from the tool schema. Seed it `undefined`;
          // `deriveCandidateValues` (below) sets it from the first-party read for
          // every publish-free-derivable bound type. A type with no deriver keeps
          // `undefined` → C6 ABSTAIN / honest UNKNOWN (never a model confabulation).
          value: undefined,
        });
        for (const span of input.spans ?? []) {
          spans.push(
            span.mappedClaimType === undefined
              ? { text: span.text }
              : { text: span.text, mappedClaimType: span.mappedClaimType },
          );
        }
      }

      // PRE-planning wall, part 2 (SDD §H/§P3 — defense in depth): only in-enum
      // types become typed `CandidateClaim`s; out-of-enum proposals are dropped.
      const { candidates, dropped } = constrainClaimGeneration(proposals);

      // tag-then-derive (STEP 2 — value derivation, PRE-kernel): OVERWRITE each
      // bound candidate's `value` from the SAME first-party read the investigator
      // records (here: the schedule signal for STORE_OPEN_NOW). This replaces the
      // value AUTHOR (the model) with a first-party deriver — it sets NO verdict
      // and skips NO conjunct. `runClaimsValidate` then runs the full kernel
      // (C6 + falsifier/CE#3 + provenance + freshness) over these candidates, so
      // C6 passes BY CONSTRUCTION (derived value == the ledger value C6 compares)
      // while a present falsifier STILL demotes the claim to UNKNOWN.
      const scheduleSignal = deps.resolveScheduleSignal
        ? ((await deps.resolveScheduleSignal()) ?? undefined)
        : undefined;
      const derivedCandidates = deriveCandidateValues(candidates, { scheduleSignal });

      // POST-planning wall (SDD §C P4 / §J.8): every span gets a disposition; an
      // unmapped span is surfaced as CLARIFY, never silently dropped.
      const completeness = checkCompleteness(spans);

      // SAFETY routing (SDD §O#9): an unrecognized — or any — safety marker
      // forces ESCALATE (the generic safe terminal); ESCALATE outranks a P4
      // CLARIFY (a safety escalation is more conservative than a clarification).
      const safetyTerminal = routeSafety(safety);
      const forcedTerminal: Extract<TurnTerminal, "ESCALATE" | "CLARIFY"> | undefined =
        safetyTerminal ?? (hasUnmappedSpan(completeness) ? "CLARIFY" : undefined);

      return {
        candidates: derivedCandidates,
        completeness,
        ...(forcedTerminal === undefined ? {} : { forcedTerminal }),
        droppedClaimTypes: dropped,
      };
    },
  };
}

/**
 * Gather the safety markers the model flagged across this turn's `propose_claim`
 * calls (Q6b — SDD §O#8/§O#9). The detector (§O#8) is a bounded probabilistic
 * input; this only COLLECTS its output — `routeSafety` is the deterministic,
 * closed-taxonomy net that decides ESCALATE. Pure over the call list.
 */
function collectSafetyMarkers(
  toolCalls: Completion["toolCalls"],
): string[] {
  const markers: string[] = [];
  for (const call of toolCalls ?? []) {
    if (call.name !== PROPOSE_CLAIM_TOOL || !isProposeClaimInput(call.input)) {
      continue;
    }
    for (const m of call.input.safetyMarkers ?? []) {
      if (typeof m === "string") markers.push(m);
    }
  }
  return markers;
}
