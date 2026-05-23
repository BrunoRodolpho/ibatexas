// Intent Dispatcher — Phase M0 Task 02.
//
// Owns the post-adjudication EXECUTE branch for LLM-proposed mutating tools.
// Today the responder calls `onToolIntent?.(result.intent)` after the kernel
// returns EXECUTE; without a real dispatcher that callback is a no-op and the
// LLM is told "Solicitação registrada" while nothing happens. This module is
// the consumer that closes that gap.
//
// Architecture (see CLAUDE.md rule #9 + docs/adjudicate-migration/investigation/01):
//   1. LLM proposes a mutating tool → tool-registry returns kind:"intent".
//   2. llm-responder adjudicates via @adjudicate/core. If EXECUTE, it calls
//      onToolIntent (this dispatcher).
//   3. The dispatcher checks DETERMINISTIC_KERNEL_COVERAGE first. If the
//      deterministic kernel-executor already handles the underlying mutation
//      (cart/checkout/cancel/pix-regenerate), it returns kind:"skipped" so the
//      handler is NOT executed twice. This preserves today's correct behavior
//      for those tools while still emitting the adjudication audit record.
//   4. For tools the deterministic kernel does NOT cover (handoff_to_human,
//      schedule_follow_up, set_pix_details, and any future LLM-only mutating
//      tools), the dispatcher invokes the handler binding with the original
//      payload and AgentContext, returning kind:"executed" on success or
//      kind:"failed" on throw.
//
// IMPORTANT: This module deliberately does NOT call executeToolDirect from
// tool-registry. That export is on the chopping block in Task 06; dispatcher
// owns its own handler bindings to avoid that coupling.

import type { AgentContext, HandoffToHumanInput } from "@ibatexas/types"
import {
  handoffToHuman,
  scheduleFollowUp,
  setPixDetails,
} from "@ibatexas/tools"
import type { ToolIntent } from "./machine/types.js"

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Programmatic result of dispatching an adjudicated intent. The responder
 * (llm-responder.ts) uses this shape to decide whether to surface the
 * "intent_registered" optimism to the LLM or downgrade to a refusal-style
 * tool_result.
 */
export type DispatchResult =
  | { kind: "executed"; result: unknown }
  | { kind: "skipped"; reason: "deterministic_kernel_covers" }
  | { kind: "failed"; error: Error }

/**
 * Per-tool handler signature. Matches the (input, ctx) shape used throughout
 * tool-registry.ts so existing implementations can be re-bound here without
 * adaptation.
 */
export type DispatchHandler = (
  input: unknown,
  ctx: AgentContext,
) => Promise<unknown>

/**
 * Minimal logger shape. Implementations may inject the platform logger
 * (pino/winston/console) — we accept anything with the standard methods.
 */
export interface DispatcherLogger {
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
}

export interface DispatcherDeps {
  /**
   * Tool name → handler map. The dispatcher looks up by intent.toolName.
   * If a tool is not in the map AND not in DETERMINISTIC_KERNEL_COVERAGE,
   * the dispatcher returns a `failed` result so the responder can degrade
   * to a refusal-style tool_result (instead of falsely claiming success).
   */
  handlers: ReadonlyMap<string, DispatchHandler>
  /**
   * Optional override of the deterministic-kernel coverage allowlist.
   * Tests use this to control skip-behavior in isolation. Production
   * always uses DETERMINISTIC_KERNEL_COVERAGE.
   */
  coverage?: ReadonlySet<string>
  log?: DispatcherLogger
}

export type IntentDispatcher = (
  intent: ToolIntent,
  ctx: AgentContext,
) => Promise<DispatchResult>

// ── Deterministic kernel coverage ────────────────────────────────────────────

/**
 * Set of intents that the deterministic kernel-executor already performs
 * directly via machine/actions.ts (addItemToCart, processCheckout,
 * cancelOrderAction, regeneratePixAction). For these, the LLM-proposed intent
 * is informational only — the real mutation happens in Phase 2 of runAgent.
 *
 * The dispatcher must return `skipped` for these to avoid double-execution.
 *
 * Includes BOTH:
 *   - Tool names emitted by tool-registry today (e.g. "add_to_cart").
 *   - Canonical intent kinds (W5-3 fix; previously misnamed `order.cart.add`
 *     and `order.pix.regenerate`). Names track the master taxonomy and
 *     pack-orders / pack-payments surfaces.
 *
 * See investigation 01 §"Bypass paths discovered" #3 and audit 07 §"Rename drifts".
 */
