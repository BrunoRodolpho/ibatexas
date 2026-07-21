// Resume-path dispatcher adapter — F1 follow-up; re-expressed in WS5; ACT-071 shim retired.
//
// Builds the `ResumeIntentDispatcher` the defer-resolver subscriber calls after
// a parked envelope has been re-adjudicated to EXECUTE on PIX-confirmed. It
// turns a resumed intent into a direct `@ibatexas/tools` handler invocation.
//
// # WS5 (claustrum-on-dev) — the resume table
//
// The resume path is keyed by the resumed intent's canonical taxonomy `kind`,
// resolved to the matching `@ibatexas/tools` handler — a 1:1 projection of the
// claustrum tool registry's `intentKind → handler` bindings
// (`apps/api/src/tools/register-ibatexas-tool-packs.ts`, WS3). The four
// kernel-covered mutations that DEFER on PIX-pending and resume on confirmation
// (add_to_cart / create_checkout / cancel_order / regenerate_pix) are the only
// kinds the defer path parks + resumes today — the defer-resolver re-adjudicates
// a parked envelope whose `kind` IS the taxonomy mutation kind.
//
// # ACT-071 — the legacy `order.tool.propose` shim was retired here
//
// Pre-WS5 the (now-deleted) `@ibatexas/llm-provider` BRAIN parked LLM-proposed
// tools as a generic `order.tool.propose` envelope whose `payload.toolName`
// carried the real tool identity and `payload.input` the arguments. This adapter
// used to carry a compat shim to DRAIN any still-parked legacy envelope: a
// `payload.toolName`→handler alias table, a `payload.input` extraction, and a
// separate non-kernel notification tier (handoff_to_human / schedule_follow_up /
// set_pix_details — LLM-only tools the deterministic kernel never covered).
//
// The shim is retired (drain check, ACT-071): the `order.tool.propose` kind is
// UNREGISTERED (absent from `@ibatexas/intent-kinds` + CAPABILITY_DEFINITIONS —
// nothing can build or park one), its only writer (the llm-provider responder)
// was deleted in the claustrum cutover months ago, and parked envelopes live
// only inside claustrum session blobs bounded by a 24h (customer) / 48h (guest)
// Redis TTL — so no legacy park can still exist to drain. The non-kernel tier
// went with it: those tools were reachable ONLY via `order.tool.propose`
// payload.toolName (never a taxonomy kind), so once the shim is gone they are
// unreachable. The resume path now routes purely by taxonomy `kind`.
//
// # Governance guarantees preserved (read carefully before editing)
//
// 1. Audit-record-emit-BEFORE-dispatch. The defer-resolver subscriber emits its
//    `supersedes`-linked audit record BEFORE invoking this dispatcher
//    (`defer-resolver.ts` §"Emit audit record linking the resumption…"). That
//    ordering is owned entirely by the subscriber — by the time we run, the
//    resume is already recorded. We never emit audit here.
//
// 2. Kernel-covered re-throw → DLQ + no-commit (the load-bearing part). On a
//    tool throw we RE-THROW. The subscriber's dispatch try/catch
//    (`defer-resolver.ts` ~line 745) then DLQs and — crucially — does NOT commit
//    `defer:resumed:{hash}` / does NOT DEL the parked key, so a NATS redelivery
//    or recovery scan can retry. This is the audit-2026-05-25 (I6) fix: pre-fix a
//    swallowed kernel throw let the subscriber treat the resume as "completed"
//    (SETNX defer:resumed, DEL parked, DECR quota) while the destructive
//    mutation never ran — the customer's PIX was captured, their action lost,
//    nothing surfaced to ops. Every surviving resume route is a destructive
//    PIX-settlement mutation, so a throw ALWAYS surfaces to the DLQ; only an
//    unresolvable parked kind (no route) warns + returns void (nothing to retry).
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
  regeneratePix,
} from "@ibatexas/tools"
import type { AgentContext } from "@ibatexas/types"
import { Channel } from "@ibatexas/types"
import type {
  ResumedIntent,
  ResumeIntentDispatcher,
} from "../subscribers/defer-resolver.js"

// ── Resume tool surface ────────────────────────────────────────────────────
//
// The kernel-covered mutations that DEFER on PIX-pending and resume on
// confirmation. A throw RE-THROWS (DLQ + no-commit, guarantee #2). They are
// keyed by the canonical taxonomy `kind` (the same identity the kernel-executor
// parked and the defer-resolver re-adjudicates) — the resume-side projection of
// the registry's `intentKind === capability → handler` rows
// (register-ibatexas-tool-packs.ts: order.item.add, order.checkout.create,
// order.cancel, payment.pix.regenerate).

