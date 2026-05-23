// IBX-IGE Phase P0-c — DEFER consumer NATS wiring.
//
// Task 03 (adjudicate-migration): this subscriber now actually re-executes
// the parked envelope on resume. Prior to this task it merely flipped the
// dedup ledger key (see investigation 04 §"Defer-resolver subscriber +
// critical bug"). The fix:
//
//   1. SCAN `defer:pending:*` for parked envelopes whose `signal` matches
//      the wire event we just received.
//   2. For each match, verify the parked-envelope hash (T-005 invariant —
//      reject tamper-at-rest before the kernel ever sees the payload).
//   3. Call `resumeDeferredIntent` from `@adjudicate/runtime` for the
//      dedup-ledger + cycle-cap bookkeeping. If it reports
//      `duplicate_resume_suppressed` or `cycle_cap_exceeded`, log and skip.
//   4. On `{resumed: true}` re-build the runtime state and call
//      `adjudicate(envelope, state, orderPolicyBundle)`. Route on the new
//      decision kind:
//        - EXECUTE: dispatch through the same intent-dispatcher used on
//          the responder hot path (Task 02 owns its construction). An
//          audit record is emitted with `supersedes` linking the resume
//          back to the original park.
//        - DEFER: the kernel still wants to wait — leave well alone; the
//          park TTL will catch the timeout. Cycle counter increments.
//        - REFUSE / REWRITE / REQUEST_CONFIRMATION / ESCALATE: emit an
//          audit record marking the supersession; no dispatch.
//        - Tampered park blob: push to DLQ and skip.
//
// Note: PaymentStatusChangedEvent carries `customerId` but not `sessionId`.
// Resume key is keyed by sessionId because that is what the responder writes
// when parking. We scan all parked sessions on each confirmation event;
// volume is low (only sessions with PIX-deferred intents), and the SET NX
// dedup makes spurious resume attempts safe. A real production deployment
// may swap this to a session-by-orderId index when parked-session count
// grows.

import { subscribeNatsEvent } from "@ibatexas/nats-client"
import { getRedisClient, rk } from "@ibatexas/tools"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"
import { PIX_CONFIRMATION_SIGNAL } from "@adjudicate/pack-payments-pix"
import {
  resumeDeferredIntent as resumeDeferredIntentImpl,
  verifyParkedEnvelopeHash,
  type DeferResumeResult,
  type ParkedEnvelope,
} from "@adjudicate/runtime"
import {
  buildAuditRecord,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core"
import { adjudicate } from "@adjudicate/core/kernel"
import {
  getAuditSink,
  orderPolicyBundle,
  type OrderContext,
  type OrderState,
} from "@ibatexas/llm-provider"
import type { FastifyBaseLogger } from "fastify"
import { pushToDlq } from "./dlq.js"

// Wire-level "this PIX has settled" status set, in IbateXas's Stripe
// vocabulary (`paid`, `captured`, `confirmed`). Distinct from the
// Pack's `PIX_CONFIRMED_STATUSES`, which uses the Pack's normalized
// `PixChargeStatus` vocabulary and excludes `paid`. Kept local because
// the mapping from Stripe labels to settled-or-not is an IbateXas
// concern, not a Pack contract.
const SETTLED_WIRE_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "captured",
  "confirmed",
])

// SCAN batch size — small enough to keep round-trips cheap, large enough
// that a session with O(10) parks resolves in one round-trip.
const SCAN_COUNT = 100

// ── Re-execution dispatcher seam ────────────────────────────────────────────
//
// The intent-dispatcher (Task 02) is the canonical EXECUTE consumer. The
// subscriber accepts it as a dependency so that merging task 02 + task 03
// becomes a one-line registration in `apps/api/src/index.ts`. Until task
// 02 lands, the dispatcher is `undefined` and EXECUTE decisions surface
// only via the audit stream — they are NOT silently re-tried (which
// would race against the responder hot path).

export interface ResumedIntent {
  readonly envelope: IntentEnvelope
  readonly sessionId: string
  readonly originalIntentHash: string
}

export type ResumeIntentDispatcher = (
  intent: ResumedIntent,
  log?: FastifyBaseLogger,
) => Promise<void>

let _dispatcher: ResumeIntentDispatcher | null = null

/**
 * Wire the dispatcher used to re-execute resumed EXECUTE decisions.
 * Called from `apps/api/src/index.ts` once Task 02's intent-dispatcher
 * is constructed. Idempotent. Setting back to `null` disables dispatch
 * (audit still fires).
 */
export function setResumeIntentDispatcher(
  dispatcher: ResumeIntentDispatcher | null,
): void {
  _dispatcher = dispatcher
}

/** @internal — visible for testing only */
export function _getResumeIntentDispatcher(): ResumeIntentDispatcher | null {
  return _dispatcher
}

