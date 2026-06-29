// with-adjudicate.ts — service-method-level kernel chokepoint helper.
//
// Task 15 (M3): every command-service method that mutates Postgres goes
// through this helper. The helper:
//
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
  type AuditSink,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core"
import {
  adjudicate,
  type PolicyBundle,
} from "@adjudicate/core/kernel"

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

  // Run the kernel. adjudicate() is pure + deterministic — no I/O.
  const decision = adjudicate(envelope, state, policy)

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
