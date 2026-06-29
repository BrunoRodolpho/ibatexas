// Resume-path dispatcher adapter — F1 follow-up; re-expressed in WS5.
//
// Builds the `ResumeIntentDispatcher` the defer-resolver subscriber calls after
// a parked envelope has been re-adjudicated to EXECUTE on PIX-confirmed. It
// turns a resumed intent into a direct `@ibatexas/tools` handler invocation.
//
// # WS5 (claustrum-on-dev) — why this was re-expressed
//
// Pre-WS5 this adapter delegated to two `@ibatexas/llm-provider` BRAIN modules:
//
//   - `intent-dispatcher` (`createIntentDispatcher` + `createDefaultDispatchHandlers`)
//     — the post-adjudication EXECUTE consumer for LLM-proposed tools
//     (handoff_to_human / schedule_follow_up / set_pix_details). It returned
//     `skipped` for tools the deterministic kernel-executor already ran on the
//     hot path, to avoid a double-write.
//   - `resume-kernel-dispatcher` (`dispatchResumedKernelEnvelope`) — the
//     resume-side dispatcher for the four kernel-covered mutations
//     (add_to_cart / create_checkout / cancel_order / regenerate_pix), which
//     have no XState pass on the resume path.
//
// Both BRAIN modules are deleted in WS8. They are NOT a separate execution
// substrate — both ultimately call the SAME `@ibatexas/tools` handler
// functions that the claustrum tool registry
// (`apps/api/src/tools/register-ibatexas-tool-packs.ts`, WS3) wraps and
// resolves by intent kind. WS5 collapses the two-layer BRAIN indirection into a
// single resume dispatch table keyed by the resumed intent's `kind` (or, for
// the generic `order.tool.propose` envelope, its `payload.toolName`) → the
// matching `@ibatexas/tools` handler — mirroring the registry's
// `intentKind → handler` bindings exactly. This takes the resume path OFF
// llm-provider while preserving every governance guarantee below.
//
// # Governance guarantees preserved (read carefully before editing)
//
// 1. Audit-record-emit-BEFORE-dispatch. The defer-resolver subscriber emits its
//    `supersedes`-linked audit record BEFORE invoking this dispatcher
//    (`defer-resolver.ts` §"Emit audit record linking the resumption…"). That
//    ordering is owned entirely by the subscriber and is UNCHANGED by WS5 — by
//    the time we run, the resume is already recorded. We never emit audit here.
//
// 2. The dispatcher-exception safety split — the subtle part. The subscriber's
//    contract is "an exception cannot leave the audit log inconsistent". It is
//    realized by an ASYMMETRY this adapter must reproduce exactly:
//
//      a. Kernel-covered tools (the destructive PIX-settlement mutations:
//         add_to_cart / create_checkout / cancel_order / regenerate_pix). On a
//         tool throw we RE-THROW. The subscriber's dispatch try/catch
//         (`defer-resolver.ts` ~line 745) then DLQs and — crucially — does NOT
//         commit `defer:resumed:{hash}` / does NOT DEL the parked key, so a NATS
//         redelivery or recovery scan can retry. This is the audit-2026-05-25
//         (I6) fix: pre-fix a swallowed kernel throw let the subscriber treat
//         the resume as "completed" (SETNX defer:resumed, DEL parked, DECR
//         quota) while the destructive mutation never ran — the customer's PIX
//         was captured, their action lost, nothing surfaced to ops.
//
//      b. Non-kernel LLM tools (handoff_to_human / schedule_follow_up /
//         set_pix_details). On a handler throw we LOG + return void (swallow).
//         The audit record already captured the EXECUTE decision; throwing would
//         break the subscriber's SCAN loop and starve every later parked session
//         in the same sweep. These tools are idempotent-ish notifications, not
//         money settlement, so an audit-only outcome is the accepted degrade.
//
//    The outer catch-all swallows only UNEXPECTED adapter/translation bugs (so a
//    malformed parked blob can't break the loop), never a kernel-tool failure —
//    those are re-raised inside the inner handler and propagate past the
//    catch-all via the explicit re-throw path.
//
// 3. The `ResumedIntent` / `ResumeIntentDispatcher` contract from
//    `defer-resolver.ts` is unchanged; `setResumeIntentDispatcher(...)` /
//    `createResumeDispatcherAdapter(...)` wiring in `apps/api/src/index.ts`
//    keeps working as-is.

