// customer-intent-gateway.ts — shared HTTP-route adjudicate chokepoint for
// customer-facing mutating endpoints.
//
// ── Task 14 (M3) — customer-route governance ──────────────────────────────
//
// Every customer-driven HTTP mutation (checkout, cancel, amend, address
// change, type switch, anonymize, …) flows through this gateway. The
// gateway is **additive** — existing auth (`requireAuth` JWT cookie),
// ownership checks (`verifyOwnership`), and per-customer rate limits are
// preserved upstream of the dispatch. Adjudicate layers governance on
// top, never replacing existing checks.
//
// The gateway is "thin" by design: it builds nothing intent-specific.
// Callers construct the `IntentEnvelope` themselves (so the actor /
// taint / nonce / payload shape is explicit at the call site) and pass
// an `executor` callback that runs the underlying tool function on
// EXECUTE / REWRITE. The gateway:
//
//   1. Adjudicates against the supplied policy bundle.
//   2. Emits an audit record via `getAuditSink()` (best-effort —
//      audit-failure does NOT block the mutation).
//   3. Branches on the kernel's 6-valued Decision and returns a
//      `{statusCode, body}` shape the route hands to Fastify.
//
// pt-BR refusals: REFUSE decisions return `decision.refusal.userFacing`
// directly (the Packs ship pt-BR copy by convention — see
// `pack-customer-onboarding/src/refusals.ts` and `pack-orders/src/refusals.ts`).
//
// DEFER (24h grace) parking: the `customer.anonymize` flow parks via
// `parkDeferredIntent` from `@adjudicate/runtime` keyed by
// `actor.sessionId` (= customerId). The 24h sweep is driven by the
// `defer-timeout-sweeper` job (task 03) which fires
// `intent.defer.timeout`; the `anonymize-grace-resolver` subscriber
// (this task) consumes that event and runs the actual anonymize.
//
// ── Audit redaction (task 18 dependency) ──────────────────────────────────
//
// Audit records currently carry the raw `customerId` (and other PII
// inside the payload for some intents). Task 18 will add an
// audit-redactor in front of the sink to hash/strip these fields.
// Until that lands, the AuditSink wired in `intent-audit-wiring.ts`
// receives the unredacted record — the present gateway does NOT
// duplicate that work.

import {
  buildAuditRecord,
  localizeDecision,
  type AuditSink,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import { adjudicate, isEnforced, isShadowed, type PolicyBundle } from "@adjudicate/core/kernel";

/**
 * Per-call context the gateway threads into the audit record / executor.
 * Captures both the IbateXas auth surface (customerId / userType) and
 * the gateway's own dispatch metadata (route slug for logs).
 */
export interface CustomerIntentContext {
  /** The authenticated customer id. Equals `envelope.actor.sessionId`. */
  readonly customerId: string;
  /** Route slug for logs ("cart.checkout", "order.cancel", "anonymize.delete", …). */
  readonly route: string;
  /** Optional logger for audit/emit failures. */
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void;
    readonly error?: (...args: unknown[]) => void;
    readonly info?: (...args: unknown[]) => void;
  };
}

/**
 * Pt-BR refusal-messages dictionary the gateway uses when the kernel
 * returns REFUSE. Callers pass the Pack's own dictionary (e.g.,
 * `portugueseRefusalMessages` from `@ibatexas/pack-customer-onboarding`).
 * Optional — when omitted, `decision.refusal.userFacing` is surfaced
 * verbatim (which is already pt-BR for first-party Packs).
 */
export type RefusalMessagesDict = Parameters<typeof localizeDecision>[1];

/**
 * Discriminated reply shape the gateway returns. Routes flatten this
 * onto Fastify's reply (e.g., `reply.code(out.statusCode).send(out.body)`).
 *
 * `statusCode` mapping per kernel decision:
 *   - EXECUTE / REWRITE → 200 (or 201 if executor returns it via `{ statusCode }`)
 *   - REFUSE             → 403
 *   - DEFER              → 202
 *   - REQUEST_CONFIRMATION → 202
 *   - ESCALATE           → 503
 */
export interface CustomerIntentReply<R = unknown> {
  readonly statusCode: number;
  readonly body: R;
  /** Original kernel decision — used by callers that want to emit additional
   * domain audit (NATS events, OrderEventLog rows). */
  readonly decision: Decision;
}

