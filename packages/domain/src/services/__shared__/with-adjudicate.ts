// with-adjudicate.ts — service-method-level kernel chokepoint helper.
//
// Task 15 (M3): every command-service method that mutates Postgres goes
// through this helper. The helper:
//
//   0. FE-T04 — validates `envelope` against the canonical
//      `isStructurallyMalformed` gate (`./envelope-structural-gate.ts`)
//      BEFORE anything else. A value that is not envelope-shaped at all
//      never reaches `adjudicate()` or the executor.
//   1. Calls `adjudicate(envelope, state, policy)` from @adjudicate/core/kernel.
//   2. Emits an audit record via the configured AuditSink (best-effort —
//      failure is logged, not fatal; audit emit is not on the hot path).
//   3. Branches on the 6-valued Decision:
//        - EXECUTE   → run `executor(envelope.payload)` and return result.
//        - REWRITE   → run `executor(decision.rewritten.payload)`.
//        - REFUSE / DEFER / REQUEST_CONFIRMATION / ESCALATE
//                    → return the decision without running the executor.
//
// Service callers branch on `result.decision.kind` to decide what to surface
// to their upstream caller (HTTP route, LLM tool dispatch, subscriber).
//
// Backwards compatibility (Decision D8): existing services keep their
// bare-argument methods marked `@deprecated`. The new envelope-typed
// entry points wrap the same Prisma logic via an internal executor. As
// tasks 12-14, 16, 17 land, the callers migrate to envelope-typed
// entry points incrementally; the deprecated methods then get removed
// in a follow-up sweep.
//
// CLAUDE.md rules:
//   - #2 centavos: payloads carry centavos integers; this helper is pure
//     pass-through and never touches numbers.
//   - #4 pt-BR: refusal copy comes from the pack's `refuseDefault*`
//     helpers — this helper does not synthesize Portuguese strings.
//   - #9 LLM authority: every mutating service method that flows through
//     this helper goes through the kernel adjudicate gate by construction.