import type { FastifyBaseLogger } from "fastify"
import type { IntentEnvelope, IntentActor } from "@adjudicate/core"
import {
  addToCart,
  cancelOrder,
  createCheckout,
  handoffToHuman,
  regeneratePix,
  scheduleFollowUp,
  setPixDetails,
} from "@ibatexas/tools"
import type { AgentContext, HandoffToHumanInput } from "@ibatexas/types"
import { Channel } from "@ibatexas/types"
import type {
  ResumedIntent,
  ResumeIntentDispatcher,
} from "../subscribers/defer-resolver.js"

// ── Resume tool surface ────────────────────────────────────────────────────
//
// The exact union of tools the pre-WS5 BRAIN path could resume — no more, no
// fewer. Split by the exception-safety tier (guarantee #2):
//
//   - KERNEL-COVERED: the deterministic mutations that DEFER on PIX-pending and
//     resume on confirmation. A throw RE-THROWS (DLQ + no-commit). These are
//     keyed by BOTH the canonical taxonomy kind (kernel-direct parked
//     envelopes, parked by kernel-executor.ts) AND the legacy tool-name alias
//     (LLM-proposed `order.tool.propose` envelopes whose payload.toolName
//     carries the real identity). Both map to one `@ibatexas/tools` handler —
//     identical to the registry's `intentKind === capability → handler` row.
//
//   - NON-KERNEL: LLM-only tools the deterministic kernel never covered. A
//     throw is LOGGED + swallowed (audit already captured the decision).
//
// `intentKind` matches the claustrum registry's `intentKind`/`capability` for
// the mutating tools (register-ibatexas-tool-packs.ts: order.item.add,
// order.checkout.create, order.cancel, payment.pix.regenerate,
// customer.pix.details.save) — so this table is the resume-side projection of
// the same handler bindings the registry resolves.

/** Canonical taxonomy kinds the deterministic kernel-executor mutates. */
const KERNEL_KIND_ADD_ITEM = "order.item.add"
const KERNEL_KIND_CHECKOUT = "order.checkout.create"
const KERNEL_KIND_CANCEL = "order.cancel"
const KERNEL_KIND_PIX_REGENERATE = "payment.pix.regenerate"

/** Legacy tool-name aliases carried in `order.tool.propose` payloads. */
const TOOLNAME_ADD_TO_CART = "add_to_cart"
const TOOLNAME_CREATE_CHECKOUT = "create_checkout"
const TOOLNAME_CANCEL_ORDER = "cancel_order"
const TOOLNAME_REGENERATE_PIX = "regenerate_pix"

const TOOLNAME_HANDOFF = "handoff_to_human"
const TOOLNAME_SCHEDULE_FOLLOW_UP = "schedule_follow_up"
const TOOLNAME_SET_PIX_DETAILS = "set_pix_details"

/**
 * Injectable `@ibatexas/tools` handlers. Production leaves these undefined and
 * gets the live functions; tests inject spies to assert routing without
 * standing up Medusa / Prisma / NATS. Field names match the underlying tool
 * function names one-to-one.
 *
 * (WS5: this replaces the old `ResumeDispatcherAdapterDeps.kernelDispatcherDeps`
 * — which only covered the 4 kernel tools — AND the old `dispatcher` injection
 * point, unifying both onto one tool-override seam. The four kernel tool names
 * are byte-identical to the pre-WS5 `ResumeKernelDispatchDeps` fields so kernel
 * test injections carry over unchanged.)
 */
export interface ResumeDispatchTools {
  // Kernel-covered (re-throw on failure → DLQ + no-commit).
  readonly addToCart?: typeof addToCart
  readonly createCheckout?: typeof createCheckout
  readonly cancelOrder?: typeof cancelOrder
  readonly regeneratePix?: typeof regeneratePix
  // Non-kernel LLM tools (log + swallow on failure).
  readonly handoffToHuman?: typeof handoffToHuman
  readonly scheduleFollowUp?: typeof scheduleFollowUp
  readonly setPixDetails?: typeof setPixDetails
}

// ── Public deps ──────────────────────────────────────────────────────────────

export interface ResumeDispatcherAdapterDeps {
  /**
   * Override the `@ibatexas/tools` handlers the resume dispatch table invokes.
   * Tests inject spies; production leaves this unset and gets the live
   * functions.
   */
  readonly tools?: ResumeDispatchTools
  /**
   * Module-level fallback logger when the subscriber doesn't pass one (it
   * always does in production — this is a belt-and-braces default).
   */
  readonly log?: FastifyBaseLogger
}