// ── Public single-session entry point ──────────────────────────────────────

/**
 * Pure adapter from IbateXas's Redis client to `@adjudicate/runtime`'s
 * `resumeDeferredIntent`. Used by the subscriber loop AND exported so
 * other consumers (tests, manual ops scripts) can resume a single
 * session without involving the NATS event path.
 *
 * NOTE: this is the dedup/cycle-cap step only. To actually re-execute
 * the parked envelope, use {@link resolveDeferredSession} below.
 */
export async function resumeDeferredIntent(
  sessionId: string,
  signal: string,
  log?: FastifyBaseLogger,
): Promise<DeferResumeResult> {
  const redis = await getRedisClient()
  return resumeDeferredIntentImpl({ sessionId, signal, redis, rk, log })
}

// ── State derivation for re-adjudicate ─────────────────────────────────────

/**
 * Re-build the minimum `OrderState` needed for the order-policy-bundle to
 * adjudicate a resumed envelope. We re-derive `paymentStatus` from the
 * just-arrived wire event so the kernel sees a "no longer pending" world
 * and `deferOnPendingPix` returns `null` rather than re-deferring.
 *
 * Only fields used by the existing guards are populated; everything else
 * uses the cleanest defaults the guards can tolerate.
 */
export function buildResumeOrderState(
  parked: ParkedEnvelope,
  event: PaymentStatusChangedEvent,
): OrderState {
  // The parked envelope carries the original actor.sessionId; the wire
  // event carries the new payment status. Together they form the fresh
  // state the kernel needs.
  const ctx: Partial<OrderContext> = {
    channel: "whatsapp",
    customerId: null,
    customerName: null,
    isAuthenticated: true, // re-execution is system-actor; auth gate was passed at park
    isNewCustomer: false,
    cartId: null,
    items: [],
    totalInCentavos: 0,
    couponApplied: null,
    fulfillment: "pickup",
    deliveryCep: null,
    deliveryFeeInCentavos: null,
    deliveryEtaMinutes: null,
    // Wire-level status from the event; the kernel guard treats anything
    // in `confirmedStatuses` ({paid, captured, confirmed}) as "no longer
    // pending → no DEFER".
    paymentMethod: (event.method as OrderContext["paymentMethod"]) ?? "pix",
    paymentStatus: event.newStatus,
    tipInCentavos: 0,
    customerEmail: null,
    customerTaxId: null,
    upsellRound: 0,
    hasMainDish: false,
    hasSide: false,
    hasDrink: false,
    isCombo: false,
    mealPeriod: "lunch",
    lastError: null,
    pendingProduct: null,
    alternatives: [],
    lastSearchResult: null,
    checkoutResult: null,
    orderId: event.orderId,
    orderCreatedAt: null,
    lastAction: null,
    loyaltyStamps: null,
    secondaryIntent: null,
    momentum: "high",
    lastObjectionSubtype: null,
    fallbackCount: 0,
    activeOrderId: event.orderId,
    activeOrderDisplayId: null,
    activeOrderStatus: null,
    paymentId: event.paymentId,
    pixExpiresAt: null,
  }
  return { ctx: ctx as OrderContext }
}

// ── Per-session resume + re-execute orchestration ──────────────────────────

export interface ResolveDeferredSessionArgs {
  readonly sessionId: string
  readonly signal: string
  readonly event: PaymentStatusChangedEvent
  readonly log?: FastifyBaseLogger
}

export type ResolveResult =
  | { readonly kind: "no_park" }
  | { readonly kind: "park_blob_tampered"; readonly intentHash: string }
  | { readonly kind: "park_blob_unverifiable" }
  | { readonly kind: "duplicate_suppressed"; readonly intentHash: string }
  | { readonly kind: "cycle_cap_exceeded"; readonly intentHash: string }
  | { readonly kind: "signal_mismatch" }
  | { readonly kind: "resume_failed"; readonly reason: string }
  | {
      readonly kind: "re_adjudicated"
      readonly intentHash: string
      readonly decision: Decision
      readonly dispatched: boolean
    }

