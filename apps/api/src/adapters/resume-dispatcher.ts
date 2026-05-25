// Resume-path dispatcher adapter — F1 follow-up.
//
// Bridges two shapes that were introduced on separate task branches:
//
//   - `ResumeIntentDispatcher` (task 03, `apps/api/src/subscribers/
//     defer-resolver.ts`) — called by the NATS subscriber after a parked
//     envelope has been re-adjudicated to EXECUTE on payment-confirmed.
//     Signature: `(intent: ResumedIntent, log?: FastifyBaseLogger) => Promise<void>`
//
//   - `IntentDispatcher` (task 02, `@ibatexas/llm-provider/intent-dispatcher`) —
//     the canonical post-adjudication EXECUTE consumer used by the responder
//     hot path. Signature: `(intent: ToolIntent, ctx: AgentContext) =>
//     Promise<DispatchResult>`
//
// This adapter converts the resume-path call into a hot-path call so the
// same handler bindings (handoff_to_human, schedule_follow_up, set_pix_details)
// fire on the resume side too.
//
// # Fail-closed semantics
//
// The defer-resolver subscriber emits its audit record BEFORE calling the
// dispatcher (`defer-resolver.ts` §"Emit audit record linking..."). That
// means a dispatcher exception cannot leave the audit log inconsistent —
// the resumption is already recorded. The contract the subscriber relies on
// is: **never throw into the subscriber loop**. The subscriber catches and
// DLQs anything that escapes, but a quieter contract is "the adapter logs +
// returns void" so the subscriber can move on to the next session in the
// SCAN sweep.
//
// We honor that contract on three layers:
//
//   1. The underlying `IntentDispatcher` returns `{kind: "failed", error}`
//      instead of throwing for handler exceptions; we log and return void.
//   2. Translation errors (e.g. malformed payload after a tamper-verified
//      parked envelope) are caught and logged; return void.
//   3. An outer try/catch wraps the entire body so an unexpected throw
//      anywhere — e.g. the dispatcher itself constructed badly — still
//      returns void.

import type { FastifyBaseLogger } from "fastify"
import {
  createDefaultDispatchHandlers,
  createIntentDispatcher,
  dispatchResumedKernelEnvelope,
  type IntentDispatcher,
  type ResumeKernelDispatchDeps,
} from "@ibatexas/llm-provider"
import type { ToolIntent } from "@ibatexas/llm-provider"
import type { AgentContext } from "@ibatexas/types"
import { Channel } from "@ibatexas/types"
import type {
  ResumedIntent,
  ResumeIntentDispatcher,
} from "../subscribers/defer-resolver.js"

// ── Public deps ──────────────────────────────────────────────────────────────

