// LLMResponder — Layer 2 component for natural language generation.
//
// Extracted from agent.ts. Handles the LLM streaming loop, tool dispatch,
// and post-checkout fallback confirmation. The LLM only generates customer-facing
// text from the synthesized prompt — it NEVER makes business decisions.

import { randomUUID } from "node:crypto"
import Anthropic from "@anthropic-ai/sdk"
import type { MessageParam, ToolResultBlockParam, ContentBlock } from "@anthropic-ai/sdk/resources/messages.js"
import { NonRetryableError, type AgentContext, type StreamChunk } from "@ibatexas/types"
import { getRedisClient, rk } from "@ibatexas/tools"
import {
  buildAuditRecord,
  buildEnvelope,
  decisionRewrite,
  localizeDecision,
  type Decision,
} from "@adjudicate/core"
import type { Plan } from "@adjudicate/core/llm"
import { adjudicate } from "@adjudicate/core/kernel"
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br"
import { parkDeferredIntent } from "@adjudicate/runtime"
import { resolveLocalizedRefusalText } from "./localizer.js"
import { TOOL_DEFINITIONS, executeTool } from "./tool-registry.js"
import type { ToolExecutionResult } from "./tool-registry.js"
import { TOOL_CLASSIFICATION } from "./machine/types.js"
import type { OrderContext, SynthesizedPrompt, ToolIntent } from "./machine/types.js"
import type { DispatchResult } from "./intent-dispatcher.js"
import {
  shouldBufferText,
  validateBufferedTextTyped,
} from "./validation-layer.js"
import { getIntentLedger } from "./intent-ledger.js"
import { getAuditSink } from "./intent-audit-wiring.js"
import { orderPolicyBundle, type OrderState } from "./order-policy-bundle.js"
// W6-10 (P2-C): pino-shaped logger correlation. The responder accepts
// an optional logger via GenerateResponseOptions; when apps/api passes
// `req.log`, every warning/error here carries the per-request reqId.
import { resolveLogger, type IbxLogger } from "./logger.js"

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_TURNS = Number.parseInt(process.env.AGENT_MAX_TURNS || "5", 10)
const MAX_TOOL_RETRIES = Number.parseInt(process.env.AGENT_MAX_TOOL_RETRIES || "3", 10)
const MAX_CONVERSATION_RETRIES = Number.parseInt(process.env.AGENT_MAX_CONVERSATION_RETRIES || "10", 10)

// Daily token budget per session (default 100K tokens)
const SESSION_TOKEN_BUDGET = Number.parseInt(process.env.AGENT_SESSION_TOKEN_BUDGET || "100000", 10)
const TOKEN_BUDGET_TTL = Number.parseInt(process.env.AGENT_TOKEN_BUDGET_TTL || "86400", 10)

// ── Anthropic client (singleton) ──────────────────────────────────────────────

let _client: Anthropic | null = null

function getClient(): Anthropic {
  _client ??= new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 60_000,
  })
  return _client
}

/** @internal Reset singleton for test isolation */
export function _resetClient(): void {
  _client = null
}

// ── Post-checkout fallback confirmation ──────────────────────────────────────

export function buildConfirmationFallback(ctx: OrderContext): string {
  const orderId = ctx.orderId || "—"
  const items = (ctx.items || [])
    .map((i) => `${i.quantity}x ${i.name}`)
    .join(", ")
  const total = ctx.totalInCentavos
    ? `R$${(ctx.totalInCentavos / 100).toFixed(2).replace(".", ",")}`
    : "—"
  const fulfillment = ctx.fulfillment === "delivery" ? "Entrega" : "Retirada"

  const cr = ctx.checkoutResult as Record<string, unknown> | null
  const hasPixData = !!(cr?.pixCopyPaste)

  if (ctx.paymentMethod === "pix" && !hasPixData) {
    return [
      `Pedido #${orderId} reservado!`,
      items ? `${items} — ${total}` : "",
      `Tive um problema gerando o PIX agora — já estou resolvendo.`,
      `Pode vir retirar que tá garantido, ou te mando o PIX aqui em seguida.`,
    ].filter(Boolean).join("\n")
  }

  const paymentLabel = ctx.paymentMethod === "pix"
    ? "PIX (QR enviado acima)"
    : ctx.paymentMethod === "card"
      ? "Cartão"
      : ctx.paymentMethod === "cash"
        ? "Dinheiro"
        : "—"
  return [
    `Pedido #${orderId} confirmado!`,
    items ? `${items} — ${total}` : "",
    `${fulfillment} | ${paymentLabel}`,
  ].filter(Boolean).join("\n")
}