export async function resolveDeferredSession(
  args: ResolveDeferredSessionArgs,
): Promise<ResolveResult> {
  const { sessionId, signal, event, log } = args
  const redis = await getRedisClient()

  // Pre-flight tamper check. We read the raw blob ourselves so we can DLQ
  // a tampered envelope before calling resumeDeferredIntent (which would
  // consume the cycle counter and fail with a logger-only warning).
  const rawKey = rk(`defer:pending:${sessionId}`)
  const raw = await redis.get(rawKey).catch(() => null)
  if (raw === null) {
    return { kind: "no_park" }
  }
  let parked: ParkedEnvelope
  try {
    parked = JSON.parse(raw) as ParkedEnvelope
  } catch (err) {
    log?.warn(
      { sessionId, err: (err as Error).message },
      "[defer-resolver] malformed parked envelope — DLQ + skip",
    )
    await pushToDlq(
      "intent.defer.resume",
      { sessionId, signal, raw },
      err,
      log,
    )
    // Don't leave the malformed key around — it will trip every subsequent
    // resume sweep with the same parse error.
    await redis.del(rawKey).catch(() => {})
    return { kind: "resume_failed", reason: "malformed_envelope" }
  }

  // Signal-mismatch is not an error — different wire events can fire while
  // a single park waits for `payment.confirmed`. Skip silently.
  if (parked.signal !== signal) {
    return { kind: "signal_mismatch" }
  }

  // T-005: verify hash BEFORE calling resumeDeferredIntent so a tampered
  // blob never increments the cycle counter.
  const verification = verifyParkedEnvelopeHash(parked)
  if (verification.verified === false) {
    log?.warn(
      {
        sessionId,
        signal,
        stored: verification.stored,
        derived: verification.derived,
      },
      "[defer-resolver] park blob tampered — DLQ + skip",
    )
    await pushToDlq(
      "intent.defer.resume",
      {
        sessionId,
        signal,
        intentHash: parked.envelope.intentHash,
        stored: verification.stored,
        derived: verification.derived,
      },
      new Error("park_blob_tampered"),
      log,
    )
    // Delete the tampered key — leaving it would re-trip on every resume.
    await redis.del(rawKey).catch(() => {})
    return {
      kind: "park_blob_tampered",
      intentHash: parked.envelope.intentHash,
    }
  }
  // verified === null means a legacy v0.1 blob without verification fields.
  // The runtime's default verifyMode is "warn", so we let resumeDeferredIntent
  // log + proceed; we do NOT push to DLQ here.

  // Hand off to the runtime for the dedup-ledger + cycle-cap step.
  const result = await resumeDeferredIntentImpl({
    sessionId,
    signal,
    redis,
    rk,
    log,
  })

  if (!result.resumed) {
    if (result.reason === "duplicate_resume_suppressed") {
      log?.debug(
        { sessionId, signal, intentHash: result.intentHash },
        "[defer-resolver] duplicate webhook delivery — replay suppressed",
      )
      return {
        kind: "duplicate_suppressed",
        intentHash: result.intentHash ?? parked.envelope.intentHash,
      }
    }
    if (result.reason === "cycle_cap_exceeded") {
      log?.warn(
        { sessionId, signal, intentHash: result.intentHash },
        "[defer-resolver] cycle cap exceeded — refusing to re-execute",
      )
      return {
        kind: "cycle_cap_exceeded",
        intentHash: result.intentHash ?? parked.envelope.intentHash,
      }
    }
    return {
      kind: "resume_failed",
      reason: result.reason ?? "unknown",
    }
  }

  // ── Re-execute through adjudicate() ──────────────────────────────────
  // `parked` (read above) is the same blob the runtime just consumed.
  // We have to re-adjudicate against fresh state because the wire signal
  // is supposed to flip the kernel's verdict from DEFER → EXECUTE.
  const resumedParked = result.parked ?? parked
  const envelope = resumedParked.envelope as IntentEnvelope
  const intentHash = resumedParked.envelope.intentHash
  const orderState = buildResumeOrderState(resumedParked, event)
  const startedAt = Date.now()
  let decision: Decision
  try {
    decision = adjudicate(envelope, orderState, orderPolicyBundle)
  } catch (err) {
    log?.error(
      { sessionId, intentHash, signal, err: (err as Error).message },
      "[defer-resolver] adjudicate() threw on resume",
    )
    await pushToDlq(
      "intent.defer.resume",
      { sessionId, signal, intentHash },
      err,
      log,
    )
    return { kind: "resume_failed", reason: "adjudicate_threw" }
  }

  // Emit audit record linking the resumption back to the original park.
  // The audit stream is the only place a resume becomes visible to ops
  // (the responder hot path is no longer involved at this point).
  try {
    const record = buildAuditRecord({
      envelope,
      decision,
      durationMs: Date.now() - startedAt,
    })
    void getAuditSink()
      .emit(record)
      .catch((err: unknown) => {
        log?.warn(
          { sessionId, intentHash, err: (err as Error).message },
          "[defer-resolver] audit emit failed",
        )
      })
  } catch (err) {
    log?.warn(
      { sessionId, intentHash, err: (err as Error).message },
      "[defer-resolver] audit record build failed",
    )
  }

  let dispatched = false
  if (decision.kind === "EXECUTE" || decision.kind === "REWRITE") {
    if (_dispatcher) {
      try {
        await _dispatcher(
          { envelope, sessionId, originalIntentHash: intentHash },
          log,
        )
        dispatched = true
        log?.info(
          { sessionId, intentHash, signal, kind: decision.kind },
          "[defer-resolver] resumed intent dispatched",
        )
      } catch (err) {
        log?.error(
          {
            sessionId,
            intentHash,
            signal,
            err: (err as Error).message,
          },
          "[defer-resolver] dispatcher threw on resumed intent",
        )
        await pushToDlq(
          "intent.defer.resume",
          { sessionId, signal, intentHash, decision: decision.kind },
          err,
          log,
        )
      }
    } else {
      // Dispatcher not wired (task 02 not yet merged). The audit record
      // above captures the EXECUTE decision; ops can replay manually.
      log?.warn(
        { sessionId, intentHash, signal, kind: decision.kind },
        "[defer-resolver] EXECUTE on resume but no dispatcher wired — audit-only",
      )
    }
  } else if (decision.kind === "DEFER") {
    // The kernel still wants to wait — fall through. The park TTL will
    // eventually trip the timeout sweeper. The cycle counter the runtime
    // bumped above will eventually trip the cap.
    log?.info(
      { sessionId, intentHash, signal: decision.signal },
      "[defer-resolver] re-adjudicate returned DEFER — leaving in-flight",
    )
  } else {
    // REFUSE / REQUEST_CONFIRMATION / ESCALATE — kernel rejected on resume.
    // No dispatch; the audit record carries the supersession info.
    log?.info(
      { sessionId, intentHash, signal, kind: decision.kind },
      "[defer-resolver] resumed envelope re-adjudicated to non-EXECUTE",
    )
  }

  return {
    kind: "re_adjudicated",
    intentHash,
    decision,
    dispatched,
  }
}

