// P0-7-TRUE — ibatexas-side NX-guarded wrapper around `parkDeferredIntent`.
//
// # Why this wrapper exists
//
// The framework's `parkDeferredIntent` in `@adjudicate/runtime` (`defer-park.ts`)
// performs the envelope `SET` without an `NX` flag (see line 219: `redis.set(parkKey,
// JSON.stringify(...), { EX: args.ttlSeconds })`). As a result, a SECOND `DEFER`
// for the same `sessionId` silently OVERWRITES the first parked envelope's blob —
// the cycle counter still increments, but the original payload (e.g. an in-flight
// PIX confirmation) is lost.
//
// The deep audit (master report §1.1 R4, §2.2 P0-7) flagged this as a real data-loss
// class: a misbehaving session emitting two DEFERs back-to-back drops the first
// envelope's resume target.
//
// # What we do
//
// Before calling the framework primitive, we perform an atomic `SET NX` SETNX guard
// against the `defer:pending:{sessionId}` key. If the SETNX fails (another envelope
// is already parked for that session), we return a typed `{parked: false, reason:
// "collision"}` and surface a pt-BR refusal so the user learns their second DEFER
// was rejected rather than silently swallowed.
//
// If the SETNX succeeds, we DELETE the placeholder and immediately call the
// framework `parkDeferredIntent`, which then performs its own quota INCR and the
// actual blob SET (now safe because we already proved nothing was there).
//
// # Why a wrapper, not a framework PR
//
// Per the W1 brief, `@adjudicate/*` source is out of scope for this remediation
// (those packages live in a separate repo). The wrapper lives adopter-side and
// can be removed once the framework primitive gains NX semantics.

import { parkDeferredIntent } from "@adjudicate/runtime"
import { deferParkKey } from "@adjudicate/runtime"
import type {
  ParkDeferredIntentArgs,
  ParkDeferredIntentResult,
} from "@adjudicate/runtime"

// W3-6: bump kernel_defer_quota_exceeded_total{kind} when the framework
// returns `quota_exceeded`. Lazy `import()` so this adapter's hot-path
// tests don't drag the kernel-bootstrap module graph (Packs, llm-provider)
// into their fixture. Recorder is fail-open by construction.
async function bumpDeferQuotaExceededMetric(kind: string): Promise<void> {
  try {
    const { getKernelMetricsRecorder } = await import(
      "../plugins/kernel-bootstrap.js"
    )
    getKernelMetricsRecorder().recordDeferQuotaExceeded(kind)
  } catch {
    // Fail-open.
  }
}

/**
 * Result of `parkDeferredIntentWithNxGuard`.
 *
 * Extends the framework's `ParkDeferredIntentResult` with one extra refusal
 * reason: `collision`, raised when another envelope is already parked for the
 * same `sessionId`. The collision case preserves the FIRST parked envelope —
 * it is the second caller that is rejected.
 */
export type ParkDeferredIntentNxResult =
  | { readonly parked: true; readonly count: number }
  | {
      readonly parked: false
      readonly reason: "quota_exceeded"
      readonly observed: number
      readonly limit: number
    }
  | {
      readonly parked: false
      readonly reason: "collision"
      readonly sessionId: string
    }

/**
 * pt-BR refusal text surfaced when a second DEFER collides with an already-
 * parked envelope. Used by callers (kernel-executor, customer-intent-gateway)
 * to populate the `userFacing` field of the kernel decision wrapper.
 */
export const PARK_COLLISION_REFUSAL_PT_BR =
  "Já existe operação em espera para esta sessão."

/**
 * NX-guarded wrapper around `parkDeferredIntent`.
 *
 * Performs `SET NX` against the park key BEFORE delegating to the framework
 * primitive. If another envelope is already parked for the session, returns
 * `{parked: false, reason: "collision"}` and does NOT touch the existing
 * blob.
 *
 * The NX placeholder we write is immediately replaced by the framework's
 * payload write — so the placeholder is never observed by any reader. We use
 * a sentinel string (rather than the real envelope) so a crash between the
 * SETNX and the framework call leaves a benign marker rather than a
 * partially-written envelope.
 *
 * Concurrency property: under any number of concurrent parks for the same
 * sessionId, exactly one returns `parked: true` (the winner of the SETNX).
 * All others return `parked: false` with `reason: "collision"`. The winner's
 * envelope is the one preserved.
 */
