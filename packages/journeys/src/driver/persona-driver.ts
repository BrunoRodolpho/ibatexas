// driver/persona-driver.ts — T1a-8 LLM persona test driver (the core loop).
//
// An Anthropic tool-use loop drives one `chat` act with a `goal`: the system
// prompt is persona + journey businessCase + the current act goal, and the
// model pursues the goal through the CLOSED act-tool set:
//
//   chat → sends ONE persona utterance via the injected T1a-5 ChatClient
//          turn function and returns the SUT's reply text.
//   http → performs ONE journey-DECLARED http act through a constrained
//          client. The (method, path) must exactly match an http act in the
//          journey YAML; `asRole` is taken from the DECLARATION, never from
//          the model — the LLM cannot choose or escalate the role.
//
// CLOSED SET — exactly {chat, http}, nothing else, ever. In particular the
// Phase-3 trigger-injection publish helper (T3-9's single allowlisted NATS
// publish helper) is NOT an act tool: it is importable only from the
// journeys acceptance harness, and the named check-bypass grep leg
// (scripts/check-bypass.sh — T3-9 publish-helper containment) fails CI on
// any import of that helper from src/driver/. Do not add tools here.
//
// Authority split (mirrors CLAUDE.md rule 9 for the test plane): the LLM is
// a persona simulator with zero verdict authority. It may surface entity
// ids/handles it OBSERVES into ctx.vars (a string→string map threaded
// through acts) — and nothing else. It never computes pass/fail: after the
// acts complete, the HARNESS re-executes the journey's invariant set
// (`verify[]`, resolved via gates/invariant-registry.ts) with YAML-bound
// args; the driver only returns evidence (the captured vars + transcript).
//
// Budgets:
//   maxTurnsPerAct  → model round-trips per act; exhausted ⇒ the act FAILS.
//   tokenCeiling    → per-attempt sum of `llm.call` usage (input+output)
//                     across acts; exceeded ⇒ `journey.aborted` with
//                     reason=token_ceiling is emitted and the attempt aborts
//                     (DriverTokenCeilingError).
//
// Trace (the @ibatexas/tools JSONL emitter): every model call emits
// `llm.call` {inputTokens, outputTokens, model, duration} — THE dollar
// source for T1b-8; every captured var emits `evidence.capture`. act.start/
// act.end stay with the T1a-1 runner, which invokes this driver through
// `createDriverChatExecutor`.

import {
  emitEvidenceCapture,
  emitJourneyAborted,
  emitLlmCall,
} from "@ibatexas/tools"

import type { ChatAct, HttpAct, Journey, JsonValue } from "../schema/index.js"
import type {
  ActExecutionResult,
  ActExecutor,
  JourneyRunContext,
} from "../runner/run-journey.js"
import type {
  ModelMessage,
  ModelProvider,
  ModelToolDefinition,
  ModelToolResult,
  ModelToolUseBlock,
} from "./model-provider.js"

// ── Contract pins ────────────────────────────────────────────────────────────

/** Env var selecting the driver model (the PERSONA side, not the SUT side). */
export const DRIVER_MODEL_ENV = "IBX_DRIVER_MODEL"

/**
 * Default driver model. The driver accumulates context across turns — cost
 * noted in plan §7 — so this defaults to the certification-tier model
 * rather than anything heavier.
 */
export const DEFAULT_DRIVER_MODEL = "claude-sonnet-4-6"

/** The closed act-tool set. Exactly two — see the header before extending. */
export const DRIVER_ACT_TOOL_NAMES = ["chat", "http"] as const
export type DriverActToolName = (typeof DRIVER_ACT_TOOL_NAMES)[number]

export const DEFAULT_MAX_TURNS_PER_ACT = 8
/** Per-attempt ceiling on Σ(inputTokens+outputTokens) across all llm.calls. */
export const DEFAULT_TOKEN_CEILING = 200_000
/** Per-call response cap (`max_tokens`) — tool calls are short. */
export const DEFAULT_MAX_TOKENS_PER_CALL = 2_048

// ── Named errors ─────────────────────────────────────────────────────────────

/** The per-attempt token ceiling was exceeded — the attempt is aborted. */
export class DriverTokenCeilingError extends Error {
  constructor(tokensUsed: number, ceiling: number) {
    super(
      `driver_token_ceiling: attempt used ${tokensUsed} tokens (Σ llm.call input+output) > ceiling ${ceiling} — journey.aborted reason=token_ceiling emitted`,
    )
    this.name = "DriverTokenCeilingError"
  }
}

