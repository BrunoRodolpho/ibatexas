// P0-7-TRUE / audit-2026-05-24 P0-1 — NX-guarded wrapper around `parkDeferredIntent`.
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
// audit-2026-05-24 P0-1: this wrapper previously lived ONLY in `apps/api`, while
// the four hot DEFER call sites (kernel-executor, llm-responder, me.ts ×2) bypassed
// it and reached for the framework primitive directly. Moving the core into
// `@ibatexas/llm-provider` lets every caller — whether in `apps/api/` or
// `packages/llm-provider/` — share a single NX-guarded entry point.
//
// # What we do
//
// Before calling the framework primitive, we perform an atomic `SET NX` SETNX guard
// against the `defer:pending:{sessionId}` key. If the SETNX fails (another envelope
// is already parked for that session), we return a typed `{parked: false, reason:
// "collision"}` and the caller surfaces a pt-BR refusal so the user learns their
// second DEFER was rejected rather than silently swallowed.
//
// If the SETNX succeeds, the framework `parkDeferredIntent` then performs its own
// quota INCR and the actual blob SET (now safe because we already proved nothing
// was there). Quota-exceeded and mid-flight failures release the placeholder so
// subsequent DEFERs can park.
//
// # Why a wrapper, not a framework PR
//
// Per the W1 brief, `@adjudicate/*` source is out of scope for this remediation
// (those packages live in a separate repo). The wrapper lives adopter-side and
// can be removed once the framework primitive gains NX semantics.

import { parkDeferredIntent } from "@adjudicate/runtime"
import { deferCounterKey, deferParkKey } from "@adjudicate/runtime"
import type {
  ParkDeferredIntentArgs,
  ParkDeferredIntentResult,
} from "@adjudicate/runtime"

// ── Injected metrics hook ────────────────────────────────────────────────────
//
// The kernel metrics recorder (`kernel_defer_quota_exceeded_total{kind}`) lives
// in `apps/api/src/plugins/kernel-bootstrap.ts`. To keep this leaf package free
// of an apps/api back-reference, we expose a setter the API boot wires once
// (`installKernelMetricsSink`). When unset (e.g. unit tests, llm-provider
// standalone), the recorder is a no-op — fail-open metrics by construction.

let deferQuotaExceededHook:
  | ((kind: string) => void | Promise<void>)
  | null = null

/**
 * Wire the quota-exceeded metric recorder. Called once at API boot from
 * `installKernelMetricsSink`. Calling with `null` clears the hook (test helper).
 */
export function setDeferQuotaExceededHook(
  hook: ((kind: string) => void | Promise<void>) | null,
): void {
  deferQuotaExceededHook = hook
}

async function bumpDeferQuotaExceededMetric(kind: string): Promise<void> {
  if (!deferQuotaExceededHook) return
  try {
    await deferQuotaExceededHook(kind)
  } catch {
    // Fail-open.
  }
}

// ── Result type ──────────────────────────────────────────────────────────────

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
 * parked envelope. Used by callers (kernel-executor, llm-responder, me.ts) to
 * populate the `userFacing` field of the kernel decision wrapper.
 */
export const PARK_COLLISION_REFUSAL_PT_BR =
  "Já existe operação em espera para esta sessão."

