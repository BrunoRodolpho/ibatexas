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
  adjudicateAndAudit,
  buildAuditRecord,
  buildEnvelope,
  localizeDecision,
  type AuditSink,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import { randomUUID } from "node:crypto";

// ── P2-6 + P2-7 (audit-2026-05-24) — forgery defenses ────────────────────
//
// The gateway only dispatches customer-driven envelopes. By construction
// every envelope must carry `actor.principal = "user"` and
// `taint = "UNTRUSTED"`. Anything else is a forgery attempt (an HTTP
// route accidentally — or maliciously — minting a system-actor or
// trusted-taint envelope through the customer surface).
//
// Two layers of defense:
//
//   1. Structural (compile-time): `CustomerEnvelope<K, P>` restricts
//      `actor.principal` and `taint` to the literal values the gateway
//      will accept. TypeScript refuses any envelope that does not match.
//
//   2. Runtime (fail-closed): a caller that bypasses the type via
//      `unknown` / `as` will still be rejected at runtime by
//      `detectForgery`. The gateway returns a 400 with
//      `code: "forgery_attempt"` and emits a system-actor audit record so
//      the attempt leaves a tamper-evident trail.

/**
 * The narrowed envelope shape `runCustomerIntent` accepts. Mirrors
 * `IntentEnvelope<K, P>` from `@adjudicate/core` but pins
 * `actor.principal` to `"user"` and `taint` to `"UNTRUSTED"` — the only
 * values that make sense on a customer-driven HTTP surface.
 */
export type CustomerEnvelope<K extends string = string, P = unknown> = Omit<
  IntentEnvelope<K, P>,
  "actor" | "taint"
> & {
  readonly actor: { readonly principal: "user"; readonly sessionId: string };
  readonly taint: "UNTRUSTED";
};

/** Stable error code surfaced on a forgery rejection. */
export const FORGERY_REJECTION_CODE = "forgery_attempt" as const;

/**
 * Input shape for `buildCustomerEnvelope`. Mirrors
 * `BuildEnvelopeInput<K, P>` from `@adjudicate/core` but with
 * `actor.principal` and `taint` **structurally excluded** — those fields
 * are stamped by the gateway, never sourced from caller input. This is
 * the P2-6 / P2-7 compile-time defense: a caller literally cannot mint
 * an envelope under a different principal / taint through this helper.
 */
export interface BuildCustomerEnvelopeInput<K extends string, P> {
  readonly kind: K;
  readonly payload: P;
  readonly nonce: string;
  /** Authenticated customer id — becomes `actor.sessionId`. */
  readonly customerId: string;
  /** Optional ISO-8601 timestamp; defaults to `new Date().toISOString()`. */
  readonly createdAt?: string;
}

/**
 * Build a `CustomerEnvelope<K, P>` for the gateway. The helper sets
 * `actor.principal = "user"` and `taint = "UNTRUSTED"` itself — those
 * cannot be passed in. Use this in preference to `buildEnvelope` for
 * any envelope that will flow through `runCustomerIntent`.
 */
export function buildCustomerEnvelope<K extends string, P>(
  input: BuildCustomerEnvelopeInput<K, P>,
): CustomerEnvelope<K, P> {
  const envelope = buildEnvelope<K, P>({
    kind: input.kind,
    payload: input.payload,
    nonce: input.nonce,
    actor: { principal: "user", sessionId: input.customerId },
    taint: "UNTRUSTED",
    createdAt: input.createdAt,
  });
  return envelope as CustomerEnvelope<K, P>;
}

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
  /**
   * The envelope to adjudicate. Typed as `IntentEnvelope` for backward
   * compatibility with existing route call sites that use `buildEnvelope`
   * (which widens `actor`/`taint`). The runtime guard at the gateway
   * entry refuses anything where `actor.principal !== "user"` or
   * `taint !== "UNTRUSTED"` — P2-6/P2-7 fail-closed enforcement.
   *
   * New callers should use `buildCustomerEnvelope` (this module) — it
   * returns the narrower `CustomerEnvelope` type and the gateway sets
   * the locked fields itself, so they can never flow in from a request.
   */
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
  /** Audit sink — typically `getAuditSink()` from `@ibatexas/audit-sink`. */
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
  /**
   * Confirmation receipt — the RESUME side of a prior REQUEST_CONFIRMATION
   * cycle (e.g. the web checkout-confirm flow). When present, the gateway
   * adjudicates via the AUDITED kernel verb (`adjudicateAndAudit`) so the
   * kernel honors the receipt: a re-adjudication that returns
   * REQUEST_CONFIRMATION for the matching `intentHash` is substituted with
   * EXECUTE (+ a `confirmation:received` basis), while state/taint/auth
   * guards are still fully evaluated — a cart that crossed a REFUSE
   * threshold between request and confirm is still refused.
   *
   * On this path the audited verb emits the single AuditRecord itself, so
   * the gateway SKIPS its best-effort manual emit (no double-audit).
   * `auditSink` is required when this is set (the audited verb's `sink`).
   * The caller (the confirm route) owns receipt integrity — it consumes
   * the single-use confirmation token before passing this in.
   */
  readonly confirmationReceipt?: {
    readonly intentHash: string;
    readonly at: string;
    readonly token?: string;
  };
}