export interface RunCustomerIntentOptions<R> {
  /** The envelope to adjudicate. */
  readonly envelope: IntentEnvelope;
  /** State snapshot the policy bundle adjudicates against. */
  readonly state: unknown;
  /** The Pack's policy bundle (e.g., `customerOnboardingPolicyBundle`,
   * `ordersPolicyBundle`, `orderProjectionPolicyBundle`). */
  readonly policy: PolicyBundle<string, unknown, unknown>;
  /**
   * On EXECUTE or REWRITE this function runs the underlying tool / service
   * call. The kernel-rewritten payload (if any) is passed instead of the
   * original — by kernel contract REWRITE preserves payload shape, so
   * callers cast at the boundary. The return value is surfaced in the
   * reply body as-is.
   */
  readonly executor: (payload: unknown) => Promise<R>;
  /** Per-call context (customerId, route slug, optional log). */
  readonly ctx: CustomerIntentContext;
  /** Audit sink — typically `getAuditSink()` from `@ibatexas/llm-provider`. */
  readonly auditSink?: AuditSink;
  /** Pt-BR refusal dictionary for REFUSE localization. */
  readonly refusalMessages?: RefusalMessagesDict;
  /**
   * DEFER handler — runs when the kernel parks the envelope. The route
   * decides what to surface (typically a 202 with a pt-BR message). The
   * gateway forwards the decision so the handler can read
   * `decision.signal` / `decision.timeoutMs`.
   *
   * If omitted, the gateway returns a generic 202 with the kernel's
   * signal name + a default pt-BR message.
   */
  readonly onDefer?: (
    decision: Extract<Decision, { kind: "DEFER" }>,
  ) => Promise<CustomerIntentReply<unknown>>;
}

/**
 * Dispatch a customer-driven envelope through the adjudicate kernel.
 *
 * Decision branching:
 *
 *   - EXECUTE  → runs `executor(envelope.payload)`; returns `{ statusCode: 200, body }`.
 *   - REWRITE  → runs `executor(rewritten.payload)`; returns `{ statusCode: 200, body }`.
 *   - REFUSE   → returns `{ statusCode: 403, body: { error } }` with localized pt-BR copy.
 *   - DEFER    → calls `onDefer` if provided; otherwise returns a default
 *                202 with `{ status: "deferred", signal, message }`.
 *   - REQUEST_CONFIRMATION → returns `{ statusCode: 202, body: { confirmationRequired, prompt } }`.
 *   - ESCALATE → returns `{ statusCode: 503, body: { error: "Operação requer atendimento humano." } }`.
 *
 * The executor's errors are NOT caught — domain errors propagate so
 * existing 4xx / 5xx semantics on the route side are preserved.
 */