// ── Retry helper ──────────────────────────────────────────────────────────────

async function executeWithRetry(
  name: string,
  input: unknown,
  ctx: AgentContext,
  conversationRetries: { count: number },
  toolUseId?: string,
): Promise<unknown> {
  // FIX 4 (P2-26): Non-idempotent tools must not be retried
  if (NON_RETRYABLE_TOOLS.has(name)) {
    try {
      const result = await executeTool(name, input, ctx, toolUseId)
      // Intent bridge: intents are never retried — return immediately
      if (isToolExecutionResult(result) && result.kind === "intent") {
        return result
      }
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      return { error: error.message, toolName: name }
    }
  }

  let lastError: Error | undefined

  for (let attempt = 0; attempt < MAX_TOOL_RETRIES; attempt++) {
    try {
      const result = await executeTool(name, input, ctx, toolUseId)
      // Intent bridge: intents are never retried — return immediately
      if (isToolExecutionResult(result) && result.kind === "intent") {
        return result
      }
      return result
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (lastError instanceof NonRetryableError) {
        return { error: lastError.message, toolName: name }
      }
      conversationRetries.count++
      if (conversationRetries.count >= MAX_CONVERSATION_RETRIES) {
        return { error: "Limite de tentativas atingido. Tente novamente mais tarde.", toolName: name }
      }
      if (attempt < MAX_TOOL_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt))
      }
    }
  }

  return { error: lastError?.message ?? "Falha desconhecida", toolName: name }
}

/** Type guard: check if a value is a ToolExecutionResult from the intent bridge. */
function isToolExecutionResult(value: unknown): value is ToolExecutionResult {
  return typeof value === "object" && value !== null && "kind" in value
    && ((value as ToolExecutionResult).kind === "intent" || (value as ToolExecutionResult).kind === "result")
}

// ── Stream helpers ────────────────────────────────────────────────────────────

async function* streamTextDeltas(
  stream: ReturnType<Anthropic["messages"]["stream"]>,
): AsyncGenerator<StreamChunk> {
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield { type: "text_delta", delta: event.delta.text }
    }
  }
}

// ── PII sanitization for tool results ────────────────────────────────────────

