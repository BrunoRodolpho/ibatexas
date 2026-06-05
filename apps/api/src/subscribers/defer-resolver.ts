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
  deferResumeHash,
  DEFAULT_MAX_RESUME_CYCLES,
  DEFER_PENDING_TTL_GRACE_SECONDS,
  type DeferResumeResult,
  type ParkedEnvelope,
} from "@adjudicate/runtime"
import {
  BASIS_CODES,
  buildAuditRecord,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core"
import { adjudicate } from "@adjudicate/core/kernel"
import type { PolicyBundle } from "@adjudicate/core/kernel"
import { getAuditSink } from "@ibatexas/audit-sink"
// WS5 (claustrum-on-dev): repoint the order PolicyBundle + its state types OFF
// the WS8-doomed `@ibatexas/llm-provider` shim onto the first-party Pack. The
// shim's `orderPolicyBundle`/`OrderContext`/`OrderState` were already deprecated
// re-exports of these very bindings (order-policy-bundle.ts), so this is a
// zero-behavior-change repoint of the PIX-settlement re-adjudication path.
import {
  ordersPolicyBundle as _ordersPolicyBundle,
  type OrderState,
} from "@ibatexas/pack-orders"
import type { FastifyBaseLogger } from "fastify"

// The Pack types `ordersPolicyBundle` narrowly as
// `PolicyBundle<OrderIntentKind, OrderPayload, OrderState>`. The resume path
// re-adjudicates an arbitrary PARKED envelope whose `kind` is `string` (it may
// be any deferred kind — `order.confirm`, `order.checkout.create`, …), so we
// re-expose the bundle under the SAME wide `PolicyBundle<string, unknown,
// OrderState>` signature the deprecated `@ibatexas/llm-provider` shim
// (order-policy-bundle.ts) exported — a byte-identical compile-time contract.
// adjudicate() routes by `kind` at runtime regardless of the compile-time type
// param, so this widening is zero behavior change. Variable name `orderPolicyBundle`
// is preserved so the adjudicate() call site below is unchanged.
const orderPolicyBundle: PolicyBundle<string, unknown, OrderState> =
  _ordersPolicyBundle as unknown as PolicyBundle<string, unknown, OrderState>
import { buildSystemEnvelope } from "./__shared__/system-actor-envelope.js"
import { pushToDlq } from "./dlq.js"
import {
  acquireDeferResumingLock,
  releaseDeferResumingLock,
} from "../lib/defer-resuming-lock.js"

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
 * Re-build the minimum `OrderState` needed for the orders PolicyBundle to
 * adjudicate a resumed envelope. We re-derive `paymentStatus` from the
 * just-arrived wire event so the kernel sees a "no longer pending" world
 * and `deferOnPendingPix` returns `null` rather than re-deferring.
 *
 * WS5 (claustrum-on-dev) shape note: the state type is now
 * `@ibatexas/pack-orders`'s `OrderState`, whose `ctx` is the narrow
 * `OrderContext` (`channel` / `customerId` / `cartId` / `orderId`) plus the
 * policy-read optionals (`items` / `fulfillment` / `paymentMethod` /
 * `paymentStatus` / `totalInCentavos` / `lastAction` / `tenantId`). The
 * legacy `@ibatexas/llm-provider` `OrderState` wrapped the full ~40-field
 * machine `OrderContext`, but the order PolicyBundle only ever read the
 * fields the Pack now declares (verified against pack-orders/policies.ts:
 * the guards touch exactly `customerId`, `fulfillment`, `items`,
 * `lastAction`, `orderId`, `paymentMethod`, `paymentStatus`, `tenantId`,
 * `totalInCentavos`). So narrowing to the Pack shape drops only fields the
 * bundle never inspected — ZERO change to the resume re-adjudication
 * verdict. The two governance-load-bearing fields are `paymentMethod` and
 * `paymentStatus`; everything else uses the cleanest guard-tolerable
 * default.
 */
export function buildResumeOrderState(
  parked: ParkedEnvelope,
  event: PaymentStatusChangedEvent,
): OrderState {
  // The parked envelope carries the original actor.sessionId; the wire
  // event carries the new payment status. Together they form the fresh
  // state the kernel needs.
  const ctx: OrderState["ctx"] = {
    // ── Narrow OrderContext base ──────────────────────────────────────
    channel: "whatsapp",
    customerId: null,
    cartId: null,
    orderId: event.orderId,
    // ── Policy-read optionals ─────────────────────────────────────────
    items: [],
    fulfillment: "pickup",
    totalInCentavos: 0,
    lastAction: null,
    // Wire-level status from the event; the kernel guard treats anything
    // in `confirmedStatuses` (ORDER_PIX_CONFIRMED_STATUSES = {paid,
    // captured, confirmed}) as "no longer pending → no DEFER". This is the
    // governance pivot that flips the resume verdict DEFER → EXECUTE.
    paymentMethod:
      (event.method as OrderState["ctx"]["paymentMethod"]) ?? "pix",
    paymentStatus: event.newStatus,
  }
  return { ctx }
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
  // P1-D: distinguish transient Redis errors from null. A real "no park"
  // is `kind: "no_park"`; a Redis IOError / connection drop / timeout
  // surfaces here so the subscriber can DLQ (and ops can detect dropped
  // PIX confirmations).
  | { readonly kind: "transient_error"; readonly reason: string }
  // audit-2026-05-24 E2 (Fix-b): the resolver SETNX-acquired the
  // `defer:resuming:` mutex BUT the parkKey is already gone — the
  // sweeper raced ahead between the resolver's parkKey GET and the
  // SETNX, then published `intent.defer.timeout`, DEL'd the parkKey,
  // and DEL'd the mutex (releasing it for us to acquire). Dispatching
  // here would double-execute. We release the mutex, emit a REFUSE
  // audit record with `rule: "parkKey_missing_after_sweeper"` for
  // forensic clarity, and exit cleanly.
  | {
      readonly kind: "park_missing_after_lock"
      readonly intentHash: string
    }
  | {
      readonly kind: "re_adjudicated"
      readonly intentHash: string
      readonly decision: Decision
      readonly dispatched: boolean
    }

// P1-D — Redis IOError retry policy.
//
// Pre-W2 the defer-resolver's `redis.get(parkedKey).catch(() => null)`
// collapsed transient errors into "no parked envelope", silently dropping
// PIX confirmations during Redis blips. The fix: retry with exponential
// backoff (3 attempts), distinguish real null from caught errors, and
// surface a transient_error result that the subscriber can DLQ.
const REDIS_GET_MAX_RETRIES = 3
const REDIS_GET_BASE_BACKOFF_MS = 50

/**
 * Robust Redis GET with retry and error/null distinction.
 *
 * Returns:
 *   - `{kind: "value", value: string}` — key found with non-null value
 *   - `{kind: "missing"}` — key truly does not exist (null)
 *   - `{kind: "error", err}` — all retries exhausted; transient Redis
 *      failure that the caller should treat as "we don't know" — NOT as
 *      "no parked envelope".
 */
async function robustRedisGet(
  redis: { get(key: string): Promise<string | null> },
  key: string,
  log?: FastifyBaseLogger,
): Promise<
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly err: unknown }
> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= REDIS_GET_MAX_RETRIES; attempt++) {
    try {
      const raw = await redis.get(key)
      if (raw === null) {
        return { kind: "missing" }
      }
      return { kind: "value", value: raw }
    } catch (err) {
      lastErr = err
      log?.warn(
        {
          key,
          attempt,
          maxAttempts: REDIS_GET_MAX_RETRIES,
          err: (err as Error).message,
        },
        "[defer-resolver] redis.get failed — retrying",
      )
      if (attempt < REDIS_GET_MAX_RETRIES) {
        // Exponential backoff: 50ms, 100ms, 200ms.
        const backoff = REDIS_GET_BASE_BACKOFF_MS * Math.pow(2, attempt - 1)
        await new Promise<void>((resolve) => setTimeout(resolve, backoff))
      }
    }
  }
  return { kind: "error", err: lastErr }
}