// ── Wrapper ──────────────────────────────────────────────────────────────────

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
  // W8-Q2: hoist envelope.actor.principal → top-level actorPrincipal AND
  // assert version/nonce/taint are present at the top level. The framework's
  // verifyParkedEnvelopeHash reads all four at the envelope's top; if any
  // is missing, the verifier returns {verified: null, reason: "missing_fields"}
  // and the silent back-compat branch disables tamper-at-rest detection.
  // We fail-LOUD at park time so a malformed call never produces an
  // unverifiable blob in Redis.
  const argsHoisted = hoistAndValidateVerificationFields(args)
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
  //
  // audit-2026-05-24 P1-8 — Quota-counter leak on mid-park throw.
  //
  // The framework's `parkDeferredIntent` performs INCR → EXPIRE → check →
  // SET (see node_modules/@adjudicate/runtime/dist/defer-park.js). If a
  // Redis network blip lands between the successful INCR and the SET, the
  // framework throws and the per-session counter is leaked at +1 — quota
  // appears full to subsequent legitimate callers until the TTL clears the
  // counter (DEFER_PENDING_TTL_GRACE_SECONDS = 14d in production).
  //
  // The framework's own rollback path only fires on the synchronous
  // "newCount > quota" branch (which DECRs before returning quota_exceeded);
  // mid-flight throws bypass it entirely.
  //
  // The fix: when the framework call throws, DECR the counter ourselves
  // (best-effort; TTL is the safety net for a DECR failure). The DECR is
  // safe because:
  //   - If the framework had INCR'd: DECR restores the pre-call count.
  //   - If the framework threw BEFORE the INCR (extremely unlikely given
  //     INCR is the first redis call in the framework): DECR would drift
  //     the counter to -1, but the framework treats anything <= quota as
  //     "OK", and a future park's INCR brings it back to 0 or 1. No quota
  //     leak in the opposite direction.
  // The asymmetry favours quota correctness over an unlikely off-by-one.
  const counterKey = argsHoisted.rk(
    deferCounterKey(argsHoisted.envelope.actor.sessionId),
  )
  try {
    const result: ParkDeferredIntentResult = await parkDeferredIntent(
      argsHoisted,
    )
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
    // audit-2026-05-24 P1-8 — DECR the quota counter to undo any INCR the
    // framework may have performed before the throw. Best-effort; the
    // counter's TTL is the safety net.
    await (argsHoisted.redis as { decr?: (k: string) => Promise<unknown> })
      .decr?.(counterKey)
      ?.catch(() => {})
    throw err
  }
}

// ── Verification-field hoist + validation ────────────────────────────────────

// W8-Q2 sentinel: thrown when a caller asks to park an envelope missing one
// of the four hash-verification fields the framework's
// `verifyParkedEnvelopeHash` reads at the envelope's top level
// (`version`, `nonce`, `taint`, `actorPrincipal`). Fail-loud is the
// adopter-side contract: the framework's `verified: null` back-compat branch
// is the silent failure mode we MUST prevent — never produce an unverifiable
// blob.
export class ParkVerificationFieldsMissingError extends Error {
  readonly name = "ParkVerificationFieldsMissingError"
  readonly missing: ReadonlyArray<string>
  readonly intentHash: string
  constructor(missing: ReadonlyArray<string>, intentHash: string) {
    super(
      `parkDeferredIntentWithNxGuard: refusing to park envelope intentHash=${intentHash} — ` +
        `missing top-level verification fields [${missing.join(", ")}]. ` +
        `verifyParkedEnvelopeHash would land in the missing_fields back-compat ` +
        `branch and silently disable tamper-at-rest detection.`,
    )
    this.missing = missing
    this.intentHash = intentHash
  }
}

// W8-Q2: hoist envelope.actor.principal → top-level actorPrincipal AND assert
// the other three verification fields (version, nonce, taint) are present at
// the top level. `verifyParkedEnvelopeHash` reads ALL FOUR at the envelope's
// top; a caller passing a raw `IntentEnvelope` (where principal is nested
// inside actor) without the explicit hoist — OR a caller forgetting to copy
// version/nonce/taint up — would silently land in the `missing_fields`
// back-compat branch and disable tamper-at-rest detection.
//
// Returns the input with `actorPrincipal` populated when the hoist was
// needed. Throws `ParkVerificationFieldsMissingError` when ANY of the four
// required fields is unrecoverable (e.g., taint missing with no source).
// The other three fields (version/nonce/taint) have no canonical fallback
// source — callers MUST pass them at top level.
function hoistAndValidateVerificationFields(
  args: ParkDeferredIntentArgs,
): ParkDeferredIntentArgs {
  const actor = args.envelope.actor as unknown as {
    sessionId: string
    principal?: string
  }
  // Step 1: hoist actor.principal → actorPrincipal when not already at top.
  let envelope = args.envelope
  if (
    typeof envelope.actorPrincipal !== "string" &&
    typeof actor.principal === "string"
  ) {
    envelope = {
      ...envelope,
      actorPrincipal: actor.principal as "llm" | "user" | "system",
    }
  }

  // Step 2: assert ALL FOUR verification fields are present at top level.
  // Anything missing is unrecoverable — we'd produce an unverifiable blob.
  const missing: string[] = []
  if (typeof envelope.version !== "number") missing.push("version")
  if (typeof envelope.nonce !== "string") missing.push("nonce")
  if (typeof envelope.taint !== "string") missing.push("taint")
  if (typeof envelope.actorPrincipal !== "string") missing.push("actorPrincipal")
  if (missing.length > 0) {
    throw new ParkVerificationFieldsMissingError(missing, envelope.intentHash)
  }

  return envelope === args.envelope ? args : { ...args, envelope }
}