export async function parkDeferredIntentWithNxGuard(
  args: ParkDeferredIntentArgs,
): Promise<ParkDeferredIntentNxResult> {
  // W7-G3: defensively hoist envelope.actor.principal → top-level actorPrincipal
  // so verifyParkedEnvelopeHash can re-derive intentHash on resume.
  const argsHoisted = hoistEnvelopeActorPrincipal(args)
  const sessionId = argsHoisted.envelope.actor.sessionId
  const parkKey = argsHoisted.rk(deferParkKey(sessionId))

  // ─── Step 1: SETNX placeholder ──────────────────────────────────────────
  // We attempt to claim the park slot with a sentinel value and the same TTL
  // the real envelope would have. If another envelope is already parked, the
  // SETNX returns null and we surface a collision refusal — the existing
  // envelope (and its real payload) is left untouched.
  const placeholderValue = JSON.stringify({
    __nx_placeholder__: true,
    sessionId,
    claimedAt: new Date().toISOString(),
  })
  const placeholderClaim = await argsHoisted.redis.set(
    parkKey,
    placeholderValue,
    { EX: argsHoisted.ttlSeconds, NX: true } as unknown as { EX: number },
  )
  if (placeholderClaim !== "OK") {
    argsHoisted.log?.warn?.(
      { sessionId, intentHash: argsHoisted.envelope.intentHash },
      "[park-deferred-intent-nx] collision — envelope already parked",
    )
    return { parked: false, reason: "collision", sessionId }
  }

  // ─── Step 2: delegate to the framework primitive ────────────────────────
  // Now that we own the slot, the framework's plain SET will overwrite our
  // placeholder with the real envelope payload — and the order is what
  // matters. The framework's quota INCR runs inside `parkDeferredIntent`,
  // so a session at quota still gets the proper `quota_exceeded` result.
  try {
    const result = await parkDeferredIntent(argsHoisted)
    if (!result.parked) {
      // Quota exceeded inside the framework — release the slot so the next
      // legitimate DEFER for this session isn't blocked by our placeholder.
      // We swallow del errors; the TTL is the safety net.
      await (argsHoisted.redis as { del?: (k: string) => Promise<unknown> })
        .del?.(parkKey)
        ?.catch(() => {})
      // W3-6 — bump kernel_defer_quota_exceeded_total{kind} per rejection.
      if (result.reason === "quota_exceeded") {
        await bumpDeferQuotaExceededMetric(argsHoisted.envelope.kind)
      }
    }
    return result
  } catch (err) {
    // Park failed mid-flight. Release the slot so subsequent DEFERs can park.
    // Swallow del errors; TTL is the safety net.
    await (argsHoisted.redis as { del?: (k: string) => Promise<unknown> })
      .del?.(parkKey)
      ?.catch(() => {})
    throw err
  }
}

// W7-G3: defensive hoist of envelope.actor.principal → top-level actorPrincipal.
// `verifyParkedEnvelopeHash` reads `actorPrincipal` at the envelope's top
// level; a caller passing a raw `IntentEnvelope` (where principal is nested
// inside actor) without the explicit hoist would silently land in the
// `missing_fields` back-compat branch and disable tamper-at-rest detection.
// Returns the input unchanged when no hoist is needed (preserves referential
// equality). The other three verification fields (version/nonce/taint) have
// no canonical fallback source — callers MUST pass them at top level.
function hoistEnvelopeActorPrincipal(
  args: ParkDeferredIntentArgs,
): ParkDeferredIntentArgs {
  const actor = args.envelope.actor as unknown as {
    sessionId: string
    principal?: string
  }
  if (
    typeof args.envelope.actorPrincipal === "string" ||
    typeof actor.principal !== "string"
  ) {
    return args
  }
  return {
    ...args,
    envelope: {
      ...args.envelope,
      actorPrincipal: actor.principal as "llm" | "user" | "system",
    },
  }
}