// ── Ports (narrow seams so tests stay offline) ───────────────────────────────

/** One SUT chat turn — adapt from `ChatClient.perTurn` (T1a-5). */
export type DriverChatTurnFn = (message: string) => Promise<{ replyText: string }>

/** What the constrained http client returns; serialized back to the model. */
export interface DriverHttpResult {
  status: number
  body: JsonValue
}

/**
 * Executes one journey-DECLARED http act. The act handed in is the YAML
 * declaration (with the declared `asRole`) — implementations must
 * authenticate per that role (T1a-4 authFixture) and never let the caller
 * widen it.
 */
export type DriverHttpExecutor = (act: HttpAct) => Promise<DriverHttpResult>

// ── Metadata (recorded per driver instance, persisted by T1b tasks) ──────────

export interface DriverMetadata {
  /** The persona-driver model in use (IBX_DRIVER_MODEL or default). */
  driverModel: string
  /** ANTHROPIC_MODEL from the env — the SUT-side model under test. */
  anthropicModel: string | undefined
  /** Certifying flag from the T1a-10 preflight result. */
  certifying: boolean
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface PersonaDriverOptions {
  /** The journey under drive (persona/businessCase/declared http acts). */
  journey: Pick<Journey, "id" | "persona" | "businessCase" | "acts" | "params">
  runId: string
  /** Model backend — the Anthropic provider in real runs, a stub in tests. */
  provider: ModelProvider
  /** One SUT chat turn (ChatClient.perTurn adapter). */
  chatTurn: DriverChatTurnFn
  /** Constrained http client (required only when the journey declares http acts). */
  http?: DriverHttpExecutor
  /** From the T1a-10 preflight result — recorded into `metadata`. */
  certifying: boolean
  maxTurnsPerAct?: number
  tokenCeiling?: number
  maxTokensPerCall?: number
  /** Driver model override; default env IBX_DRIVER_MODEL ?? claude-sonnet-4-6. */
  model?: string
  /** Env source (default `process.env`) — injectable for tests. */
  env?: Record<string, string | undefined>
}

// ── Act-tool definitions (Anthropic tool shapes via the neutral port) ────────

const VARS_PROPERTY = {
  type: "object",
  description:
    "Entity ids/handles you OBSERVED in SUT output (order codes, product " +
    "handles…) to record for the harness — string keys to string values " +
    "only. Never raw Medusa ids (prod_/variant_/cart_); never verdicts.",
  additionalProperties: { type: "string" },
} as const

function buildActToolDefinitions(declaredHttpActs: readonly HttpAct[]): ModelToolDefinition[] {
  const declared =
    declaredHttpActs.length > 0
      ? declaredHttpActs.map((a) => `${a.method} ${a.path}`).join("; ")
      : "none — any http call will be rejected"
  return [
    {
      name: "chat",
      description:
        "Send ONE persona utterance to the system under test over its public " +
        "chat surface and receive the assistant's reply text. Write the " +
        "message in the persona's own voice (pt-BR customer text).",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The persona's utterance (pt-BR)." },
          vars: VARS_PROPERTY,
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
    {
      name: "http",
      description:
        "Perform ONE http act that the journey DECLARES. method+path must " +
        `exactly match a declared act (declared: ${declared}). The declared ` +
        "asRole is enforced by the harness — you cannot choose the identity.",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", description: "Declared route path, starting with /." },
          body: { description: "Optional JSON body (defaults to the declared body)." },
          vars: VARS_PROPERTY,
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
    },
  ]
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

function buildSystemPrompt(
  journey: Pick<Journey, "persona" | "businessCase">,
  goal: string,
): string {
  return [
    "You are the persona test driver of the IbateXas journey suite. You role-play",
    "ONE customer persona against the real system under test, using only the act",
    "tools provided.",
    "",
    `PERSONA:\n${journey.persona}`,
    "",
    `BUSINESS CASE:\n${journey.businessCase}`,
    "",
    `CURRENT ACT GOAL:\n${goal}`,
    "",
    "Rules:",
    "- Use ONLY the `chat` and `http` tools. One persona utterance per `chat` call,",
    "  written in the persona's voice (pt-BR). `http` only for acts the journey",
    "  declares.",
    "- When SUT output shows entity ids/handles (order codes, product handles…),",
    "  record them via the `vars` field of your next tool call — string values",
    "  only, never raw Medusa ids (prod_/variant_/cart_).",
    "- You NEVER judge pass/fail. The harness re-executes the journey's invariant",
    "  set with YAML-bound args after the acts complete — your only outputs are",
    "  the interaction itself and the vars you surface.",
    "- When the goal interaction is complete, reply with plain text (no tool call)",
    "  briefly describing what happened.",
  ].join("\n")
}

function buildKickoffMessage(
  ctx: JourneyRunContext,
  opening: { utterance: string; replyText: string } | undefined,
): string {
  const vars = JSON.stringify(ctx.vars)
  const params = JSON.stringify(ctx.params)
  const lines = [
    "Begin the act.",
    `ctx.vars (entity handles surfaced by earlier acts): ${vars}`,
    `journey params: ${params}`,
  ]
  if (opening !== undefined) {
    lines.push(
      `The persona's scripted opening utterance was already sent: ${JSON.stringify(opening.utterance)}`,
      `The SUT replied: ${JSON.stringify(opening.replyText)}`,
    )
  }
  return lines.join("\n")
}

// ── PersonaDriver ────────────────────────────────────────────────────────────

export class PersonaDriver {
  /** ANTHROPIC_MODEL + certifying flag (T1a-10 preflight) + driver model. */
  readonly metadata: DriverMetadata

  readonly #journey: PersonaDriverOptions["journey"]
  readonly #runId: string
  readonly #provider: ModelProvider
  readonly #chatTurn: DriverChatTurnFn
  readonly #http: DriverHttpExecutor | undefined
  readonly #declaredHttpActs: readonly HttpAct[]
  readonly #tools: ModelToolDefinition[]
  readonly #maxTurnsPerAct: number
  readonly #tokenCeiling: number
  readonly #maxTokensPerCall: number

  #tokensUsed = 0

  constructor(options: PersonaDriverOptions) {
    const env = options.env ?? process.env
    this.#journey = options.journey
    this.#runId = options.runId
    this.#provider = options.provider
    this.#chatTurn = options.chatTurn
    this.#http = options.http
    this.#declaredHttpActs = options.journey.acts.filter(
      (act): act is HttpAct => act.kind === "http",
    )
    this.#tools = buildActToolDefinitions(this.#declaredHttpActs)
    this.#maxTurnsPerAct = options.maxTurnsPerAct ?? DEFAULT_MAX_TURNS_PER_ACT
    this.#tokenCeiling = options.tokenCeiling ?? DEFAULT_TOKEN_CEILING
    this.#maxTokensPerCall = options.maxTokensPerCall ?? DEFAULT_MAX_TOKENS_PER_CALL
    this.metadata = {
      driverModel: options.model ?? env[DRIVER_MODEL_ENV] ?? DEFAULT_DRIVER_MODEL,
      anthropicModel: env["ANTHROPIC_MODEL"],
      certifying: options.certifying,
    }
  }

  /** Σ(inputTokens+outputTokens) across this attempt's llm.calls so far. */
  get tokensUsed(): number {
    return this.#tokensUsed
  }

  /**
   * Drive one chat act. Scripted `utterance` (no goal) costs zero tokens —
   * one ChatClient turn, no model call. A `goal` runs the tool-use loop.
   */
  async runChatAct(act: ChatAct, ctx: JourneyRunContext): Promise<ActExecutionResult> {
    let opening: { utterance: string; replyText: string } | undefined
    if (act.utterance !== undefined) {
      const { replyText } = await this.#chatTurn(act.utterance)
      opening = { utterance: act.utterance, replyText }
    }
    if (act.goal === undefined) {
      // Pure scripted turn — schema guarantees utterance was present.
      return { ok: true, detail: `scripted utterance sent (reply ${opening?.replyText.length ?? 0} chars)` }
    }

    const system = buildSystemPrompt(this.#journey, act.goal)
    const messages: ModelMessage[] = [
      { role: "user", content: buildKickoffMessage(ctx, opening) },
    ]

    for (let turn = 1; turn <= this.#maxTurnsPerAct; turn++) {
      const t0 = Date.now()
      const response = await this.#provider.complete({
        model: this.metadata.driverModel,
        maxTokens: this.#maxTokensPerCall,
        system,
        messages,
        tools: this.#tools,
      })
      const durationMs = Date.now() - t0

      // THE dollar source (T1b-8): one llm.call per provider round-trip.
      emitLlmCall({
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        model: this.metadata.driverModel,
        duration: durationMs,
        journey: this.#journey.id,
        runId: this.#runId,
      })

      this.#tokensUsed += response.usage.inputTokens + response.usage.outputTokens
      if (this.#tokensUsed > this.#tokenCeiling) {
        emitJourneyAborted({
          journey: this.#journey.id,
          runId: this.#runId,
          reason: "token_ceiling",
          detail: `tokensUsed=${this.#tokensUsed} > tokenCeiling=${this.#tokenCeiling}`,
        })
        throw new DriverTokenCeilingError(this.#tokensUsed, this.#tokenCeiling)
      }

      const toolUses = response.content.filter(
        (block): block is ModelToolUseBlock => block.type === "tool_use",
      )
      if (toolUses.length === 0) {
        // Plain-text reply = the model considers the goal interaction done.
        const text = response.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("")
          .trim()
        return { ok: true, detail: text === "" ? "act complete" : text.slice(0, 500) }
      }

      messages.push({ role: "assistant", content: response.content })
      const results: ModelToolResult[] = []
      for (const toolUse of toolUses) {
        results.push(await this.#executeActTool(toolUse, ctx))
      }
      messages.push({ role: "user", content: results })
    }

    return {
      ok: false,
      detail: `max_turns_exhausted: act goal not concluded within maxTurnsPerAct=${this.#maxTurnsPerAct}`,
    }
  }

  // ── Act-tool dispatch (closed set) ─────────────────────────────────────────

  async #executeActTool(
    toolUse: ModelToolUseBlock,
    ctx: JourneyRunContext,
  ): Promise<ModelToolResult> {
    this.#captureVars(toolUse.input["vars"], ctx)

    if (toolUse.name === "chat") {
      const message = toolUse.input["message"]
      if (typeof message !== "string" || message.length === 0) {
        return this.#errorResult(toolUse.id, "chat requires a non-empty string `message`")
      }
      const { replyText } = await this.#chatTurn(message)
      return { type: "tool_result", toolUseId: toolUse.id, content: replyText }
    }

    if (toolUse.name === "http") {
      return this.#executeHttpTool(toolUse)
    }

    // Defensive: the model only ever sees {chat, http} — anything else is a
    // closed-set violation, reported back instead of executed.
    return this.#errorResult(
      toolUse.id,
      `unknown_act_tool: "${toolUse.name}" is not in the closed act-tool set {chat, http}`,
    )
  }

  async #executeHttpTool(toolUse: ModelToolUseBlock): Promise<ModelToolResult> {
    const method = toolUse.input["method"]
    const path = toolUse.input["path"]
    const declared = this.#declaredHttpActs.find(
      (act) => act.method === method && act.path === path,
    )
    if (declared === undefined) {
      return this.#errorResult(
        toolUse.id,
        `undeclared_http_act: ${String(method)} ${String(path)} is not declared by ${this.#journey.id} — only journey-declared http acts may run`,
      )
    }
    if (this.#http === undefined) {
      return this.#errorResult(toolUse.id, "http_executor_missing: no http client was injected")
    }

    // asRole comes from the DECLARATION — the model's input cannot carry it
    // (schema: additionalProperties:false) and is never consulted here.
    const body = toolUse.input["body"]
    const effective: HttpAct = {
      ...declared,
      ...(body !== undefined ? { body: body as JsonValue } : {}),
    }
    const result = await this.#http(effective)
    return {
      type: "tool_result",
      toolUseId: toolUse.id,
      content: JSON.stringify({ status: result.status, body: result.body }),
    }
  }

  /** Merge LLM-surfaced vars into ctx.vars (string→string ONLY) + trace. */
  #captureVars(vars: unknown, ctx: JourneyRunContext): void {
    if (vars === null || typeof vars !== "object" || Array.isArray(vars)) return
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value !== "string") continue // string→string map only
      ctx.vars[key] = value
      emitEvidenceCapture({
        evidence: key,
        detail: value,
        journey: this.#journey.id,
        runId: this.#runId,
      })
    }
  }

  #errorResult(toolUseId: string, message: string): ModelToolResult {
    return { type: "tool_result", toolUseId, content: message, isError: true }
  }
}

// ── Runner wiring (T1a-1 ActExecutors seam) ──────────────────────────────────

/**
 * Adapt a PersonaDriver into the runner's `ActExecutors.chat` slot. The
 * runner emits act.start/act.end around each call; ctx.vars threads the
 * driver's surfaced evidence into later acts and into the harness's
 * invariant re-execution (`verify[]` ids resolved via the invariant
 * registry — the driver itself never verifies anything).
 */
export function createDriverChatExecutor(driver: PersonaDriver): ActExecutor<ChatAct> {
  return (act, ctx) => driver.runChatAct(act, ctx)
}