import {
  buildAuditRecord,
  buildEnvelope,
  type AuditSink,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core"
import {
  adjudicate,
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { randomUUID } from "node:crypto"
import {
  STRUCTURAL_REJECTION_CODE,
  isStructurallyMalformed,
} from "./envelope-structural-gate.js"

/**
 * Result of running a service method through the kernel chokepoint.
 *
 * `decision` always carries the kernel's verdict. `result` is populated
 * only on EXECUTE and REWRITE branches — the other branches signal the
 * mutation did NOT run.
 *
 * Callers narrow on `decision.kind`:
 *
 *   const out = await withAdjudicate(env, state, pack.policy, sink, exec)
 *   if (out.decision.kind === "EXECUTE" || out.decision.kind === "REWRITE") {
 *     return out.result // typed R
 *   }
 *   // REFUSE/DEFER/CONFIRMATION/ESCALATE — handle per the decision shape
 *   throw new ServiceRefusedError(out.decision)
 */
export interface AdjudicatedResult<R> {
  readonly decision: Decision
  readonly result?: R
}

export interface WithAdjudicateOptions {
  /** Audit sink — usually `getAuditSink()` from the consumer's wiring. */
  readonly auditSink?: AuditSink
  /** Optional Pack version for the audit record (v4+ field). */
  readonly policyVersion?: string
  /** Optional kernel-build identifier for the audit record. */
  readonly kernelIdentity?: { readonly id: string; readonly version: string }
  /** Logger for audit/emit failures. */
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
  /**
   * WS7 / BKL-074 — adopter AUTH guards injected into the adjudication at the
   * command-service seam. They are PREPENDED to the pack's own `authGuards`
   * so they run BEFORE the pack's auth guards, matching the composition order
   * of `buildIbatexasPolicyPacks` (compose-policy-packs.ts).
   *
   * The HTTP admin mutation routes inject `[staffRoleGuard]` here so a
   * mis-scoped staff role is REFUSED at the kernel even when a route
   * preHandler is wrong or missing — closing the gap where the RAW pack
   * bundles adjudicated by the command services carry no adopter auth guards.
   *
   * LOAD-BEARING INVARIANT: `staffRoleGuard` is inert (returns `null`) unless
   * `envelope.actor.sessionId` starts with `admin:`, so injecting it here is a
   * NO-OP for system-actor (jobs/subscribers), customer, LLM, and managed-agent
   * envelopes. It may therefore be injected universally.
   */
  readonly authGuards?: readonly Guard<string, unknown, unknown>[]
}

// ── FE-T04: structural boundary gate audit trail ────────────────────────────

const STRUCTURAL_REJECTION_KIND_MAX_LENGTH = 256

function safeTruncateKind(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input
  return `${input.slice(0, maxLength)}…[truncated:${input.length - maxLength}]`
}

/**
 * Records a structural-boundary rejection the same way the best-effort audit
 * block below records a real decision: fire-and-forget, failure logged not
 * thrown. The malformed value can't be passed to `buildAuditRecord` as
 * `envelope` (it may not even be object-shaped), so a synthetic SYSTEM-actor
 * rejection envelope carries the rejection instead — mirrors the sibling
 * HTTP-plane gate's `emitStructuralRejectionAudit` in
 * `apps/api/src/routes/__shared__/customer-intent-gateway.ts`, adapted to
 * this seam's options shape (no HTTP route/ctx here — this is a
 * service-method chokepoint, not an HTTP boundary).
 */
async function emitStructuralRejectionAudit(
  envelope: unknown,
  options: WithAdjudicateOptions | undefined,
  durationMs: number,
): Promise<void> {
  if (!options?.auditSink) return
  try {
    const rawKind = (envelope as { kind?: unknown } | null)?.kind
    const safeOriginalKind = safeTruncateKind(
      rawKind === undefined ? "<missing>" : String(rawKind),
      STRUCTURAL_REJECTION_KIND_MAX_LENGTH,
    )
    const rejection = buildEnvelope({
      kind: safeTruncateKind(
        `${safeOriginalKind}.structural_rejected`,
        STRUCTURAL_REJECTION_KIND_MAX_LENGTH,
      ),
      payload: { seam: "with-adjudicate", originalKind: safeOriginalKind },
      actor: {
        principal: "system",
        sessionId: "with-adjudicate:structural-rejection",
      },
      taint: "SYSTEM",
      nonce: randomUUID(),
    })
    const record = buildAuditRecord({
      envelope: rejection,
      decision: {
        kind: "REFUSE",
        refusal: {
          kind: "SECURITY",
          code: STRUCTURAL_REJECTION_CODE,
          userFacing: "Requisição inválida.",
          detail: "envelope failed the isIntentEnvelope structural check",
        },
        basis: [],
      },
      durationMs,
    })
    await options.auditSink.emit(record).catch((err: unknown) => {
      options.log?.error?.(
        "[with-adjudicate] structural-rejection audit emit failed:",
        (err as Error).message ?? String(err),
      )
    })
  } catch (err) {
    options.log?.error?.(
      "[with-adjudicate] structural-rejection audit record build failed:",
      (err as Error).message ?? String(err),
    )
  }
}

/**
 * Run a service method through the adjudicate kernel.
 *
 * Type parameters:
 *   - `K` — the intent kind discriminant (narrow string union per Pack).
 *   - `P` — the payload shape associated with `K`.
 *   - `S` — the state shape the policy reads (per Pack).
 *   - `R` — the executor's return type (what the service surfaces on success).
 *
 * Semantics:
 *
 *   - The kernel runs OUTSIDE any Prisma transaction. The `executor`
 *     owns its own `prisma.$transaction` if it needs one. This is
 *     intentional: adjudicate is pure / deterministic; the transaction
 *     is a database concern.
 *
 *   - On EXECUTE: `executor(envelope.payload)` runs, and the resolved
 *     value is returned in `result`. The audit record's `resourceVersion`
 *     field is left empty by this helper (callers wanting to populate
 *     it can emit a follow-up audit record with the post-apply version).
 *
 *   - On REWRITE: the kernel substitutes a sanitized envelope. We pass
 *     `decision.rewritten.payload` (cast to `P` — the kernel's REWRITE
 *     scope is sanitize/normalize/cap only, never business transformation,
 *     so the shape is preserved by contract per
 *     `@adjudicate/core/README.md`).
 *
 *   - On REFUSE/DEFER/REQUEST_CONFIRMATION/ESCALATE: the executor is
 *     NOT called. The decision is returned as-is for the caller to
 *     surface upstream (pt-BR refusal copy lives in the decision's
 *     `refusal.userFacing`).
 *
 * Audit emission is best-effort: a failing sink does not fail the
 * mutation. Production sinks are buffered + persisted upstream
 * (`@ibatexas/llm-provider/intent-audit-wiring.ts`), so dropping a
 * record here is a recoverable degradation, not a correctness issue.
 *
 * The helper does NOT swallow executor errors — domain errors (e.g.,
 * `ConcurrencyError`, `ProjectionNotFoundError`) propagate to the
 * caller so the service surface preserves its existing throw semantics.
 */
export async function withAdjudicate<K extends string, P, S, R>(
  envelope: IntentEnvelope<K, P>,
  state: S,
  policy: PolicyBundle<K, P, S>,
  executor: (payload: P) => Promise<R>,
  options?: WithAdjudicateOptions,
): Promise<AdjudicatedResult<R>> {
  const startedAt = Date.now()

  // ── Structural boundary gate — FE-T04 ───────────────────────────────────
  // Reuses the SAME `isStructurallyMalformed` predicate as the customer-plane
  // gateway (this is the OTHER convergence point: every ops/admin/subscriber/
  // job/LLM-tool command-service method flows through here). Runs BEFORE
  // `adjudicate()` so a value that is not envelope-shaped at all never
  // reaches the kernel or the executor. A structurally well-formed envelope
  // is completely unaffected — falls through to the existing branches below
  // byte-identically.
  if (isStructurallyMalformed(envelope)) {
    const decision: Decision = {
      kind: "REFUSE",
      refusal: {
        kind: "SECURITY",
        code: STRUCTURAL_REJECTION_CODE,
        userFacing: "Requisição inválida.",
        detail: "envelope failed the isIntentEnvelope structural check",
      },
      basis: [],
    }
    void emitStructuralRejectionAudit(envelope, options, Date.now() - startedAt)
    options?.log?.warn?.(
      "[with-adjudicate] envelope_malformed — structural gate rejected before adjudicate()",
    )
    return { decision }
  }

  // WS7 / BKL-074 — inject the adopter AUTH guards (e.g. `staffRoleGuard`)
  // AHEAD of the pack's own auth guards, so a kernel-level role backstop runs
  // on the HTTP admin command-service path (which adjudicates against RAW pack
  // bundles that lack the adopter guards). Prepend matches the composition
  // order in `buildIbatexasPolicyPacks`. Injected guards are inert unless they
  // engage — `staffRoleGuard` only fires on `admin:` sessions — so this is a
  // no-op for system / customer / LLM / managed-agent envelopes. The envelope
  // is untouched, so `intentHash` (and audit dedup) is unaffected.
  const effectivePolicy =
    options?.authGuards && options.authGuards.length > 0
      ? {
          ...policy,
          authGuards: [...options.authGuards, ...policy.authGuards],
        }
      : policy

  // Run the kernel. adjudicate() is pure + deterministic — no I/O.
  const decision = adjudicate(envelope, state, effectivePolicy)

  // Emit audit record — best effort. We build the record synchronously
  // (deterministic), but the sink's emit() is fire-and-forget by
  // construction (the helper returns before the sink's I/O completes).
  // This matches the kernel-executor pattern in
  // packages/llm-provider/src/kernel-executor.ts:225-238.
  if (options?.auditSink) {
    try {
      const record = buildAuditRecord({
        envelope,
        decision,
        durationMs: Date.now() - startedAt,
        ...(options.policyVersion === undefined
          ? {}
          : { policyVersion: options.policyVersion }),
        ...(options.kernelIdentity === undefined
          ? {}
          : { kernelIdentity: options.kernelIdentity }),
      })
      // Fire-and-forget: any error from the sink is logged, not propagated.
      void options.auditSink.emit(record).catch((err: unknown) => {
        options.log?.error?.(
          "[with-adjudicate] audit emit failed:",
          (err as Error).message ?? String(err),
        )
      })
    } catch (err) {
      options.log?.error?.(
        "[with-adjudicate] audit record build failed:",
        (err as Error).message ?? String(err),
      )
    }
  }

  // Branch on the kernel's Decision.
  switch (decision.kind) {
    case "EXECUTE": {
      const result = await executor(envelope.payload)
      return { decision, result }
    }
    case "REWRITE": {
      // REWRITE substitutes a sanitized envelope. By kernel contract the
      // payload shape is preserved (REWRITE scope is sanitize/normalize/cap
      // only). Cast at the boundary; runtime mismatches indicate a bug in
      // the pack's REWRITE guard rather than this helper.
      const rewrittenPayload = (decision.rewritten as IntentEnvelope<K, P>)
        .payload
      const result = await executor(rewrittenPayload)
      return { decision, result }
    }
    case "REFUSE":
    case "DEFER":
    case "REQUEST_CONFIRMATION":
    case "ESCALATE":
      return { decision }
  }
}

/**
 * Service-level error thrown when a command-service caller wants to
 * convert a non-EXECUTE decision into a thrown exception (the alternative
 * to branching on `result.decision.kind` explicitly).
 *
 * Carries the full decision so callers up the stack can surface the
 * pt-BR refusal copy from `decision.refusal.userFacing`.
 */
/**
 * Resolve the pt-BR user-facing message for a non-EXECUTE decision.
 * Extracted from the nested-ternary chain so each Decision kind maps to
 * its message via a flat switch — behaviour is identical to the prior
 * REFUSE → ESCALATE → REQUEST_CONFIRMATION → DEFER → default ordering.
 */
function commandRefusalMessage(decision: Decision): string {
  switch (decision.kind) {
    case "REFUSE":
      return decision.refusal.userFacing
    case "ESCALATE":
      return decision.reason
    case "REQUEST_CONFIRMATION":
      return decision.prompt
    case "DEFER":
      return `Operação aguardando sinal: ${decision.signal}`
    default:
      return "Operação não permitida."
  }
}

export class CommandRefusedError extends Error {
  public readonly decision: Decision

  constructor(decision: Decision) {
    super(commandRefusalMessage(decision))
    this.name = "CommandRefusedError"
    this.decision = decision
  }
}

/**
 * Convenience: throw `CommandRefusedError` when the decision is anything
 * other than EXECUTE/REWRITE. Mirrors the pattern in
 * `kernel-executor.ts` where the caller short-circuits on the gate
 * outcome but doesn't propagate the decision further up the stack.
 *
 * Use this in service methods whose existing throw semantics callers
 * already rely on (e.g., admin routes that turn thrown errors into
 * 400/409/422). New callers that want to handle DEFER explicitly should
 * branch on the `AdjudicatedResult.decision` instead.
 */
export function expectExecute<R>(
  outcome: AdjudicatedResult<R>,
): R {
  if (
    outcome.decision.kind === "EXECUTE" ||
    outcome.decision.kind === "REWRITE"
  ) {
    if (outcome.result === undefined) {
      // Should be unreachable — EXECUTE/REWRITE always populate result.
      throw new Error(
        "[with-adjudicate] EXECUTE/REWRITE branch returned undefined result",
      )
    }
    return outcome.result
  }
  throw new CommandRefusedError(outcome.decision)
}