// ── Resume dispatch identity ──────────────────────────────────────────────────

type ResumeTier = "kernel" | "non_kernel"

interface ResumeRoute {
  readonly tier: ResumeTier
  /** Stable name used for logging / DLQ metadata. */
  readonly toolName: string
  /**
   * Invoke the resolved `@ibatexas/tools` handler with the extracted payload +
   * derived ctx. Throws on tool failure; the caller applies the tier's
   * throw-policy. Returns the tool's result (unused by the void-returning
   * adapter, kept for parity / future audit enrichment).
   */
  readonly run: (
    tools: ResumeDispatchTools,
    input: unknown,
    ctx: AgentContext,
  ) => Promise<unknown>
}

/**
 * Resolve the resume dispatch route from a parked envelope's `kind` (or, for
 * the generic `order.tool.propose` envelope, its `payload.toolName`). Returns
 * null when the parked envelope is for a tool the resume path cannot run — the
 * caller logs a warning and returns void (no kernel-covered surface to retry).
 *
 * This is the WS5 kind→handler lookup: a 1:1 projection of the claustrum
 * registry's `intentKind → @ibatexas/tools handler` rows, augmented with the
 * legacy tool-name aliases the LLM-proposed park path carries and the
 * non-kernel notification tools the deterministic kernel never covered.
 */
function resolveResumeRoute(envelope: IntentEnvelope): ResumeRoute | null {
  const identity = resumeIdentity(envelope)
  if (identity === null) return null

  switch (identity) {
    // ── Kernel-covered mutations (re-throw on failure) ───────────────────
    case KERNEL_KIND_ADD_ITEM:
    case TOOLNAME_ADD_TO_CART:
      return {
        tier: "kernel",
        toolName: TOOLNAME_ADD_TO_CART,
        run: (tools, input, ctx) =>
          (tools.addToCart ?? addToCart)(
            input as Parameters<typeof addToCart>[0],
            ctx,
          ),
      }
    case KERNEL_KIND_CHECKOUT:
    case TOOLNAME_CREATE_CHECKOUT:
      return {
        tier: "kernel",
        toolName: TOOLNAME_CREATE_CHECKOUT,
        run: (tools, input, ctx) =>
          (tools.createCheckout ?? createCheckout)(
            input as Parameters<typeof createCheckout>[0],
            ctx,
          ),
      }
    case KERNEL_KIND_CANCEL:
    case TOOLNAME_CANCEL_ORDER:
      return {
        tier: "kernel",
        toolName: TOOLNAME_CANCEL_ORDER,
        run: (tools, input, ctx) =>
          (tools.cancelOrder ?? cancelOrder)(
            input as Parameters<typeof cancelOrder>[0],
            ctx,
          ),
      }
    case KERNEL_KIND_PIX_REGENERATE:
    case TOOLNAME_REGENERATE_PIX:
      return {
        tier: "kernel",
        toolName: TOOLNAME_REGENERATE_PIX,
        run: (tools, input, ctx) =>
          (tools.regeneratePix ?? regeneratePix)(
            input as Parameters<typeof regeneratePix>[0],
            ctx,
          ),
      }

    // ── Non-kernel LLM tools (log + swallow on failure) ──────────────────
    case TOOLNAME_HANDOFF:
      return {
        tier: "non_kernel",
        toolName: TOOLNAME_HANDOFF,
        // handoff_to_human reads only the input payload; ctx is unused.
        run: (tools, input) =>
          (tools.handoffToHuman ?? handoffToHuman)(input as HandoffToHumanInput),
      }
    case TOOLNAME_SCHEDULE_FOLLOW_UP:
      return {
        tier: "non_kernel",
        toolName: TOOLNAME_SCHEDULE_FOLLOW_UP,
        run: (tools, input, ctx) =>
          (tools.scheduleFollowUp ?? scheduleFollowUp)(
            input as Parameters<typeof scheduleFollowUp>[0],
            ctx,
          ),
      }
    case TOOLNAME_SET_PIX_DETAILS:
      return {
        tier: "non_kernel",
        toolName: TOOLNAME_SET_PIX_DETAILS,
        run: (tools, input, ctx) =>
          (tools.setPixDetails ?? setPixDetails)(
            input as Parameters<typeof setPixDetails>[0],
            ctx,
          ),
      }

    default:
      // resumeIdentity returned a non-null string but it's not on the resume
      // surface — a parked envelope for a tool we don't know how to resume.
      return null
  }
}