export const DETERMINISTIC_KERNEL_COVERAGE: ReadonlySet<string> = new Set([
  // Canonical intent kinds (governance taxonomy)
  "order.item.add",
  "order.item.update",
  "order.item.remove",
  "order.cart.ensure",
  "order.checkout.create",
  "order.cancel",
  "payment.pix.regenerate",
  // Today's tool names (envelope.kind is "order.tool.propose";
  // intent.toolName carries the real identity)
  "add_to_cart",
  "update_cart",
  "remove_from_cart",
  "get_or_create_cart",
  "create_checkout",
  "cancel_order",
  "regenerate_pix",
])

// ── Default handler bindings ─────────────────────────────────────────────────

/**
 * Default handler bindings for the tools the LLM dispatcher must handle today
 * (those NOT covered deterministically by the kernel-executor):
 *   - handoff_to_human  — fires NATS `support.handoff_requested`
 *   - schedule_follow_up — writes to Redis sorted set `follow-up:scheduled`
 *   - set_pix_details   — validates PIX details (returns an event for the machine)
 *
 * These bindings deliberately mirror the (input, ctx) shape used in
 * tool-registry.ts but do NOT depend on it. Once tool-registry.ts removes
 * executeToolDirect (task 06), this remains the canonical post-adjudication
 * execution path.
 *
 * Notes:
 *   - `handoff_to_human` accepts only the input payload upstream; ctx is
 *     ignored by the handler but the dispatcher receives it for symmetry.
 *   - `schedule_follow_up` and `set_pix_details` use the ctx for customerId
 *     / sessionId enrichment via their internal logic.
 */
export function createDefaultDispatchHandlers(): ReadonlyMap<
  string,
  DispatchHandler
> {
  const map = new Map<string, DispatchHandler>()

  map.set("handoff_to_human", async (input, _ctx) => {
    return handoffToHuman(input as HandoffToHumanInput)
  })

  map.set("schedule_follow_up", async (input, ctx) => {
    return scheduleFollowUp(
      input as Parameters<typeof scheduleFollowUp>[0],
      ctx,
    )
  })

  map.set("set_pix_details", async (input, ctx) => {
    return setPixDetails(input as Parameters<typeof setPixDetails>[0], ctx)
  })

  return map
}

// ── Dispatch identity helper ────────────────────────────────────────────────

/**
 * Resolve the canonical identity used to look up coverage / handlers.
 *
 * The current production envelope kind is the generic `order.tool.propose`
 * (every LLM-proposed mutation shares it). The real identity is in
 * `intent.toolName`. We check the envelope kind first so that future,
 * domain-specific intent kinds (`order.cart.add` etc., per task 06) take
 * precedence once they ship.
 */
function intentIdentity(intent: ToolIntent): string {
  const envelopeKind = intent.envelope?.kind
  // `order.tool.propose` is the generic catch-all today — fall through to
  // toolName for the real dispatch identity.
  if (envelopeKind && envelopeKind !== "order.tool.propose") {
    return envelopeKind
  }
  return intent.toolName
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build an IntentDispatcher. The returned callable is what the responder
 * passes as `onToolIntent` and what is invoked after `adjudicate()` returns
 * an EXECUTE (or REWRITE) decision.
 *
 * Construction is cheap — runAgent builds one per request so handler bindings
 * can be injected for testing.
 */
export function createIntentDispatcher(
  deps: DispatcherDeps,
): IntentDispatcher {
  const coverage = deps.coverage ?? DETERMINISTIC_KERNEL_COVERAGE
  const log = deps.log ?? {
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  }

  return async function dispatch(intent, ctx) {
    const identity = intentIdentity(intent)

    // Skip path — deterministic kernel-executor already performed the mutation
    // upstream in runAgent.executeKernel. Returning skipped (not executed)
    // prevents the double-write hazard called out in task 02 spec.
    if (coverage.has(identity)) {
      log.warn(
        "[intent-dispatcher] Skipping %s — deterministic kernel covers it",
        identity,
      )
      return { kind: "skipped", reason: "deterministic_kernel_covers" }
    }

    const handler = deps.handlers.get(intent.toolName)
    if (!handler) {
      // No registered handler. Surface as failure so the responder downgrades
      // to a refusal-style tool_result rather than falsely claiming success.
      // This is the bypass-detection path: never silently swallow.
      const err = new Error(
        `intent_dispatcher: no handler for tool "${intent.toolName}"`,
      )
      log.error(
        "[intent-dispatcher] No handler for %s — returning failed",
        intent.toolName,
      )
      return { kind: "failed", error: err }
    }

    try {
      const result = await handler(intent.input, ctx)
      return { kind: "executed", result }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      log.error(
        "[intent-dispatcher] Handler for %s threw: %s",
        intent.toolName,
        error.message,
      )
      return { kind: "failed", error }
    }
  }
}