// P0-8 — Two-phase commit constants.
//
// `defer:resuming:{deferResumeHash}` is the intermediate "claim" marker that
// prevents concurrent NATS deliveries from racing through dispatch and lets
// a startup/sweeper recovery scan detect resumes that crashed mid-flight.
// Short TTL — we trust that a healthy resume completes within seconds; an
// abandoned marker should free its slot promptly so retry can proceed.
const DEFER_RESUMING_TTL_SECONDS = 60

/**
 * Key suffix for the intermediate "resume in-flight" marker. Set BEFORE
 * dispatch fires; cleared on success or failure. Distinct from the runtime's
 * `defer:resumed:{hash}` long-term dedup ledger, which is set ONLY AFTER
 * dispatch completes successfully.
 *
 * Naming: keyed by `deferResumeHash(intentHash, signal)` so the namespace
 * matches the `defer:resumed:*` ledger one-to-one. A crash between the two
 * leaves the `resuming` marker without a corresponding `resumed` entry —
 * the recovery contract.
 */
function deferResumingKey(intentHash: string, signal: string): string {
  return `defer:resuming:${deferResumeHash(intentHash, signal)}`
}

export async function resolveDeferredSession(
  args: ResolveDeferredSessionArgs,
): Promise<ResolveResult> {
  const { sessionId, signal, event, log } = args
  const redis = await getRedisClient()

  // Pre-flight tamper check. We read the raw blob ourselves so we can DLQ
  // a tampered envelope before calling resumeDeferredIntent (which would
  // consume the cycle counter and fail with a logger-only warning).
  //
  // P1-D — distinguish transient Redis errors from a real "no parked
  // envelope". The pre-W2 `.catch(() => null)` collapsed both into "no
  // park", silently dropping PIX confirmations during Redis IOErrors.
  const rawKey = rk(`defer:pending:${sessionId}`)
  const getResult = await robustRedisGet(redis, rawKey, log)
  if (getResult.kind === "error") {
    log?.error(
      { sessionId, signal, err: (getResult.err as Error)?.message },
      "[defer-resolver] redis.get exhausted retries — DLQ + skip",
    )
    await pushToDlq(
      "intent.defer.resume",
      { sessionId, signal, reason: "redis_get_failed" },
      getResult.err,
      log,
    )
    return {
      kind: "transient_error",
      reason: `redis_get_failed: ${
        (getResult.err as Error)?.message ?? "unknown"
      }`,
    }
  }
  if (getResult.kind === "missing") {
    return { kind: "no_park" }
  }
  const raw = getResult.value
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

  // T-005: verify hash BEFORE doing any resume-state mutations so a tampered
  // blob never increments the cycle counter or claims a resuming slot.
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
  // W8-Q2: fail-loud refuse on missing verification fields.
  //
  // The runtime's `verifyParkedEnvelopeHash` returns `{verified: null,
  // reason: "missing_fields"}` when the parked blob lacks any of
  // {version, nonce, taint, actorPrincipal} at the envelope's top level.
  // The runtime treats this as a back-compat branch (warn + proceed under
  // `verifyHash: "warn"`), which silently disables tamper-at-rest detection.
  //
  // The adopter-side contract is stricter: the NX-park wrapper now refuses
  // to write such blobs (`ParkVerificationFieldsMissingError`), so any
  // `missing_fields` blob we see at resume time is either pre-W8-Q2 legacy
  // or evidence that the field-stripping path is being exercised in the
  // wild. Either way we MUST refuse — proceeding would re-execute an
  // envelope we cannot prove is the one originally adjudicated.
  //
  // We do NOT remove the runtime's back-compat branch (other adopters
  // outside ibatexas may legitimately rely on warn mode); we just refuse
  // at our boundary. Tampered + unverifiable both DLQ + return a refusal
  // kind; the parked key is deleted so the same blob doesn't re-trip on
  // every signal.
  if (verification.verified === null) {
    log?.warn(
      {
        sessionId,
        signal,
        intentHash: parked.envelope.intentHash,
        // Help ops triage: which fields were missing?
        hasVersion: typeof parked.envelope.version === "number",
        hasNonce: typeof parked.envelope.nonce === "string",
        hasTaint: typeof parked.envelope.taint === "string",
        hasActorPrincipal: typeof parked.envelope.actorPrincipal === "string",
      },
      "[defer-resolver] park blob unverifiable (missing hash-verification fields) — DLQ + skip",
    )
    await pushToDlq(
      "intent.defer.resume",
      {
        sessionId,
        signal,
        intentHash: parked.envelope.intentHash,
        reason: "missing_fields",
      },
      new Error("park_blob_unverifiable"),
      log,
    )
    // Delete the unverifiable key — leaving it would re-trip on every resume.
    await redis.del(rawKey).catch(() => {})
    return { kind: "park_blob_unverifiable" }
  }

  const intentHash = parked.envelope.intentHash
  const resumingKey = rk(deferResumingKey(intentHash, signal))
  const resumedKey = rk(`defer:resumed:${deferResumeHash(intentHash, signal)}`)

  // P0-8 — Two-phase commit, step 1: check the long-term dedup ledger BEFORE
  // claiming a resuming slot. A duplicate webhook delivery for an already-
  // resumed intent should short-circuit early.
  //
  // P1-D-VERIFY (deep audit #4): the pre-existing `.catch(() => null)` at
  // this site collapsed a transient Redis IOError into "no prior resume",
  // which let the resume path dispatch the envelope a SECOND time. We now
  // go through `robustRedisGet` (3-retry exponential backoff) — same
  // helper the parked-blob GET already uses earlier in this function —
  // and distinguish: missing (proceed to resume), value (already resumed,
  // skip), error (DLQ + transient_error so the subscriber can flag ops).
  const resumedGetResult = await robustRedisGet(redis, resumedKey, log)
  if (resumedGetResult.kind === "error") {
    log?.error(
      { sessionId, signal, intentHash, err: (resumedGetResult.err as Error)?.message },
      "[defer-resolver] redis.get(resumedKey) exhausted retries — DLQ + skip",
    )
    // Release the resuming slot we have not yet claimed — but make sure
    // the cycle counter we haven't yet incremented stays untouched. The
    // DLQ entry surfaces the transient error so ops can investigate.
    await pushToDlq(
      "intent.defer.resume",
      { sessionId, signal, intentHash, reason: "redis_get_resumed_key_failed" },
      resumedGetResult.err,
      log,
    )
    return {
      kind: "transient_error",
      reason: `redis_get_resumed_key_failed: ${
        (resumedGetResult.err as Error)?.message ?? "unknown"
      }`,
    }
  }
  if (resumedGetResult.kind === "value") {
    log?.debug(
      { sessionId, signal, intentHash },
      "[defer-resolver] duplicate webhook delivery — resume already committed",
    )
    return { kind: "duplicate_suppressed", intentHash }
  }
  // resumedGetResult.kind === "missing" — proceed to claim the resuming slot.

  // P0-8 — Two-phase commit, step 2: SETNX the resuming marker. If acquired,
  // we own the resume for this (intentHash, signal) pair. If not, another
  // worker is mid-flight; let them complete.
  //
  // audit-2026-05-25 (I7): UUID-bearing SETNX + Lua-CAD release.
  // Pre-fix the SETNX value was a JSON metadata blob and release was a
  // plain redis.del at 7 sites in this function — under TTL expiry +
  // slow resolver path (Prisma/Medusa stall), the trailing DEL could
  // erase another acquirer's lock and reopen the double-dispatch
  // window (CLAUDE.md rule #10 violation).
  const resuming = await acquireDeferResumingLock(
    resumingKey,
    DEFER_RESUMING_TTL_SECONDS,
    "resolver",
  )
  if (!resuming.acquired) {
    log?.debug(
      { sessionId, signal, intentHash },
      "[defer-resolver] concurrent resume in-flight — duplicate suppressed",
    )
    return { kind: "duplicate_suppressed", intentHash }
  }
  const resumingLockValue = resuming.lockValue

  // audit-2026-05-24 E2 (Fix-b) — post-SETNX parkKey re-check.
  //
  // Race window the P0-2 mutex DOES NOT close: the sweeper SETNX-acquires
  // the same `defer:resuming:` key, publishes `intent.defer.timeout`, DELs
  // parkKey, then DELs the mutex. If the resolver had already read the
  // in-memory park blob (line ~354) but had not yet reached the SETNX
  // above, it can now SETNX-acquire after the sweeper releases — and would
  // dispatch the cached in-memory blob, double-executing the destructive
  // op. Re-check parkKey existence under our mutex: if it's gone, the
  // sweeper already won; release and exit. The parkKey is the ground-truth
  // ownership token; once DEL'd by the sweeper, the resolver must NOT
  // dispatch its stale in-memory blob.
  const parkRecheck = await robustRedisGet(redis, rawKey, log)
  if (parkRecheck.kind === "missing") {
    log?.info(
      { sessionId, signal, intentHash },
      "[defer-resolver] parkKey missing after SETNX — sweeper won race, releasing and exiting (E2 Fix-b)",
    )
    try {
      const refusalEnvelope = buildSystemEnvelope({
        kind: parked.envelope.kind,
        payload: parked.envelope.payload,
        sourceSubject: "payment.status_changed",
        eventId: `${intentHash}:parkKey_missing_after_sweeper`,
      })
      const record = buildAuditRecord({
        envelope: refusalEnvelope,
        decision: {
          kind: "REFUSE",
          refusal: {
            kind: "BUSINESS_RULE",
            code: "defer.resume.skipped",
            userFacing:
              "Resumo do defer cancelado — confirmação de pagamento já foi processada pelo sweeper.",
            detail: "parkKey_missing_after_sweeper",
          },
          basis: [
            {
              category: "business",
              code: BASIS_CODES.business.RULE_VIOLATED,
              detail: {
                rule: "parkKey_missing_after_sweeper",
                kind: parked.envelope.kind,
                signal,
              },
            },
          ],
        },
        durationMs: 0,
        supersedes: {
          predecessorIntentHash: intentHash,
          predecessorAt: parked.parkedAt,
          reason: "defer_resumed",
        },
      })
      void getAuditSink()
        .emit(record)
        .catch((err: unknown) => {
          log?.warn(
            { sessionId, intentHash, err: (err as Error).message },
            "[defer-resolver] defer.resume.skipped audit emit failed",
          )
        })
    } catch (err) {
      log?.warn(
        { sessionId, intentHash, err: (err as Error).message },
        "[defer-resolver] defer.resume.skipped audit record build failed",
      )
    }
    await releaseDeferResumingLock(resumingKey, resumingLockValue)
    return { kind: "park_missing_after_lock", intentHash }
  }
  if (parkRecheck.kind === "error") {
    log?.warn(
      {
        sessionId,
        signal,
        intentHash,
        err: (parkRecheck.err as Error)?.message,
      },
      "[defer-resolver] parkKey re-check failed — releasing resuming slot and returning transient_error",
    )
    await releaseDeferResumingLock(resumingKey, resumingLockValue)
    return {
      kind: "transient_error",
      reason: `redis_get_park_recheck_failed: ${
        (parkRecheck.err as Error)?.message ?? "unknown"
      }`,
    }
  }
  // parkRecheck.kind === "value" — parkKey still present, proceed.

  // P0-8 — Two-phase commit, step 3: bump the per-intentHash cycle counter
  // BEFORE dispatch so a runaway DEFER → resume → DEFER chain refuses past
  // the cap without dispatching the offending cycle. Mirrors the runtime's
  // resumeDeferredIntent cycle-cap logic.
  const cycleKey = rk(`defer:cycle:${intentHash}`)
  const cap = DEFAULT_MAX_RESUME_CYCLES
  try {
    const cycles = await redis.incr(cycleKey)
    await redis
      .expire(cycleKey, DEFER_PENDING_TTL_GRACE_SECONDS)
      .catch(() => {})
    if (cycles > cap) {
      log?.warn(
        { sessionId, signal, intentHash, cycles, cap },
        "[defer-resolver] cycle cap exceeded — refusing to re-execute",
      )
      // Clear the resuming marker so the next attempt isn't blocked by it
      // even though this attempt is refused.
      await releaseDeferResumingLock(resumingKey, resumingLockValue)
      return { kind: "cycle_cap_exceeded", intentHash }
    }
  } catch (err) {
    log?.error(
      { sessionId, signal, intentHash, err: (err as Error).message },
      "[defer-resolver] cycle counter INCR failed — releasing resuming slot",
    )
    await releaseDeferResumingLock(resumingKey, resumingLockValue)
    return { kind: "resume_failed", reason: "cycle_counter_failed" }
  }

  // ── Re-execute through adjudicate() ──────────────────────────────────
  // We have to re-adjudicate against fresh state because the wire signal
  // is supposed to flip the kernel's verdict from DEFER → EXECUTE.
  const envelope = parked.envelope as IntentEnvelope
  const orderState = buildResumeOrderState(parked, event)
  const startedAt = Date.now()
  let decision: Decision
  try {
    decision = adjudicate(envelope, orderState, orderPolicyBundle)
  } catch (err) {
    log?.error(
      { sessionId, intentHash, signal, err: (err as Error).message },
      "[defer-resolver] adjudicate() threw on resume — releasing resuming slot",
    )
    await pushToDlq(
      "intent.defer.resume",
      { sessionId, signal, intentHash },
      err,
      log,
    )
    // Release the resuming claim so retry can re-enter; leave pending intact.
    await releaseDeferResumingLock(resumingKey, resumingLockValue)
    return { kind: "resume_failed", reason: "adjudicate_threw" }
  }

  // Emit audit record linking the resumption back to the original park.
  //
  // P1-5 — `supersedes` carries the original parked intent's hash so the
  // replay/audit reader can chain `DEFER (original) → resume (this record)`
  // by following `record.supersedes.predecessorIntentHash`. The parked
  // envelope's `intentHash` IS the predecessor; `parked.parkedAt` is the
  // wall-clock anchor of the park step the audit reader joins on.
  try {
    const record = buildAuditRecord({
      envelope,
      decision,
      durationMs: Date.now() - startedAt,
      supersedes: {
        predecessorIntentHash: intentHash,
        predecessorAt: parked.parkedAt,
        reason: "defer_resumed",
      },
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
  let dispatchFailed = false
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
        dispatchFailed = true
        log?.error(
          {
            sessionId,
            intentHash,
            signal,
            err: (err as Error).message,
          },
          "[defer-resolver] dispatcher threw on resumed intent — leaving park intact for retry",
        )
        await pushToDlq(
          "intent.defer.resume",
          { sessionId, signal, intentHash, decision: decision.kind },
          err,
          log,
        )
      }
    } else {
      // NEW-P0-X1 — Boot-window race fix.
      //
      // Pre-fix: when the dispatcher is null (the boot-window between
      // `startDeferResolverSubscriber(...)` and `setResumeIntentDispatcher(...)`
      // in `index.ts`), this branch logged a warning and FELL THROUGH to the
      // COMMIT path below — marking `defer:resumed:{hash}` durably committed
      // and deleting `defer:pending:{sessionId}`. The intent was NEVER
      // dispatched. Silent data loss on every cold boot for any in-flight
      // PIX confirmation that landed during the boot window.
      //
      // Post-fix: treat "EXECUTE/REWRITE with no dispatcher" as a dispatch
      // failure — clear the resuming marker, leave the parked envelope
      // intact, and route to DLQ. The next NATS delivery (or sweeper
      // recovery scan) can retry; the parked envelope is recoverable.
      //
      // The proper fix in `apps/api/src/index.ts` is to wire the dispatcher
      // via `startDeferResolverSubscriber({ dispatcher })` BEFORE the NATS
      // subscription becomes live — this branch is the belt-and-braces
      // guard for any caller that forgets.
      dispatchFailed = true
      log?.error(
        { sessionId, intentHash, signal, kind: decision.kind },
        "[defer-resolver] EXECUTE on resume but no dispatcher wired — DATA-LOSS GUARD: leaving park intact for retry (NEW-P0-X1)",
      )
      await pushToDlq(
        "intent.defer.resume",
        { sessionId, signal, intentHash, decision: decision.kind },
        new Error("dispatcher_not_wired"),
        log,
      )
    }
  } else if (decision.kind === "DEFER") {
    // The kernel still wants to wait — fall through. The park TTL will
    // eventually trip the timeout sweeper. Cycle counter still incremented
    // above so the cap protects against pathological re-DEFER.
    log?.info(
      { sessionId, intentHash, signal: decision.signal },
      "[defer-resolver] re-adjudicate returned DEFER — leaving in-flight",
    )
  } else {
    // REFUSE / REQUEST_CONFIRMATION / ESCALATE — kernel rejected on resume.
    log?.info(
      { sessionId, intentHash, signal, kind: decision.kind },
      "[defer-resolver] resumed envelope re-adjudicated to non-EXECUTE",
    )
  }

  // P0-8 — Two-phase commit, step 4: COMMIT or ROLLBACK.
  if (dispatchFailed) {
    // ROLLBACK path — dispatch threw. The parked envelope must remain in
    // Redis so the next NATS delivery (or sweeper recovery scan) can retry.
    // The resuming marker is cleared so retry isn't blocked. The cycle
    // counter increment from above is retained — a dispatch failure still
    // counts as one cycle for cap accounting (the alternative is a DECR
    // that's vulnerable to its own race conditions).
    await releaseDeferResumingLock(resumingKey, resumingLockValue)
    return { kind: "resume_failed", reason: "dispatcher_failed" }
  }

  // COMMIT path — dispatch succeeded (or there was nothing to dispatch).
  // Mark the resume as durably committed via the long-term dedup ledger,
  // delete the parked envelope (so next NATS delivery is a no-op), DECR
  // the per-session quota counter, and clear the intermediate marker.
  //
  // Order matters here:
  //   1. SETNX defer:resumed:{hash} — once this lands, the resume is durable
  //   2. DEL defer:pending:{sessionId} — park consumed
  //   3. DECR defer:count:{sessionId} — quota tracks live state
  //   4. DEL defer:resuming:{hash} — intermediate state cleared
  //
  // A crash after step 1 but before step 2 leaves the pending key alive but
  // the SETNX dedup ledger will catch any retry as "duplicate_suppressed".
  // The pending key TTL eventually GCs it. This is the failure mode the
  // pre-P0-8 code had at EVERY resume; now it's only post-dispatch where
  // execution is already durable.
  await redis
    .set(
      resumedKey,
      JSON.stringify({
        at: new Date().toISOString(),
        intentHash,
        signal,
        sessionId,
      }),
      { NX: true, EX: DEFER_PENDING_TTL_GRACE_SECONDS },
    )
    .catch((err: unknown) => {
      log?.warn(
        { sessionId, intentHash, err: (err as Error).message },
        "[defer-resolver] commit SETNX failed — duplicate webhook may re-trigger",
      )
    })
  await redis.del(rawKey).catch(() => {})
  await redis.decr(rk(`defer:count:${sessionId}`)).catch(() => {})
  await releaseDeferResumingLock(resumingKey, resumingLockValue)

  return {
    kind: "re_adjudicated",
    intentHash,
    decision,
    dispatched,
  }
}