function sanitizeToolResultForLLM(result: string): string {
  return result
    // Mask CPF patterns: 123.456.789-00 → 123.***.***-00
    .replace(/(\d{3})\.\d{3}\.\d{3}(-\d{2})/g, "$1.***.***$2")
    // Mask email: user@domain.com → us***@domain.com
    .replace(/([a-zA-Z0-9._%+-]{2})[a-zA-Z0-9._%+-]*(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, "$1***$2")
    // Strip stack traces
    .replace(/at\s+\S+\s+\(.*?\)/g, "[internal]")
    .replace(/\/[\w/.-]+\.ts:\d+/g, "[internal]")
}

// ── Non-retryable tools (side effects that must not be retried) ──────────────

const NON_RETRYABLE_TOOLS = new Set([
  "add_to_cart",
  "create_checkout",
  "cancel_order",
  "amend_order",
  "remove_from_cart",
  "apply_coupon",
  "submit_review",
  "create_reservation",
  "cancel_reservation",
  "modify_reservation",
  "handoff_to_human",
])

// ── Tool call rate limit ─────────────────────────────────────────────────────

const MAX_TOOLS_PER_TURN = 5

async function processToolCalls(
  content: ContentBlock[],
  context: AgentContext,
  machineCtx: OrderContext,
  onChunk: (chunk: StreamChunk) => void,
  conversationRetries: { count: number },
  allowedTools: string[],
  plan: Plan,
  onToolEvent?: (event: { type: string; payload: Record<string, unknown> }) => void,
  onToolIntent?: (intent: ToolIntent) => Promise<DispatchResult | void> | DispatchResult | void,
): Promise<ToolResultBlockParam[]> {
  const toolResults: ToolResultBlockParam[] = []

  const allToolUseBlocks = content.filter((b) => b.type === "tool_use")
  if (allToolUseBlocks.length > MAX_TOOLS_PER_TURN) {
    console.warn(
      "[llm-responder] Capped tool calls from %d to %d",
      allToolUseBlocks.length,
      MAX_TOOLS_PER_TURN,
    )
  }
  const toolUseBlocks = allToolUseBlocks.slice(0, MAX_TOOLS_PER_TURN)

  for (const block of toolUseBlocks) {
    if (block.type !== "tool_use") continue

    // FIX 1 (P0-1): State-gate — reject tools not in the allowed set for this state
    if (allowedTools.length > 0 && !allowedTools.includes(block.name)) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify({ error: `Tool "${block.name}" not available in current state` }),
      })
      console.warn("[llm-responder] Blocked tool not in allowed set: %s", block.name)
      continue
    }

    onChunk({ type: "tool_start", toolName: block.name, toolUseId: block.id })

    const result = await executeWithRetry(block.name, block.input, context, conversationRetries, block.id)

    // ── Intent bridge: mutating tool intercepted by the Zero-Trust layer ──
    if (isToolExecutionResult(result)) {
      if (result.kind === "intent" && result.intent) {
        console.warn("[llm-responder] Intent captured for mutating tool: %s", block.name)

        // ── Task 07: Planner-violation gate ────────────────────────────────
        // Defense-in-depth check: even though the state-gate above (line ~237)
        // rejects tools not in the visible-tool union, the planner is the
        // single security-sensitive surface that names which mutating intent
        // identities the LLM may PROPOSE in the current state. If the
        // identity is not in `plan.allowedIntents`, refuse with a
        // planner-violation refusal (pt-BR per CLAUDE.md #4). Today the
        // identity is the tool name — once domain-specific intent kinds ship
        // (e.g. `order.item.add`), this check shifts to envelope.kind.
        const intentIdentity = block.name
        const isMutating = TOOL_CLASSIFICATION.MUTATING.has(intentIdentity as never)
        if (isMutating && !plan.allowedIntents.includes(intentIdentity)) {
          console.warn(
            "[llm-responder] Planner violation: %s not in allowedIntents (%s)",
            intentIdentity,
            plan.allowedIntents.join(", ") || "<empty>",
          )
          onChunk({
            type: "tool_result",
            toolName: block.name,
            toolUseId: block.id,
            success: false,
          })
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({
              status: "refused",
              message: "Não posso processar esta solicitação no momento.",
              toolName: block.name,
              refusalCode: "planner_violation",
              refusalKind: "policy",
            }),
          })
          continue
        }

        // ── Execution Ledger ────────────────────────────────────────────────
        // The ledger is always consulted. On dedup hit, the intent is
        // suppressed with an "already processed" tool result. On Redis
        // failure, LedgerUnavailableError propagates and surfaces the
        // intent as a refusal — fail-closed by design (correctness over
        // availability for at-least-once delivery).
        const hash = result.intent.envelope?.intentHash
        if (hash) {
          const ledger = await getIntentLedger()
          const hit = await ledger.checkLedger(hash)
          if (hit) {
            console.warn(
              "[llm-responder] Ledger replay suppressed (hash=%s, firstAt=%s)",
              hash,
              hit.at,
            )
            onChunk({ type: "tool_result", toolName: block.name, toolUseId: block.id, success: true })
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                status: "already_processed",
                message: "Essa solicitação já foi processada.",
                toolName: block.name,
              }),
            })
            continue
          }
          await ledger.recordExecution({
            intentHash: hash,
            resourceVersion: `session:${context.sessionId}`,
            sessionId: context.sessionId,
            kind: result.intent.envelope?.kind ?? "order.tool.propose",
          })
        }

        // ── Kernel adjudication (always-on) ────────────────────────────────
        // Every LLM-proposed mutating tool is adjudicated. The kernel's
        // Decision is authoritative — REFUSE / DEFER / REQUEST_CONFIRMATION /
        // ESCALATE short-circuit before the underlying tool dispatches.
        // Every decision emits an audit record (console + NATS + Postgres
        // via the fan-out sink in intent-audit-wiring.ts).
        //
        // Task 07: buildAuditRecord computes `planFingerprint =
        // sha256Canonical({visibleReadTools, allowedIntents})` when `plan`
        // is passed, binding every record to the exact planner state the
        // LLM saw — enables replay-against-historical-plan and tamper
        // detection on the planner surface.
        const envelope = result.intent.envelope
        const orderState: OrderState = { ctx: machineCtx }
        const startedAt = Date.now()
        let decision: Decision
        if (envelope) {
          decision = adjudicate(envelope, orderState, orderPolicyBundle)
          try {
            const record = buildAuditRecord({
              envelope,
              decision,
              durationMs: Date.now() - startedAt,
              plan: {
                visibleReadTools: plan.visibleReadTools,
                allowedIntents: plan.allowedIntents,
              },
            })
            void getAuditSink().emit(record).catch((err: unknown) => {
              console.error(
                "[llm-responder] Audit emit failed:",
                (err as Error).message,
              )
            })
          } catch (err) {
            console.error(
              "[llm-responder] Audit record build failed:",
              (err as Error).message,
            )
          }
        } else {
          // No envelope — pure-read tool (the planner classifies these and
          // routes them through the dispatcher without an envelope). Skip
          // adjudication; treat as EXECUTE for caller flow.
          decision = { kind: "EXECUTE", basis: [] }
        }

        // Branch on decision.kind. EXECUTE preserves the v1.0 onToolIntent
        // path; non-EXECUTE outcomes short-circuit with structured tool
        // results. ESCALATE / REQUEST_CONFIRMATION fall through to a refusal
        // shape until their dedicated producers arrive in later phases.
        if (decision.kind === "EXECUTE" || decision.kind === "REWRITE") {
          // REWRITE substitutes a sanitized envelope; for now we route the
          // original to preserve v1.0 behavior. The first REWRITE producer
          // (P0-d validation layer) handles the rewritten payload at the
          // text-commit boundary, not here.
          //
          // Task 02 (investigation 01 P0 #1): await the dispatcher so that
          // a failed dispatch downgrades the LLM-visible tool_result. Until
          // this change shipped, dispatch was a no-op and the responder
          // always claimed "intent_registered" even when nothing executed.
          let dispatchResult: DispatchResult | void
          try {
            dispatchResult = await onToolIntent?.(result.intent)
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            dispatchResult = { kind: "failed", error }
          }

          if (dispatchResult && dispatchResult.kind === "failed") {
            // Dispatch failed — do NOT tell the LLM "Solicitação registrada".
            // Surface a refusal-style tool_result so the LLM stops claiming
            // success in its turn.
            console.error(
              "[llm-responder] Intent dispatch failed for %s: %s",
              block.name,
              dispatchResult.error.message,
            )
            onChunk({
              type: "tool_result",
              toolName: block.name,
              toolUseId: block.id,
              success: false,
            })
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                status: "dispatch_failed",
                message: "Não consegui completar essa ação agora. Tente novamente em instantes.",
                toolName: block.name,
              }),
            })
            continue
          }

          // executed | skipped | undefined (legacy no-op caller) → success.
          // For `skipped`, the deterministic kernel already mutated state
          // upstream — the LLM just needs to know the operation is in flight.
          onChunk({
            type: "tool_result",
            toolName: block.name,
            toolUseId: block.id,
            success: true,
          })
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({
              status: "intent_registered",
              message: "Solicitação registrada. O sistema processará sua requisição.",
              toolName: block.name,
            }),
          })
          continue
        }

        if (decision.kind === "DEFER") {
          // Park the intent via the runtime's `parkDeferredIntent` primitive.
          // The primitive enforces a per-session quota and populates the T-005
          // verification fields (`version`, `nonce`, `taint`, `actorPrincipal`)
          // so the resume side can detect tamper-at-rest. Without these fields,
          // `verifyParkedEnvelopeHash` returns `verified: null` and the
          // defer-resolver's tamper-detection is structurally inert (P0-7).
          let parkQuotaExceeded = false
          if (envelope) {
            try {
              const redis = await getRedisClient()
              const ttlSeconds = Math.ceil(decision.timeoutMs / 1000) + 60
              const parkResult = await parkDeferredIntent({
                envelope: {
                  intentHash: envelope.intentHash,
                  kind: envelope.kind,
                  actor: { sessionId: envelope.actor.sessionId },
                  payload: envelope.payload,
                  version: envelope.version,
                  nonce: envelope.nonce,
                  taint: envelope.taint,
                  actorPrincipal: envelope.actor.principal,
                },
                signal: decision.signal,
                ttlSeconds,
                redis,
                rk,
              })
              if (!parkResult.parked) {
                parkQuotaExceeded = true
                console.warn(
                  "[llm-responder] DEFER park quota exceeded:",
                  parkResult.reason,
                  "observed:", parkResult.observed,
                  "limit:", parkResult.limit,
                )
              }
            } catch (err) {
              console.error(
                "[llm-responder] DEFER park failed:",
                (err as Error).message,
              )
            }
          }
          if (parkQuotaExceeded) {
            // Surface as a refusal so the customer learns their additional
            // DEFER was rejected rather than silently swallowed.
            onChunk({
              type: "tool_result",
              toolName: block.name,
              toolUseId: block.id,
              success: false,
            })
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                status: "refused",
                message: "Você tem muitas operações em espera. Aguarde uma delas concluir antes de tentar novamente.",
                reason: "quota_exceeded",
                toolName: block.name,
              }),
            })
            continue
          }
          onChunk({
            type: "tool_result",
            toolName: block.name,
            toolUseId: block.id,
            success: true,
          })
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({
              status: "deferred",
              message: "Estou aguardando confirmação. Te aviso assim que tudo estiver certo.",
              signal: decision.signal,
              toolName: block.name,
            }),
          })
          continue
        }

        // REFUSE / ESCALATE / REQUEST_CONFIRMATION — surface the user-facing
        // text. onToolIntent is NOT invoked: the kernel said no.
        //
        // Task 11: route REFUSE decisions through `localizeDecision` at the
        // presentation boundary so kernel-emitted refusals (kill_switch,
        // taint, default_deny, deadline, ...) render in pt-BR. Pack-emitted
        // refusal codes that aren't in the canonical dictionary fall through
        // to `portugueseRefusalMessages.fallback`; for those, the inline
        // pt-BR string constructed by the Pack's `refuse(...)` factory
        // remains the source of truth — see `localizer.ts` for the policy.
        const localizedDecision = localizeDecision(
          decision,
          portugueseRefusalMessages,
        )
        const refusalText =
          localizedDecision.kind === "REFUSE"
            ? resolveLocalizedRefusalText(decision, localizedDecision)
            : localizedDecision.kind === "REQUEST_CONFIRMATION"
              ? localizedDecision.prompt
              : "Vou pedir uma revisão antes de seguir."
        onChunk({
          type: "tool_result",
          toolName: block.name,
          toolUseId: block.id,
          success: false,
        })
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({
            status:
              localizedDecision.kind === "REFUSE"
                ? "refused"
                : localizedDecision.kind === "REQUEST_CONFIRMATION"
                  ? "confirmation_required"
                  : "escalated",
            message: refusalText,
            toolName: block.name,
            ...(localizedDecision.kind === "REFUSE"
              ? {
                  refusalCode: localizedDecision.refusal.code,
                  refusalKind: localizedDecision.refusal.kind,
                }
              : {}),
          }),
        })
        continue
      }

      // kind === "result" — unwrap the data and continue with normal processing
      const actualResult = (result as { kind: "result"; data: unknown }).data
      const isError = typeof actualResult === "object" && actualResult !== null && "error" in actualResult

      // Capture machine events from extraction tools (LLM proposes → Machine commits)
      if (typeof actualResult === "object" && actualResult !== null && "event" in actualResult) {
        const extractionResult = actualResult as { event?: { type: string; payload: Record<string, unknown> } }
        if (extractionResult.event?.type) {
          onToolEvent?.(extractionResult.event)
        }
      }

      onChunk({ type: "tool_result", toolName: block.name, toolUseId: block.id, success: !isError })

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: sanitizeToolResultForLLM(JSON.stringify(actualResult)),
      })
      continue
    }

    // ── Legacy path: executeTool returned raw result (backward compat) ──
    const isError = typeof result === "object" && result !== null && "error" in result

    // Capture machine events from extraction tools (LLM proposes → Machine commits)
    if (typeof result === "object" && result !== null && "event" in result) {
      const extractionResult = result as { event?: { type: string; payload: Record<string, unknown> } }
      if (extractionResult.event?.type) {
        onToolEvent?.(extractionResult.event)
      }
    }

    onChunk({ type: "tool_result", toolName: block.name, toolUseId: block.id, success: !isError })

    toolResults.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: sanitizeToolResultForLLM(JSON.stringify(result)),
    })
  }

  return toolResults
}