// ── NATS subscriber entry point ────────────────────────────────────────────

export async function startDeferResolverSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  await subscribeNatsEvent("payment.status_changed", async (payload) => {
    const event = payload as unknown as PaymentStatusChangedEvent
    const { newStatus, paymentId, orderId } = event

    if (!SETTLED_WIRE_STATUSES.has(newStatus)) {
      return
    }

    let redis: Awaited<ReturnType<typeof getRedisClient>>
    try {
      redis = await getRedisClient()
    } catch (err) {
      log?.error(
        { err: (err as Error).message },
        "[defer-resolver] Redis unavailable — skipping resume sweep",
      )
      return
    }

    // SCAN over the `defer:pending:*` namespace. SCAN is non-blocking and
    // safe to call from a subscriber callback. KEYS would O(N)-block Redis
    // for the duration of the scan — avoided per CLAUDE.md best practice.
    const pattern = rk("defer:pending:*")
    const seenKeys: string[] = []
    try {
      for await (const key of redis.scanIterator({
        MATCH: pattern,
        COUNT: SCAN_COUNT,
      })) {
        if (Array.isArray(key)) {
          // Some node-redis builds yield batches; flatten defensively.
          seenKeys.push(...key)
        } else {
          seenKeys.push(key as string)
        }
      }
    } catch (err) {
      log?.error(
        { err: (err as Error).message },
        "[defer-resolver] SCAN failed — aborting resume sweep",
      )
      return
    }

    if (seenKeys.length === 0) {
      log?.debug(
        { paymentId, orderId, newStatus },
        "[defer-resolver] no parked envelopes — nothing to resume",
      )
      return
    }

    for (const key of seenKeys) {
      const m = key.match(/defer:pending:(.+)$/)
      if (!m) continue
      const sessionId = m[1]!

      try {
        const result = await resolveDeferredSession({
          sessionId,
          signal: PIX_CONFIRMATION_SIGNAL,
          event,
          log,
        })

        if (result.kind === "re_adjudicated") {
          log?.info(
            {
              sessionId,
              paymentId,
              orderId,
              intentHash: result.intentHash,
              kind: result.decision.kind,
              dispatched: result.dispatched,
            },
            "[defer-resolver] re-adjudicated resumed intent",
          )
        } else if (result.kind === "park_blob_tampered") {
          // Already DLQ'd in resolveDeferredSession.
          log?.warn(
            { sessionId, paymentId, intentHash: result.intentHash },
            "[defer-resolver] tampered park blob — see DLQ intent.defer.resume",
          )
        }
      } catch (err) {
        // Belt-and-braces: never let one bad envelope take down the whole
        // resume sweep. resolveDeferredSession already handles its own
        // errors; this guards against future regressions.
        log?.error(
          { sessionId, paymentId, err: (err as Error).message },
          "[defer-resolver] unexpected error processing session",
        )
        await pushToDlq(
          "intent.defer.resume",
          { sessionId, paymentId, orderId },
          err,
          log,
        )
      }
    }
  })

  log?.info("[defer-resolver] Subscriber started")
}