export async function runCustomerIntent<R>(
  options: RunCustomerIntentOptions<R>,
): Promise<CustomerIntentReply<R | Record<string, unknown>>> {
  const { envelope, state, policy, executor, ctx, auditSink, refusalMessages, onDefer } =
    options;

  const startedAt = Date.now();
  const intentKind = envelope.kind;

  // ── Always-enforce list ────────────────────────────────────────────────
  //
  // Some intent kinds carry kernel-side governance that IS the safety
  // model — not a future enforce target. The LGPD anonymize flow's
  // DEFER + 24h grace lives in the pack's policy; bypassing it would
  // mean a customer who completed initiate-deletion + DELETE skips the
  // cancel window entirely. We force-adjudicate these kinds regardless
  // of `IBX_KERNEL_ENFORCE`.
  //
  // ── NEW-P0-X2 (W1 correctness remediation) ─────────────────────────────
  //
  // The previous "pure-legacy = synthetic EXECUTE" branch silently let
  // every customer-mutation kind through unless it was in shadow/enforce
  // env or in ALWAYS_ENFORCE. The documented invariant (default-deny)
  // was inverted: any kind not yet listed defaulted to EXECUTE.
  //
  // The fix: ALL customer kinds outside shadow+enforce now default to
  // REFUSE with a generic pt-BR userFacing. ALWAYS_ENFORCE additionally
  // covers the safety-critical customer.* kinds (profile.update,
  // preferences.update, pix.details.save) so they ARE adjudicated even
  // if ops forgets to add them to IBX_KERNEL_ENFORCE.
  //
  // Address kinds are deliberately NOT in ALWAYS_ENFORCE per the audit:
  // pack policy for customer.address.* doesn't exist yet, so forcing
  // adjudication would default-REFUSE every legit call. Routes touching
  // address-* kinds should land them on the shadow list when policies
  // arrive.
  const ALWAYS_ENFORCE: ReadonlySet<string> = new Set([
    "customer.anonymize",
    "customer.anonymize.cancel",
    "customer.profile.update",
    "customer.preferences.update",
    "customer.pix.details.save",
  ]);

  // ── Enforce / shadow / pure-legacy switch ──────────────────────────────
  //
  // Mirrors `kernel-executor.ts:200` (the LLM-side adjudicate gate) so
  // the customer route surface is governed the same way: an intent kind
  // not yet on the enforce list runs through the executor unconditionally,
  // preserving the green baseline. Shadow mode runs the kernel for
  // divergence telemetry but lets the legacy result win.
  //
  // Pure-legacy now means REFUSE — the documented default. Ops must
  // explicitly add a kind to shadow (to telemetry-test it) or enforce
  // (to bind the kernel decision) before customer mutations of that
  // kind are reachable through the gateway.
  let decision: Decision;
  let isPureLegacy = false;

  if (ALWAYS_ENFORCE.has(intentKind) || isEnforced(intentKind, process.env)) {
    decision = adjudicate(envelope, state, policy);
  } else if (isShadowed(intentKind, process.env)) {
    // Shadow mode — adjudicate runs for divergence telemetry but the
    // legacy path (synthetic always-EXECUTE) wins for proceed-or-not.
    // Shadow MUST be an opt-in for telemetry; the kind is known to
    // exist and ops accepts the legacy EXECUTE during the soak.
    try {
      adjudicate(envelope, state, policy);
    } catch {
      // Pack threw — skip telemetry, fall through to legacy EXECUTE.
    }
    decision = { kind: "EXECUTE", basis: [] };
  } else {
    // Pure-legacy now default-REFUSE (NEW-P0-X2). The kind is unknown
    // to the kernel rollout config and not in ALWAYS_ENFORCE — surface
    // a pt-BR refusal so the gateway never silently executes
    // unadjudicated mutations.
    decision = {
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "customer_intent.kernel_not_configured",
        userFacing:
          "Operação indisponível no momento. Tente novamente em instantes ou entre em contato com o suporte.",
      },
      basis: [],
    };
    // Audit emit IS preserved for the REFUSE so on-call sees the
    // default-deny in telemetry (vs. the previous silent default-EXECUTE).
    isPureLegacy = false;
  }

  // ── Audit emit — best-effort, never blocks ─────────────────────────────
  if (auditSink && !isPureLegacy) {
    try {
      const record = buildAuditRecord({
        envelope,
        decision,
        durationMs: Date.now() - startedAt,
      });
      void auditSink.emit(record).catch((err: unknown) => {
        ctx.log?.warn?.(
          { route: ctx.route, customerId: ctx.customerId, err: (err as Error)?.message },
          "[customer-intent-gateway] audit emit failed",
        );
      });
    } catch (err) {
      ctx.log?.warn?.(
        { route: ctx.route, customerId: ctx.customerId, err: (err as Error)?.message },
        "[customer-intent-gateway] audit record build failed",
      );
    }
  }

  // ── Branch on decision kind ───────────────────────────────────────────
  switch (decision.kind) {
    case "EXECUTE": {
      const result = await executor(envelope.payload);
      return { statusCode: 200, body: result, decision };
    }
    case "REWRITE": {
      // By kernel contract REWRITE preserves the payload shape (sanitize /
      // normalize / cap only). Routes that need to see the rewrite read
      // `decision.rewritten` via the returned `decision` field.
      const rewrittenPayload = decision.rewritten.payload as unknown;
      const result = await executor(rewrittenPayload);
      return { statusCode: 200, body: result, decision };
    }
    case "REFUSE": {
      const localized = refusalMessages
        ? localizeDecision(decision, refusalMessages)
        : decision;
      const userFacing =
        localized.kind === "REFUSE"
          ? localized.refusal.userFacing
          : "Operação não permitida.";
      return {
        statusCode: 403,
        body: { error: userFacing, code: decision.refusal.code },
        decision,
      };
    }
    case "DEFER": {
      if (onDefer) {
        const customReply = await onDefer(decision);
        // Wrap the caller's reply to preserve the decision passthrough.
        return { ...customReply, decision } as CustomerIntentReply<unknown> as CustomerIntentReply<
          R | Record<string, unknown>
        >;
      }
      return {
        statusCode: 202,
        body: {
          status: "deferred",
          signal: decision.signal,
          message: "Operação aguardando confirmação.",
        },
        decision,
      };
    }
    case "REQUEST_CONFIRMATION": {
      return {
        statusCode: 202,
        body: {
          confirmationRequired: true,
          prompt: decision.prompt,
        },
        decision,
      };
    }
    case "ESCALATE": {
      return {
        statusCode: 503,
        body: {
          error: "Operação requer atendimento humano.",
          reason: decision.reason,
        },
        decision,
      };
    }
  }
}