/**
 * Resolve the dispatch identity string from a parked envelope.
 *
 *   - Kernel-direct parked envelopes (parked by kernel-executor.ts): `kind` IS
 *     the taxonomy mutation kind.
 *   - LLM-proposed parked envelopes: `kind` is the generic
 *     `order.tool.propose` and `payload.toolName` carries the real identity
 *     (see llm-responder.ts park site).
 *
 * Returns null when neither yields a usable identity.
 */
function resumeIdentity(envelope: IntentEnvelope): string | null {
  const kind = envelope.kind
  if (kind !== "order.tool.propose") {
    // Kernel-direct (or any future domain-specific) kind — use it directly.
    return kind
  }
  const payload = envelope.payload as { toolName?: unknown } | null
  if (
    payload &&
    typeof payload === "object" &&
    typeof payload.toolName === "string"
  ) {
    return payload.toolName
  }
  return null
}

// ── Payload + context extraction ──────────────────────────────────────────────

/**
 * Extract the tool input from a parked envelope.
 *
 *   - `order.tool.propose`: the input is in `payload.input` (the LLM-proposed
 *     tool arguments).
 *   - Kernel-direct envelopes: the payload IS the input.
 *
 * Both shapes are validated by the underlying tool's Zod schema; we hand the
 * raw object across.
 */
function extractInput(envelope: IntentEnvelope): unknown {
  if (envelope.kind === "order.tool.propose") {
    const p = envelope.payload as { input?: unknown } | null
    if (p && typeof p === "object") {
      return p.input ?? {}
    }
    return {}
  }
  return envelope.payload ?? {}
}

/**
 * Build the `AgentContext` for a NON-KERNEL resume tool. The parked envelope
 * only carries `actor.sessionId`; everything else is synthesized.
 *
 *   - `sessionId`  — from `envelope.actor.sessionId`; load-bearing for handlers
 *                    that key off it (handoff_to_human writes a NATS event
 *                    with this).
 *   - `channel`    — `Channel.WhatsApp`. PIX-deferred intents are today
 *                    exclusively a WhatsApp-ordering concern (the web checkout
 *                    path returns the PIX QR synchronously; it does not DEFER).
 *   - `userType`   — `"customer"`. Resume only happens for customer-initiated
 *                    parks; system-only kinds never DEFER via the responder.
 *   - `customerId` — left undefined. The non-kernel handlers that need it
 *                    (schedule_follow_up) read it from the input payload or
 *                    fall back to sessionId-keyed Redis; we keep this adapter
 *                    side-effect-free (no Redis spelunking).
 *
 * NOTE: this preserves the pre-WS5 `buildResumeAgentContext` shape exactly —
 * `{ sessionId, channel: "whatsapp", userType: "customer" }`.
 */
function buildNonKernelContext(intent: ResumedIntent): AgentContext {
  return {
    sessionId: intent.envelope.actor.sessionId,
    channel: Channel.WhatsApp,
    userType: "customer",
  }
}

/**
 * Build the `AgentContext` for a KERNEL-COVERED resume tool.
 *
 * Identical to the pre-WS5 `resume-kernel-dispatcher.buildResumeKernelContext`,
 * including the audit-2026-05-25 (I6) customerId hoist:
 *
 *   - `customerId` is sourced from `actor.sessionId` WHEN
 *     `actor.principal === "user"` (customer-initiated routes set
 *     `actor.sessionId = customerId` by convention; system-actor envelopes use
 *     `${source}:${eventId}` and must not leak through). Pre-I6 this was always
 *     undefined, which made cancelOrder + regeneratePix hard-throw
 *     ("Autenticação necessária") and addToCart fail assertCartOwnership for
 *     authenticated carts — and, combined with a swallowed throw, silently lost
 *     the resumed mutation after the PIX was captured. The customerId is
 *     therefore load-bearing for both correctness AND the re-throw safety path.
 */