export interface ResumeDispatcherAdapterDeps {
  /**
   * Override the underlying dispatcher. Tests inject a spy; production
   * leaves this unset and gets `createIntentDispatcher` with the default
   * handler bindings.
   */
  readonly dispatcher?: IntentDispatcher
  /**
   * Module-level fallback logger when the subscriber doesn't pass one (it
   * always does in production — this is a belt-and-braces default).
   */
  readonly log?: FastifyBaseLogger
  /**
   * Audit-2026-05-24 P1-3: test-injection seam for the resume-side kernel
   * dispatcher. Production callers leave this undefined and get the live
   * `@ibatexas/tools` functions; tests pass spies to verify routing without
   * standing up Medusa.
   */
  readonly kernelDispatcherDeps?: ResumeKernelDispatchDeps
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Build a `ResumeIntentDispatcher` from a fresh `IntentDispatcher` and the
 * default handler bindings. The returned function is what
 * `setResumeIntentDispatcher` accepts in `apps/api/src/index.ts`.
 *
 * Construction is cheap; we build it once at boot and reuse for every
 * resumed session.
 */
export function createResumeDispatcherAdapter(
  deps: ResumeDispatcherAdapterDeps = {},
): ResumeIntentDispatcher {
  const dispatcher =
    deps.dispatcher ??
    createIntentDispatcher({
      handlers: createDefaultDispatchHandlers(),
    })

  return async function dispatchResume(
    intent: ResumedIntent,
    log?: FastifyBaseLogger,
  ): Promise<void> {
    const effectiveLog = log ?? deps.log

    try {
      const toolIntent = translateResumedIntent(intent)
      if (toolIntent === null) {
        // Audit-2026-05-24 P1-3: parked envelope is not the LLM-proposed
        // `order.tool.propose` shape — it's likely a kernel-direct envelope
        // (`order.item.add`, `order.checkout.create`, `order.cancel`,
        // `payment.pix.regenerate`) parked by `kernel-executor.ts` during a
        // PIX-pending DEFER. The intent-dispatcher cannot route those (its
        // identity check resolves to a toolName the responder hot path uses);
        // the resume-side kernel dispatcher handles them directly.
        await dispatchResumedKernel({
          envelope: intent.envelope,
          sessionId: intent.sessionId,
          intentHash: intent.originalIntentHash,
          log: effectiveLog,
          deps: deps.kernelDispatcherDeps,
        })
        return
      }

      const ctx = buildResumeAgentContext(intent)
      const result = await dispatcher(toolIntent, ctx)

      if (result.kind === "failed") {
        // The underlying dispatcher already logged the handler-throw; here
        // we record the resume-side context (sessionId + intentHash) so
        // ops can correlate. We DO NOT throw — the subscriber's audit
        // emission already captured the EXECUTE decision; throwing would
        // break the subscriber loop.
        effectiveLog?.error(
          {
            sessionId: intent.sessionId,
            intentHash: intent.originalIntentHash,
            toolName: toolIntent.toolName,
            err: result.error.message,
          },
          "[resume-dispatcher] underlying dispatcher returned failed — audit-only outcome",
        )
        return
      }

      if (result.kind === "skipped") {
        // Audit-2026-05-24 P1-3 (closes "task 22"): the intent-dispatcher
        // reports `skipped` because the underlying mutation belongs to
        // DETERMINISTIC_KERNEL_COVERAGE — on the responder hot path the
        // XState kernel-executor runs it directly, so the dispatcher MUST
        // skip to avoid double-execution. On the resume path there is NO
        // machine pass; we have to dispatch the tool ourselves. We hand
        // off to the resume-side kernel dispatcher, which invokes the
        // underlying @ibatexas/tools function with the parked envelope's
        // payload.
        await dispatchResumedKernel({
          envelope: intent.envelope,
          sessionId: intent.sessionId,
          intentHash: intent.originalIntentHash,
          toolName: toolIntent.toolName,
          log: effectiveLog,
          deps: deps.kernelDispatcherDeps,
        })
        return
      }

      // kind === "executed"
      effectiveLog?.info(
        {
          sessionId: intent.sessionId,
          intentHash: intent.originalIntentHash,
          toolName: toolIntent.toolName,
        },
        "[resume-dispatcher] resumed intent executed successfully",
      )
    } catch (err) {
      // Catastrophic catch-all. The dispatcher contract is fail-closed
      // (returns DispatchResult instead of throwing); reaching this branch
      // implies an adapter-side or translation-side bug. Log and swallow
      // so the subscriber loop doesn't break.
      effectiveLog?.error(
        {
          sessionId: intent.sessionId,
          intentHash: intent.originalIntentHash,
          err: (err as Error).message,
        },
        "[resume-dispatcher] unexpected exception inside adapter — swallowed to protect subscriber loop",
      )
    }
  }
}

// ── Translation helpers ──────────────────────────────────────────────────────

/**
 * Convert a `ResumedIntent`'s parked envelope into the `ToolIntent` shape
 * the responder hot path uses.
 *
 * The parked envelope is always a `ToolProposeEnvelope` today — the
 * responder only parks `kind: "order.tool.propose"` envelopes whose
 * payload is `ToolProposePayload = {toolName, input, toolUseId}` (see
 * `llm-responder.ts:438-460`). We validate that shape at runtime
 * because the runtime ParkedEnvelope type widens `payload` to `unknown`.
 *
 * Returns null when the payload doesn't match — the caller logs and
 * skips. Throwing here would break the fail-closed contract.
 */
function translateResumedIntent(intent: ResumedIntent): ToolIntent | null {
  const payload = intent.envelope.payload
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { toolName?: unknown }).toolName !== "string"
  ) {
    return null
  }
  const p = payload as {
    toolName: string
    input?: unknown
    toolUseId?: unknown
  }
  return {
    toolName: p.toolName,
    input: p.input ?? {},
    toolUseId: typeof p.toolUseId === "string" ? p.toolUseId : "",
    // The envelope is structurally compatible with `ToolProposeEnvelope`
    // (kind + payload shape checked above). Cast through `unknown` is
    // load-bearing because the runtime ParkedEnvelope's envelope is a
    // type alias that intersects with IntentEnvelope at runtime but
    // narrowest-bound at compile-time.
    envelope: intent.envelope as unknown as ToolIntent["envelope"],
  }
}