/** Canonical taxonomy kinds the deterministic kernel-executor mutates. */
const KERNEL_KIND_ADD_ITEM = "order.item.add"
const KERNEL_KIND_CHECKOUT = "order.checkout.create"
const KERNEL_KIND_CANCEL = "order.cancel"
const KERNEL_KIND_PIX_REGENERATE = "payment.pix.regenerate"

/**
 * Injectable `@ibatexas/tools` handlers. Production leaves these undefined and
 * gets the live functions; tests inject spies to assert routing without
 * standing up Medusa / Prisma / NATS. Field names match the underlying tool
 * function names one-to-one.
 */
export interface ResumeDispatchTools {
  readonly addToCart?: typeof addToCart
  readonly createCheckout?: typeof createCheckout
  readonly cancelOrder?: typeof cancelOrder
  readonly regeneratePix?: typeof regeneratePix
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

interface ResumeRoute {
  /** Stable name used for logging / DLQ metadata. */
  readonly toolName: string
  /**
   * Invoke the resolved `@ibatexas/tools` handler with the parked payload +
   * derived ctx. Throws on tool failure; the caller re-throws to the DLQ.
   * Returns the tool's result (unused by the void-returning adapter, kept for
   * parity / future audit enrichment).
   */
  readonly run: (
    tools: ResumeDispatchTools,
    input: unknown,
    ctx: AgentContext,
  ) => Promise<unknown>
}

/**
 * Resolve the resume dispatch route from a parked envelope's taxonomy `kind`.
 * Returns null when the parked envelope is for a kind the resume path cannot run
 * — the caller logs a warning and returns void (no kernel-covered surface to
 * retry).
 *
 * This is the WS5 kind→handler lookup: a 1:1 projection of the claustrum
 * registry's `intentKind → @ibatexas/tools handler` rows for the four
 * PIX-deferrable mutations.
 */
function resolveResumeRoute(envelope: IntentEnvelope): ResumeRoute | null {
  switch (envelope.kind) {
    case KERNEL_KIND_ADD_ITEM:
      return {
        toolName: "add_to_cart",
        run: (tools, input, ctx) =>
          (tools.addToCart ?? addToCart)(
            input as Parameters<typeof addToCart>[0],
            ctx,
          ),
      }
    case KERNEL_KIND_CHECKOUT:
      return {
        toolName: "create_checkout",
        run: (tools, input, ctx) =>
          (tools.createCheckout ?? createCheckout)(
            input as Parameters<typeof createCheckout>[0],
            ctx,
          ),
      }
    case KERNEL_KIND_CANCEL:
      return {
        toolName: "cancel_order",
        run: (tools, input, ctx) =>
          (tools.cancelOrder ?? cancelOrder)(
            input as Parameters<typeof cancelOrder>[0],
            ctx,
          ),
      }
    case KERNEL_KIND_PIX_REGENERATE:
      return {
        toolName: "regenerate_pix",
        run: (tools, input, ctx) =>
          (tools.regeneratePix ?? regeneratePix)(
            input as Parameters<typeof regeneratePix>[0],
            ctx,
          ),
      }

    default:
      // A parked envelope for a kind we don't know how to resume.
      return null
  }
}

// ── Context extraction ──────────────────────────────────────────────────────

/**
 * Build the `AgentContext` for a resumed kernel-covered tool.
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
      // No resume dispatch route — the parked envelope is for a kind we cannot
      // run. The audit record already captured the EXECUTE decision; we log a
      // warning and return void. There is no destructive mutation to retry, so
      // this does NOT re-throw.
      effectiveLog?.warn(
        {
          sessionId: intent.sessionId,
          intentHash: intent.originalIntentHash,
          envelopeKind: intent.envelope.kind,
        },
        "[resume-dispatcher] parked envelope kind has no resume dispatch route — skipping",
      )
      return
    }

    // Kernel-direct parked envelopes carry the tool input AS the payload.
    const input = intent.envelope.payload ?? {}

    // ── Kernel-covered dispatch — RE-THROW on failure (DLQ + no-commit). ──
    // A tool throw must propagate to the defer-resolver's dispatch try/catch
    // (`defer-resolver.ts` ~line 745) so the resume is DLQ'd and `defer:resumed`
    // is NOT committed / the parked key is NOT deleted — making the destructive
    // PIX-settlement mutation retryable on NATS redelivery or a recovery scan
    // (audit-2026-05-25 I6). Only a successful run logs + returns void.
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
  }
}

/**
 * @internal — re-exported for tests that want to assert routing/identity
 * without invoking the underlying tools.
 */
export const __testOnly__resolveResumeRoute = resolveResumeRoute