// ── Per-session token budget helpers ─────────────────────────────────────────

export async function getSessionTokenCount(sessionId: string): Promise<number> {
  try {
    const redis = await getRedisClient()
    const count = await redis.get(rk(`llm:tokens:${sessionId}`))
    return count ? Number.parseInt(count, 10) : 0
  } catch {
    return 0
  }
}

async function trackSessionTokens(sessionId: string, tokensUsed: number): Promise<void> {
  try {
    const redis = await getRedisClient()
    const key = rk(`llm:tokens:${sessionId}`)
    const newCount = await redis.incrBy(key, tokensUsed)
    if (newCount === tokensUsed) {
      await redis.expire(key, TOKEN_BUDGET_TTL)
    }
  } catch {
    // Non-critical
  }
}

// ── Token budget constants ──────────────────────────────────────────────────

export { SESSION_TOKEN_BUDGET }

// ── LLM Response Generator ──────────────────────────────────────────────────

export interface GenerateResponseOptions {
  synthesized: SynthesizedPrompt
  message: string
  history: MessageParam[]
  agentContext: AgentContext
  machineCtx: OrderContext
  isPostCheckout: boolean
  stateValue: string
  onToolEvent?: (event: { type: string; payload: Record<string, unknown> }) => void
  /**
   * Callback for mutating tool intents intercepted by the Zero-Trust intent
   * bridge. Returns a DispatchResult so the responder can downgrade the
   * LLM-visible tool_result when dispatch fails (see Task 02 / investigation
   * 01 P0 #1). Returning void is supported for backward compatibility — the
   * responder treats undefined as "no dispatcher wired" and falls through to
   * the pre-Task-02 behavior (audit emit only).
   */
  onToolIntent?: (intent: ToolIntent) => Promise<DispatchResult | void> | DispatchResult | void
  /**
   * Pino-shaped logger for reqId-correlated structured logging.
   * apps/api passes `req.log` here; the responder defaults to a
   * console-passthrough when unset (preserves dev behaviour). All
   * warn/error emissions in the responder + the audit-wiring sink path
   * route through this logger.
   */
  logger?: IbxLogger
}