function buildKernelContext(
  sessionId: string,
  actor: IntentActor,
): AgentContext {
  const customerId =
    actor.principal === "user" && actor.sessionId.length > 0
      ? actor.sessionId
      : undefined
  return {
    sessionId,
    channel: Channel.WhatsApp,
    userType: "customer",
    ...(customerId === undefined ? {} : { customerId }),
  }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Build a `ResumeIntentDispatcher`. The returned function is what
 * `setResumeIntentDispatcher` / `startDeferResolverSubscriber({ dispatcher })`
 * accept in `apps/api/src/index.ts`. Construction is cheap; built once at boot
 * and reused for every resumed session.
 */
export function createResumeDispatcherAdapter(
  deps: ResumeDispatcherAdapterDeps = {},
): ResumeIntentDispatcher {
  const tools = deps.tools ?? {}

  return async function dispatchResume(
    intent: ResumedIntent,
    log?: FastifyBaseLogger,
  ): Promise<void> {
    const effectiveLog = log ?? deps.log
    const route = resolveResumeRoute(intent.envelope)

    if (route === null) {
      // No resume dispatch route — the parked envelope is for a tool we
      // cannot run (kernel-direct kind we don't cover, or an
      // `order.tool.propose` with a missing/non-string toolName). The audit
      // record already captured the EXECUTE decision; we log a warning and
      // return void. There is no destructive mutation to retry, so this does
      // NOT re-throw — matching the pre-WS5 `unsupported`/`translate→null`
      // warn-and-return behavior.
      effectiveLog?.warn(
        {
          sessionId: intent.sessionId,
          intentHash: intent.originalIntentHash,
          envelopeKind: intent.envelope.kind,
        },
        "[resume-dispatcher] parked envelope kind/toolName has no resume dispatch route — skipping",
      )
      return
    }

    const input = extractInput(intent.envelope)

    if (route.tier === "kernel") {
      // ── Kernel-covered tier — RE-THROW on failure (DLQ + no-commit). ──
      // This branch is OUTSIDE the non-kernel catch-all below ON PURPOSE: a
      // tool throw here must propagate to the defer-resolver's dispatch
      // try/catch (`defer-resolver.ts` ~line 745) so the resume is DLQ'd and
      // `defer:resumed` is NOT committed / the parked key is NOT deleted —
      // making the destructive PIX-settlement mutation retryable on NATS
      // redelivery or a recovery scan (audit-2026-05-25 I6). Only a successful
      // run logs + returns void.
      //
      // WS5 governance note: the pre-WS5 adapter wrapped the equivalent
      // re-throw inside its catastrophic outer catch-all, which SWALLOWED the
      // kernel throw and let defer-resolver commit the resume after a failed
      // money-settlement mutation — defeating the very I6 fix the inner code
      // documented. WS5 restores the documented behavior: kernel throws escape.
      const ctx = buildKernelContext(intent.sessionId, intent.envelope.actor)
      try {
        await route.run(tools, input, ctx)
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        effectiveLog?.error(
          {
            sessionId: intent.sessionId,
            intentHash: intent.originalIntentHash,
            toolName: route.toolName,
            err: error.message,
          },
          "[resume-dispatcher] kernel-covered resume tool threw — surfacing to DLQ",
        )
        throw error
      }
      effectiveLog?.info(
        {
          sessionId: intent.sessionId,
          intentHash: intent.originalIntentHash,
          toolName: route.toolName,
        },
        "[resume-dispatcher] resumed kernel-covered intent executed",
      )
      return
    }

    // ── Non-kernel tier — LOG + SWALLOW on failure. ──
    // The audit record already captured the EXECUTE decision; a non-kernel
    // notification-tool failure becomes an audit-only outcome. Swallowing
    // protects the subscriber's SCAN loop from one bad envelope starving
    // later sessions. The catch-all also absorbs any unexpected adapter /
    // ctx-build bug on this path (a translation-side defect must never break
    // the loop). It can NEVER swallow a kernel-tool failure — that path
    // returned above.
    try {
      const ctx = buildNonKernelContext(intent)
      await route.run(tools, input, ctx)
      effectiveLog?.info(
        {
          sessionId: intent.sessionId,
          intentHash: intent.originalIntentHash,
          toolName: route.toolName,
        },
        "[resume-dispatcher] resumed intent executed successfully",
      )
    } catch (err) {
      effectiveLog?.error(
        {
          sessionId: intent.sessionId,
          intentHash: intent.originalIntentHash,
          toolName: route.toolName,
          err: (err as Error).message,
        },
        "[resume-dispatcher] underlying dispatcher returned failed — audit-only outcome",
      )
    }
  }
}

/**
 * @internal — re-exported for tests that want to assert routing/identity
 * without invoking the underlying tools.
 */
export const __testOnly__resumeIdentity = resumeIdentity
export const __testOnly__resolveResumeRoute = resolveResumeRoute