interface ForgeryFinding {
  readonly field: "actor.principal" | "taint";
  readonly value: unknown;
}

function detectForgery(envelope: IntentEnvelope): ForgeryFinding | null {
  // Reads through `unknown` so the runtime check fires even when callers
  // bypass the structural type via `as` casts.
  const actor = (envelope as { actor?: { principal?: unknown } }).actor;
  const principal = actor?.principal;
  if (principal !== "user") {
    return { field: "actor.principal", value: principal };
  }
  const taint = (envelope as { taint?: unknown }).taint;
  if (taint !== "UNTRUSTED") {
    return { field: "taint", value: taint };
  }
  return null;
}

// audit-2026-05-25 (I12): safe-truncate caps to prevent the audit
// pipeline DoS the multi-agent review found. An attacker who reaches
// runCustomerIntent with a forged envelope can supply arbitrarily
// large `envelope.kind` or `finding.value` strings; the
// emitForgeryAudit body previously interpolated them unbounded into
// the audit-record kind + detail, producing multi-MB rows that hit
// Postgres column limits, NATS broker max-message size, and pino
// console heap pressure. The very surface designed to capture forgery
// attempts became the attack vector.
const FORGERY_KIND_MAX_LENGTH = 256;
const FORGERY_DETAIL_MAX_LENGTH = 1024;

function safeTruncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}…[truncated:${input.length - maxLength}]`;
}

async function emitForgeryAudit(
  envelope: IntentEnvelope,
  finding: ForgeryFinding,
  ctx: CustomerIntentContext,
  auditSink: AuditSink | undefined,
  durationMs: number,
): Promise<void> {
  if (!auditSink) return;
  try {
    // Re-stamp the envelope as a system-actor audit subject so the
    // rejection trail itself is not minted under the customer's identity.
    // The original forged values are captured in `refusal.detail`.
    const safeOriginalKind = safeTruncate(
      String(envelope.kind),
      FORGERY_KIND_MAX_LENGTH,
    );
    const safeFindingValue = safeTruncate(
      String(finding.value),
      FORGERY_DETAIL_MAX_LENGTH,
    );
    const rejection = buildEnvelope({
      kind: safeTruncate(
        `${safeOriginalKind}.forgery_rejected`,
        FORGERY_KIND_MAX_LENGTH,
      ),
      payload: {
        route: ctx.route,
        originalKind: safeOriginalKind,
        field: finding.field,
      },
      actor: {
        principal: "system",
        sessionId: `customer-intent-gateway:${ctx.route}:${ctx.customerId}`,
      },
      taint: "SYSTEM",
      nonce: randomUUID(),
    });
    const record = buildAuditRecord({
      envelope: rejection,
      decision: {
        kind: "REFUSE",
        refusal: {
          kind: "SECURITY",
          code: FORGERY_REJECTION_CODE,
          userFacing: "Requisição inválida.",
          detail: `forged ${finding.field}=${safeFindingValue}`,
        },
        basis: [],
      },
      durationMs,
    });
    await auditSink.emit(record).catch((err: unknown) => {
      ctx.log?.warn?.(
        { route: ctx.route, customerId: ctx.customerId, err: (err as Error)?.message },
        "[customer-intent-gateway] forgery audit emit failed",
      );
    });
  } catch (err) {
    ctx.log?.warn?.(
      { route: ctx.route, customerId: ctx.customerId, err: (err as Error)?.message },
      "[customer-intent-gateway] forgery audit record build failed",
    );
  }
}

/**
 * pt-BR message for the audited-confirm fail-closed path. A 503 (temporary)
 * — not a 403 — because the customer's order may be perfectly valid; the
 * failure is on our side (kernel throw / audit sink down), so retry is the
 * right affordance.
 */
const CONFIRM_AUDIT_UNAVAILABLE_PT_BR =
  "Não consigo concluir essa ação no momento. Tente novamente em instantes.";

/**
 * Fail-closed reply for the audited confirm path. An unauditable confirm
 * is refused, never silently executed — rule #9 (always-on, fail-closed
 * execution ledger / audit). The REFUSE decision is surfaced so callers
 * that emit domain audit still see a decision passthrough.
 */
function confirmAuditFailClosedReply(
  detail: string,
): CustomerIntentReply<Record<string, unknown>> {
  return {
    statusCode: 503,
    body: { error: CONFIRM_AUDIT_UNAVAILABLE_PT_BR },
    decision: {
      kind: "REFUSE",
      refusal: {
        kind: "SECURITY",
        code: "confirm_audit_unavailable",
        userFacing: CONFIRM_AUDIT_UNAVAILABLE_PT_BR,
        detail,
      },
      basis: [],
    },
  };
}

/**
 * Best-effort audit emit for the default (non-receipt) path. An audit
 * failure NEVER blocks the mutation: a record-build throw is caught, and the
 * async emit is fire-and-forget with its own `.catch`. Extracted so
 * `runCustomerIntent` stays within its cognitive-complexity budget.
 */
function emitBestEffortAudit(
  auditSink: AuditSink | undefined,
  envelope: IntentEnvelope,
  decision: Decision,
  ctx: CustomerIntentContext,
  durationMs: number,
): void {
  if (!auditSink) return;
  try {
    const record = buildAuditRecord({ envelope, decision, durationMs });
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
  const {
    envelope,
    state,
    policy,
    executor,
    ctx,
    auditSink,
    refusalMessages,
    onDefer,
    confirmationReceipt,
  } = options;

  const startedAt = Date.now();

  // ── Runtime forgery guard — P2-6 + P2-7 ─────────────────────────────────
  const forgery = detectForgery(envelope);
  if (forgery) {
    void emitForgeryAudit(envelope, forgery, ctx, auditSink, Date.now() - startedAt);
    ctx.log?.warn?.(
      {
        route: ctx.route,
        customerId: ctx.customerId,
        field: forgery.field,
        value: forgery.value,
      },
      "[customer-intent-gateway] forgery_attempt rejected",
    );
    return {
      statusCode: 400,
      body: {
        error: "Requisição inválida.",
        code: FORGERY_REJECTION_CODE,
      },
      decision: {
        kind: "REFUSE",
        refusal: {
          kind: "SECURITY",
          code: FORGERY_REJECTION_CODE,
          userFacing: "Requisição inválida.",
          detail: `forged ${forgery.field}=${String(forgery.value)}`,
        },
        basis: [],
      },
    };
  }

  // ── Kernel adjudication (always-on) ────────────────────────────────────
  //
  // Every customer-driven mutation is adjudicated. The kernel's policy
  // bundle is authoritative — no env-var gating. Any intent kind that
  // lacks a Pack policy will default-REFUSE inside `adjudicate()`, which
  // is the correct behavior for an unconfigured surface.
  //
  // Default path: pure, deterministic `adjudicate()` + a best-effort audit
  // emit (audit failure never blocks the mutation).
  //
  // Resume path (`confirmationReceipt` present): the kernel can only honor
  // the receipt via the AUDITED verb `adjudicateAndAudit`. When the rebuilt
  // envelope re-adjudicates to REQUEST_CONFIRMATION for the matching
  // intentHash, the kernel substitutes EXECUTE while still evaluating
  // state/taint/auth guards in full. The audited verb emits the single
  // AuditRecord itself, so the manual emit below is skipped. Fail-closed:
  // a kernel throw, a sink failure, or a missing sink must never license an
  // ungated checkout — surface a 503 refusal instead.
  let decision: Decision;
  if (confirmationReceipt) {
    if (!auditSink) {
      ctx.log?.error?.(
        { route: ctx.route, customerId: ctx.customerId },
        "[customer-intent-gateway] confirmationReceipt supplied without auditSink — refusing (fail-closed)",
      );
      return confirmAuditFailClosedReply(
        "confirmationReceipt supplied without auditSink",
      ) as CustomerIntentReply<R | Record<string, unknown>>;
    }
    try {
      const result = await adjudicateAndAudit(envelope, state, policy, {
        sink: auditSink,
        confirmationReceipt,
      });
      decision = result.decision;
    } catch (err) {
      ctx.log?.warn?.(
        { route: ctx.route, customerId: ctx.customerId, err: (err as Error)?.message },
        "[customer-intent-gateway] audited confirm adjudication failed — refusing (fail-closed)",
      );
      return confirmAuditFailClosedReply(
        `adjudicateAndAudit threw: ${(err as Error)?.message}`,
      ) as CustomerIntentReply<R | Record<string, unknown>>;
    }
  } else {
    decision = adjudicate(envelope, state, policy);

    // ── Audit emit — best-effort, never blocks ──────────────────────────
    emitBestEffortAudit(auditSink, envelope, decision, ctx, Date.now() - startedAt);
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