/**
 * Generate a natural language response using the LLM.
 * Handles multi-turn tool use, streaming, and post-checkout fallback.
 */
export async function* generateResponse(
  opts: GenerateResponseOptions,
): AsyncGenerator<StreamChunk> {
  const { synthesized, message, history, agentContext, machineCtx, isPostCheckout } = opts
  const { stateValue } = opts
  // W6-10: resolve logger once. Default is the console-passthrough;
  // apps/api passes `req.log` so all responder warnings carry reqId.
  const log = resolveLogger(opts.logger)
  const hasTools = synthesized.availableTools.length > 0
  const bufferMode = shouldBufferText(stateValue, hasTools)

  const client = getClient()
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"

  const filteredTools = synthesized.availableTools.length > 0
    ? TOOL_DEFINITIONS.filter((t) => synthesized.availableTools.includes(t.name))
    : undefined

  const messages: MessageParam[] = [
    ...history,
    { role: "user", content: message },
  ]

  const conversationRetries = { count: 0 }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let stream: ReturnType<typeof client.messages.stream>
    try {
      stream = client.messages.stream({
        model,
        system: [{ type: "text", text: synthesized.systemPrompt, cache_control: { type: "ephemeral" } }],
        messages,
        tools: filteredTools,
        max_tokens: synthesized.maxTokens,
      })
    } catch (err) {
      // W6-10: structured log → carries reqId when apps/api passes req.log.
      log.error(
        { err: (err as Error).message, sessionId: agentContext.sessionId },
        "[agent] Failed to start stream",
      )
      if (isPostCheckout) {
        log.warn(
          { sessionId: agentContext.sessionId },
          "[agent] LLM failed post-checkout — yielding deterministic confirmation",
        )
        yield { type: "text_delta", delta: buildConfirmationFallback(machineCtx) }
        yield { type: "done" }
        return
      }
      yield { type: "error", message: "Erro ao processar sua mensagem. Tente novamente." }
      return
    }

    // ── Two-phase commit: buffer when tools are possible ──────────────
    const turnBuffer: string[] = []
    try {
      if (bufferMode) {
        // Buffer mode: collect text, don't stream yet
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            turnBuffer.push(event.delta.text)
          }
        }
      } else {
        // Live mode: stream immediately (no TTFB penalty)
        yield* streamTextDeltas(stream)
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, sessionId: agentContext.sessionId },
        "[agent] Stream error",
      )
      if (isPostCheckout) {
        log.warn(
          { sessionId: agentContext.sessionId },
          "[agent] LLM stream failed post-checkout — yielding deterministic confirmation",
        )
        yield { type: "text_delta", delta: buildConfirmationFallback(machineCtx) }
        yield { type: "done" }
        return
      }
      yield { type: "error", message: "Erro ao processar sua mensagem. Tente novamente." }
      return
    }

    const finalMessage = await stream.finalMessage()
    const { stop_reason, usage } = finalMessage

    const turnTokens = usage.input_tokens + usage.output_tokens
    void trackSessionTokens(agentContext.sessionId, turnTokens)

    // ── Flush or discard buffered text ──────────────────────────────────
    if (bufferMode && turnBuffer.length > 0) {
      if (stop_reason === "tool_use") {
        // Pre-tool text — discard to prevent premature confirmations
        log.warn(
          {
            stateValue,
            preview: turnBuffer.join("").slice(0, 100),
            sessionId: agentContext.sessionId,
          },
          "[agent] Discarded pre-tool text",
        )
      } else {
        // end_turn — validate and flush.
        // P0-d: route through the typed ValidationOutcome so REWRITE
        // sanitization produces a structured AuditRecord instead of a silent
        // console.warn drop. PASS streams as before; REWRITE streams the
        // sanitized text and emits a REWRITE Decision audit; REFUSE emits
        // refusal text and a REFUSE audit.
        const rawText = turnBuffer.join("")
        const outcome = validateBufferedTextTyped(rawText, stateValue)
        if (outcome.kind === "PASS") {
          if (outcome.text.length > 0) {
            yield { type: "text_delta", delta: outcome.text }
          }
        } else if (outcome.kind === "REWRITE") {
          // Emit a structured audit record. The synthetic envelope captures
          // the validation event so downstream replay can reproduce it.
          try {
            const validationEnvelope = buildEnvelope({
              kind: "validation.text.rewrite",
              payload: { stateValue, originalLength: rawText.length },
              actor: { principal: "system", sessionId: agentContext.sessionId },
              taint: "SYSTEM",
              // v2 envelope: nonce is the idempotency key (not createdAt).
              // Validation events are post-hoc audit records — never retried —
              // so a fresh UUID per emit is correct.
              nonce: randomUUID(),
            })
            const record = buildAuditRecord({
              envelope: validationEnvelope,
              decision: decisionRewrite(validationEnvelope, outcome.reason, outcome.basis),
              durationMs: 0,
            })
            void getAuditSink().emit(record).catch((err: unknown) => {
              log.error(
                { err: (err as Error).message, sessionId: agentContext.sessionId },
                "[llm-responder] REWRITE audit emit failed",
              )
            })
          } catch (err) {
            log.error(
              { err: (err as Error).message, sessionId: agentContext.sessionId },
              "[llm-responder] REWRITE audit build failed",
            )
          }
          if (outcome.rewritten.length > 0) {
            yield { type: "text_delta", delta: outcome.rewritten }
          }
        } else {
          // REFUSE — surface a brief refusal to the user, do not stream raw.
          try {
            const refuseEnvelope = buildEnvelope({
              kind: "validation.text.refuse",
              payload: { stateValue, originalLength: rawText.length },
              actor: { principal: "system", sessionId: agentContext.sessionId },
              taint: "SYSTEM",
              // v2 envelope: nonce is the idempotency key (not createdAt).
              // Validation events are post-hoc audit records — never retried —
              // so a fresh UUID per emit is correct.
              nonce: randomUUID(),
            })
            const record = buildAuditRecord({
              envelope: refuseEnvelope,
              decision: { kind: "REFUSE", refusal: outcome.refusal, basis: outcome.basis },
              durationMs: 0,
            })
            void getAuditSink().emit(record).catch((err: unknown) => {
              // P1 (audit/06): REFUSE audit emit had no .catch logging —
              // refusals reached the user but the audit gap was invisible.
              // W6-10 now plumbs the failure through the structured logger
              // so on-call has reqId-correlated evidence.
              log.warn(
                { err: (err as Error).message, sessionId: agentContext.sessionId },
                "[llm-responder] REFUSE audit emit failed",
              )
            })
          } catch (err) {
            log.warn(
              { err: (err as Error).message, sessionId: agentContext.sessionId },
              "[llm-responder] REFUSE audit build failed",
            )
          }
          yield { type: "text_delta", delta: outcome.refusal.userFacing }
        }
      }
    }

    if (stop_reason === "end_turn") {
      yield {
        type: "done",
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      }
      return
    }

    if (stop_reason === "max_tokens") {
      yield { type: "text_delta", delta: "\n\n[Resposta truncada — limite de tamanho atingido.]" }
      yield {
        type: "done",
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      }
      return
    }

    // ── Tool use (info-only tools: search, details, nutritional, etc.) ────
    if (stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: finalMessage.content })

      const pendingChunks: StreamChunk[] = []
      const toolResults = await processToolCalls(
        finalMessage.content,
        agentContext,
        machineCtx,
        (chunk) => pendingChunks.push(chunk),
        conversationRetries,
        synthesized.availableTools,
        synthesized.plan,
        opts.onToolEvent,
        opts.onToolIntent,
      )
      for (const chunk of pendingChunks) {
        yield chunk
      }

      messages.push({ role: "user", content: toolResults })
      continue
    }

    yield { type: "error", message: `Stop inesperado: ${stop_reason}` }
    return
  }

  yield { type: "error", message: "Limite de turnos do agente atingido." }
}