/**
 * Build the minimal `AgentContext` the underlying dispatcher / handlers
 * need on the resume path. The parked envelope only carries
 * `actor.sessionId`; everything else is synthesized.
 *
 * Fields and justifications (read top-to-bottom):
 *
 *   - `sessionId`   — from `envelope.actor.sessionId`; load-bearing for
 *                     handler bindings that key off it (e.g.
 *                     `handoff_to_human` writes a NATS event with this).
 *
 *   - `channel`     — defaults to `Channel.WhatsApp`. PIX-deferred intents
 *                     today are exclusively a WhatsApp-ordering concern
 *                     (the web checkout path does not DEFER — it returns
 *                     the PIX QR synchronously). When task 22 introduces
 *                     web-side defers, the parked envelope must start
 *                     carrying its source channel and this default needs
 *                     revisiting.
 *
 *   - `userType`    — defaults to `"customer"`. Resume can only happen for
 *                     customer-initiated parks (system-only kinds like
 *                     `order.cancel.system` are TRUSTED and never DEFER
 *                     via the responder hot path).
 *
 *   - `customerId`  — left `undefined`. The handlers that need it
 *                     (`schedule_follow_up`) read it from input payload
 *                     or fall back to sessionId-keyed Redis lookups; we
 *                     deliberately do NOT spelunk into Redis here to keep
 *                     the adapter side-effect-free.
 *
 *   - `lastLocation`, `hints` — undefined. Not consumed by any handler
 *                     in `createDefaultDispatchHandlers()`.
 */
function buildResumeAgentContext(intent: ResumedIntent): AgentContext {
  return {
    sessionId: intent.envelope.actor.sessionId,
    channel: Channel.WhatsApp,
    userType: "customer",
  }
}

// ── Resume-side kernel dispatch helper ───────────────────────────────────────

/**
 * Audit-2026-05-24 P1-3: invoke the resume-side kernel dispatcher and log
 * the outcome. Wraps `dispatchResumedKernelEnvelope` with the fail-closed
 * logging contract the subscriber loop relies on — any error becomes a
 * structured log line and a void return, never a throw.
 *
 * Pre-P1-3 the resume path for kernel-covered tools logged a single info
 * line ("dispatch skipped — deterministic kernel covers it") and returned
 * void. That was the "task 22" silent drop: the audit record + subscriber
 * log were the only trail, the actual mutation never ran. This helper
 * closes that gap by performing the underlying tool call.
 */
async function dispatchResumedKernel(args: {
  readonly envelope: ResumedIntent["envelope"]
  readonly sessionId: string
  readonly intentHash: string
  readonly toolName?: string
  readonly log?: FastifyBaseLogger
  readonly deps?: ResumeKernelDispatchDeps
}): Promise<void> {
  const { envelope, sessionId, intentHash, toolName, log, deps } = args

  const result = await dispatchResumedKernelEnvelope(
    envelope,
    sessionId,
    deps ?? {},
  )

  if (result.kind === "executed") {
    log?.info(
      {
        sessionId,
        intentHash,
        toolName: result.toolName,
      },
      "[resume-dispatcher] resumed kernel-covered intent executed",
    )
    return
  }

  if (result.kind === "failed") {
    // audit-2026-05-25 (I6): pre-fix this returned silently after
    // logging, so the upstream defer-resolver treated the resume as
    // "completed" — SETNX-committed defer:resumed:{hash}, DEL'd parked
    // key, INCRed quota counter. The destructive mutation never ran
    // but the framework's dedup ledger now blocks any retry. The
    // customer's PIX was captured; their action was lost; nothing
    // surfaced to operators.
    //
    // Fix: re-throw the underlying error. The defer-resolver's existing
    // throw-path DLQ (defer-resolver.ts:751) catches it, pushes to the
    // dead-letter queue, and crucially DOES NOT commit defer:resumed.
    // A retry from NATS redelivery (or recovery scan) becomes possible.
    //
    // A future audit event `kernel.resume.failed` carrying intentHash +
    // toolName + error class would let operator dashboards distinguish
    // this from other DLQ entries — tracked as a follow-up.
    log?.error(
      {
        sessionId,
        intentHash,
        toolName: result.toolName,
        err: result.error.message,
      },
      "[resume-dispatcher] kernel-covered resume tool threw — surfacing to DLQ",
    )
    throw result.error
  }

  // result.kind === "unsupported"
  log?.warn(
    {
      sessionId,
      intentHash,
      envelopeKind: result.envelopeKind,
      toolName: result.toolName ?? toolName,
    },
    "[resume-dispatcher] parked envelope kind/toolName has no resume dispatch route — skipping",
  )
}