// ── NATS subscriber entry point ────────────────────────────────────────────

/**
 * Optional configuration for `startDeferResolverSubscriber`.
 *
 * `dispatcher` — when provided, wires the resume-intent dispatcher
 * SYNCHRONOUSLY before the NATS subscription becomes live. This
 * eliminates the boot-window race (NEW-P0-X1) where a PIX webhook
 * arriving between `startDeferResolverSubscriber(...)` and the later
 * `setResumeIntentDispatcher(...)` would silently mark a parked
 * envelope as resumed without ever dispatching the intent.
 *
 * Callers that pass `dispatcher` here MUST NOT also call
 * `setResumeIntentDispatcher` separately — the two paths are mutually
 * exclusive. Tests that prefer the singleton wiring may continue to
 * use `setResumeIntentDispatcher` and pass no `dispatcher` here.
 *
 * NOTE: `setResumeIntentDispatcher` remains for backward compatibility
 * with existing tests; new callers should prefer the parameter form.
 * A future Q2 refactor will delete the module-level singleton entirely.
 */
export interface StartDeferResolverSubscriberOptions {
  readonly dispatcher?: ResumeIntentDispatcher
}

export async function startDeferResolverSubscriber(
  log?: FastifyBaseLogger,
  options?: StartDeferResolverSubscriberOptions,
): Promise<void> {
  // NEW-P0-X1 fix: wire dispatcher BEFORE the NATS subscription becomes
  // live so there is no window where `_dispatcher` is null while resume
  // events can arrive. Callers using the legacy singleton path (the
  // pre-fix test corpus) pass no options and continue to work.
  if (options?.dispatcher !== undefined) {
    setResumeIntentDispatcher(options.dispatcher)
  }

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
        } else if (result.kind === "transient_error") {
          // P1-D — Redis IOError exhausted retries; the resume was DLQ'd
          // in resolveDeferredSession. Log at ERROR level for ops alerting.
          log?.error(
            { sessionId, paymentId, orderId, reason: result.reason },
            "[defer-resolver] transient Redis error — PIX confirmation queued in DLQ",
          )
        } else if (result.kind === "park_missing_after_lock") {
          // audit-2026-05-24 E2 (Fix-b) — sweeper won the race; the resolver
          // stepped down cleanly. The skip audit was already emitted inside
          // resolveDeferredSession.
          log?.info(
            { sessionId, paymentId, orderId, intentHash: result.intentHash },
            "[defer-resolver] sweeper won race — resume skipped (E2 Fix-b)",
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
  }, { queueGroup: "defer-resolver" })

  log?.info("[defer-resolver] Subscriber started")
}
