// stripeAdjudicated — kernel-gated wrapper around the Stripe SDK egress.
//
// ── W7 P5 — Stripe SDK direct calls in packages/tools/src/cart/ ─────────
//
// Six call sites under `packages/tools/src/cart/` invoke the Stripe SDK
// directly (`stripe.paymentIntents.{create,confirm,update,cancel}`),
// each one a kernel-bypass mutation against an external PSP. This
// wrapper applies the same M3/Task-17 pattern used by `medusaAdjudicated`
// (`packages/tools/src/medusa/adjudicated.ts`) to the Stripe surface:
//
//   - Build an IntentEnvelope per mutating call.
//   - Run `adjudicate(envelope, state, stripeWrapperPolicyBundle)`.
//   - Emit a best-effort audit record.
//   - Branch the kernel Decision:
//       EXECUTE / REWRITE        → dispatch to the Stripe SDK.
//       REFUSE                   → throw StripeAdjudicateRefusedError.
//       DEFER                    → throw StripeAdjudicateDeferredError.
//       REQUEST_CONFIRMATION /
//       ESCALATE                 → throw StripeAdjudicateNeedsReviewError.
//
// ── Scope ──────────────────────────────────────────────────────────────
//
// The wrapper governs the *outbound HTTP egress* to Stripe — a second
// envelope per call, supersession-linked to the originating service-
// layer envelope (`payment.create`, `payment.charge.*`) when the caller
// passes one through `sourceSubject`. Per the M3 wrapper precedent,
// this is purpose-built for SYSTEM-actor calls: every Stripe egress
// originates inside the IbateXas process (cart tools, subscribers,
// jobs) with `actor.principal = "system"`.
//
// ── Parallel-surface convention (D8) ───────────────────────────────────
//
// The wrapper does NOT replace the bare `Stripe` client. Callers
// migrate incrementally. The `getStripe()` factory in
// `packages/tools/src/cart/_stripe-helpers.ts` continues to expose the
// raw SDK for read-only retrieves; mutating calls must go through
// `stripeAdjudicated`.
//
// ── Intent-kind taxonomy (D10 precedent) ───────────────────────────────
//
// Per the comment block in `packages/llm-provider/src/intent-kinds.ts`
// W5-7 decision D10, the `medusa.*` egress kinds are EXCLUDED from
// `KNOWN_INTENT_KINDS` — they live ONLY inline in this wrapper. The
// same precedent applies here to `stripe.*`: these are internal-egress
// kinds, not user-facing intent classes, and are governed by the
// always-on kernel via the inline policy in this file. The substantive
// adjudication of "should we charge / refund this customer" already
// happens upstream in `@ibatexas/pack-payments`.
//
// ── CLAUDE.md rules ────────────────────────────────────────────────────
//
//   - #4 pt-BR: refusal text propagated from the kernel's Refusal
//     (pt-BR locale already wired by `@adjudicate/locales-pt-BR`). The
//     `Error` class messages here are operator-facing English.
//   - #9 LLM authority: this wrapper is the Stripe-egress chokepoint.
//     Audit emit is best-effort (mirrors `with-adjudicate` in the
//     domain package and `medusaAdjudicated`'s pattern).
//   - #2 centavos: this wrapper is payload-agnostic — pass-through.

import {
  basis,
  BASIS_CODES,
  buildAuditRecord,
  buildEnvelope,
  decisionExecute,
  decisionRefuse,
  refuse,
  type AuditSink,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core"
import {
  adjudicate,
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { createSystemTaintPolicy } from "@adjudicate/primitives"
import Stripe from "stripe"
import { randomBytes } from "node:crypto"

// ── Intent-kind vocabulary ──────────────────────────────────────────────

/**
 * `stripe.*` intent kinds — one per mutating Stripe SDK operation the
 * wrapper governs. The taxonomy is internal to this wrapper (not
 * promoted to a Pack) and is keyed by resource × verb. The set is
 * closed: any operation not in `STRIPE_INTENT_KINDS` falls through
 * to the wrapper's default REFUSE branch with `kind: "stripe.unknown"`
 * to surface the gap explicitly in audit.
 *
 * Read-only Stripe calls (retrieves, lists) DO NOT pass through this
 * wrapper — reads are not governed. Only mutating operations are
 * wrapped.
 */
export type StripeIntentKind =
  | "stripe.payment_intent.create"
  | "stripe.payment_intent.confirm"
  | "stripe.payment_intent.update"
  | "stripe.payment_intent.cancel"
  | "stripe.refund.create"
  | "stripe.customer.create"
  | "stripe.checkout_session.create"
  | "stripe.unknown"

/** Convenience for tests / introspection. */
export const STRIPE_INTENT_KINDS: ReadonlyArray<StripeIntentKind> = [
  "stripe.payment_intent.create",
  "stripe.payment_intent.confirm",
  "stripe.payment_intent.update",
  "stripe.payment_intent.cancel",
  "stripe.refund.create",
  "stripe.customer.create",
  "stripe.checkout_session.create",
  "stripe.unknown",
]

// ── Inline policy bundle (system-only) ──────────────────────────────────

/**
 * Wrapper-local state. Empty by design — same rationale as
 * `MedusaWrapperState`: the substantive business policy already ran
 * upstream (service-layer envelopes adjudicated by `pack-payments`).
 * This is a second envelope per call (HTTP-egress audit).
 */
export interface StripeWrapperState {
  readonly egress: "stripe"
}

const wrapperState: StripeWrapperState = { egress: "stripe" }

type StripeGuard = Guard<StripeIntentKind, unknown, StripeWrapperState>

/**
 * The wrapper accepts only system-actor calls. All `stripe.*` kinds
 * require SYSTEM taint — `userMinimum` defaults to "TRUSTED" so any
 * UNTRUSTED LLM-proposed envelope (which the wrapper should never
 * receive) is refused at the taint phase.
 */
const stripeWrapperTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: [...STRIPE_INTENT_KINDS],
  systemMinimum: "SYSTEM",
  userMinimum: "TRUSTED",
})

/**
 * Default-allowlisted kinds. Mirrors the W6-fixed P0-X2 pattern: any
 * known mutating Stripe verb EXECUTEs; unknown kinds REFUSE.
 *
 * Operators can narrow the allowlist by setting
 * `IBX_STRIPE_ALLOWED_KINDS` to a comma-separated subset. Empty / unset
 * means "all known kinds allowed". An invalid kind in the env list is
 * silently ignored (does not crash the process).
 */
function readAllowlist(): ReadonlySet<StripeIntentKind> | null {
  const raw = process.env["IBX_STRIPE_ALLOWED_KINDS"]
  if (!raw || raw.trim().length === 0) return null
  const allowed = new Set<StripeIntentKind>()
  for (const part of raw.split(",")) {
    const trimmed = part.trim()
    if ((STRIPE_INTENT_KINDS as ReadonlyArray<string>).includes(trimmed)) {
      allowed.add(trimmed as StripeIntentKind)
    }
  }
  return allowed
}

const executeAllowlistedKinds: StripeGuard = (envelope) => {
  if (envelope.kind === "stripe.unknown") return null
  const allowlist = readAllowlist()
  if (allowlist !== null && !allowlist.has(envelope.kind)) {
    return decisionRefuse(
      refuse(
        "BUSINESS_RULE",
        "stripe.kind.not_allowed",
        "Operação Stripe não permitida no momento. Tente novamente em alguns instantes ou entre em contato com o suporte.",
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "stripe_kind_disallowed",
          kind: envelope.kind,
        }),
      ],
    )
  }
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const refuseUnknownKind: StripeGuard = (envelope) => {
  if (envelope.kind !== "stripe.unknown") return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "stripe.kind.unmapped",
      "Não foi possível processar a chamada Stripe porque a operação não está mapeada.",
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "stripe_kind_unmapped",
      }),
    ],
  )
}

/**
 * The wrapper-local policy bundle. Used ONLY for the Stripe-egress
 * adjudication step. Kept inline (no Pack export) because:
 *
 *   - The wrapper is consumed only inside `packages/tools/` callers.
 *   - The substantive intents already live in `@ibatexas/pack-payments`.
 *   - Per D10 precedent, `stripe.*` kinds are EXCLUDED from
 *     `KNOWN_INTENT_KINDS` and are not flippable via env config.
 *   - `default: "REFUSE"` — fail-closed for any unmatched envelope.
 */
export const stripeWrapperPolicyBundle: PolicyBundle<
  StripeIntentKind,
  unknown,
  StripeWrapperState
> = {
  stateGuards: [],
  authGuards: [],
  taint: stripeWrapperTaintPolicy,
  business: [refuseUnknownKind, executeAllowlistedKinds],
  default: "REFUSE",
}

// ── Typed errors ────────────────────────────────────────────────────────

/**
 * Thrown when the kernel REFUSEs an outbound Stripe call. `userFacing`
 * is the pt-BR refusal copy from the kernel's Refusal (CLAUDE.md rule
 * #4); `code` is the structured refusal code suitable for routing.
 */
export class StripeAdjudicateRefusedError extends Error {
  readonly code: string
  readonly userFacing: string
  readonly decision: Decision

  constructor(decision: Extract<Decision, { kind: "REFUSE" }>) {
    super(`Stripe egress refused by kernel: ${decision.refusal.code}`)
    this.name = "StripeAdjudicateRefusedError"
    this.code = decision.refusal.code
    this.userFacing = decision.refusal.userFacing
    this.decision = decision
  }
}

/** Thrown when the kernel DEFERs an outbound Stripe call. */
export class StripeAdjudicateDeferredError extends Error {
  readonly signal: string
  readonly timeoutMs: number
  readonly decision: Decision

  constructor(decision: Extract<Decision, { kind: "DEFER" }>) {
    super(`Stripe egress deferred — awaiting signal: ${decision.signal}`)
    this.name = "StripeAdjudicateDeferredError"
    this.signal = decision.signal
    this.timeoutMs = decision.timeoutMs
    this.decision = decision
  }
}

/**
 * Thrown when the kernel emits REQUEST_CONFIRMATION or ESCALATE. The
 * egress must not proceed without out-of-band review.
 */
export class StripeAdjudicateNeedsReviewError extends Error {
  readonly decision: Decision

  constructor(
    decision: Extract<
      Decision,
      { kind: "REQUEST_CONFIRMATION" } | { kind: "ESCALATE" }
    >,
  ) {
    const message =
      decision.kind === "REQUEST_CONFIRMATION"
        ? `Stripe egress needs confirmation: ${decision.prompt}`
        : `Stripe egress escalated to ${decision.to}: ${decision.reason}`
    super(message)
    this.name = "StripeAdjudicateNeedsReviewError"
    this.decision = decision
  }
}

// ── Stripe client factory ───────────────────────────────────────────────

/**
 * Lazy Stripe client (memoized). Exposed for the typed wrapper functions
 * below; callers should not invoke this directly — go through
 * `stripeAdjudicated.*` so every mutation passes the kernel.
 *
 * The factory is hot-overrideable for tests via `__setStripeClient`.
 */
let _stripeClient: Stripe | null = null
let _injectedClient: Stripe | null = null

function getStripeClient(): Stripe {
  if (_injectedClient) return _injectedClient
  if (_stripeClient) return _stripeClient
  const key = process.env["STRIPE_SECRET_KEY"]
  if (!key) throw new Error("STRIPE_SECRET_KEY not set")
  _stripeClient = new Stripe(key)
  return _stripeClient
}

/**
 * Test-only seam — inject a fake Stripe client. Production code does
 * not call this. The wrapper module exports it so unit tests can
 * verify the kernel-then-SDK ordering without networking.
 */
export function __setStripeClientForTests(client: Stripe | null): void {
  _injectedClient = client
  _stripeClient = null
}

// ── Wrapper arguments + entry point ─────────────────────────────────────

/**
 * Arguments common to every mutating Stripe call routed through the
 * wrapper. The `actor` shape is intentionally narrow: every Stripe
 * egress originates inside an IbateXas process, so the principal is
 * "system" by construction.
 *
 * `idempotencyKey`, when supplied, doubles as the envelope `nonce` so
 * replays produce a byte-identical `intentHash` (the kernel /
 * Execution Ledger can dedupe). The same value is also forwarded to
 * Stripe as the `Stripe-Idempotency-Key` header via the SDK's
 * `RequestOptions`.
 */
export interface StripeAdjudicatedArgs<P> {
  /** The Stripe operation to run — used both as kind and as router. */
  readonly intentKind: Exclude<StripeIntentKind, "stripe.unknown">
  /** The Stripe SDK payload (resource params). */
  readonly payload: P
  /**
   * Optional idempotency key. When supplied:
   *   - Drives the envelope `nonce` (replay-safe `intentHash`).
   *   - Forwarded to Stripe as `Stripe-Idempotency-Key`.
   */
  readonly idempotencyKey?: string
  /**
   * Short label for the call site — surfaces in the audit record's
   * `actor.sessionId` as `"${sourceSubject}:${intentKind}"`. Conventions:
   * `"tool:<name>"`, `"subscriber:<name>"`, `"job:<name>"`.
   */
  readonly sourceSubject: string
  /**
   * Audit sink. REQUIRED post audit-2026-05-24 H2 (A1) — every Stripe
   * egress now emits an audit record by contract. Wrapper-call sites
   * pass `auditSink: getAuditSink()` imported from `@ibatexas/audit-sink`.
   * Fail-closed: calling before `__setAuditSinkDependencies(...)` throws
   * `AuditSinkNotInitializedError`.
   */
  readonly auditSink: AuditSink
  /** Optional logger used for audit-emit failures (best-effort). */
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
}

/**
 * Run the kernel for a Stripe egress and return the decision branch.
 *
 * Internal — used by every `stripeAdjudicated.*` helper below. Callers
 * shouldn't invoke this directly; the typed helpers below ensure the
 * payload shape matches the Stripe SDK's parameter contract.
 */
async function runKernelAndAudit<P>(
  args: StripeAdjudicatedArgs<P>,
): Promise<IntentEnvelope<StripeIntentKind, P>> {
  const kind = args.intentKind
  const nonce = args.idempotencyKey ?? cryptoRandomNonce()
  const envelope: IntentEnvelope<StripeIntentKind, P> = buildEnvelope({
    kind,
    payload: args.payload,
    actor: {
      principal: "system",
      sessionId: `${args.sourceSubject}:${kind}`,
    },
    taint: "SYSTEM",
    nonce,
  })

  const startedAt = Date.now()
  const decision = adjudicate(
    envelope,
    wrapperState,
    stripeWrapperPolicyBundle,
  )

  try {
    const record = buildAuditRecord({
      envelope,
      decision,
      durationMs: Date.now() - startedAt,
    })
    void args.auditSink.emit(record).catch((err: unknown) => {
      args.log?.error?.(
        "[stripe-adjudicated] audit emit failed:",
        (err as Error).message ?? String(err),
      )
    })
  } catch (err) {
    args.log?.error?.(
      "[stripe-adjudicated] audit record build failed:",
      (err as Error).message ?? String(err),
    )
  }

  // Branch on Decision. The dispatch (Stripe SDK call) is the caller's
  // responsibility — we return the envelope (possibly REWRITE-rewritten)
  // so the caller can invoke the correct SDK method with the sanitized
  // payload.
  switch (decision.kind) {
    case "EXECUTE":
      return envelope
    case "REWRITE": {
      // REWRITE substitutes a sanitized envelope. By kernel contract
      // payload shape is preserved (sanitize / normalize / cap only).
      return decision.rewritten as IntentEnvelope<StripeIntentKind, P>
    }
    case "REFUSE":
      throw new StripeAdjudicateRefusedError(decision)
    case "DEFER":
      throw new StripeAdjudicateDeferredError(decision)
    case "REQUEST_CONFIRMATION":
    case "ESCALATE":
      throw new StripeAdjudicateNeedsReviewError(decision)
  }
}

function buildRequestOptions(
  idempotencyKey: string | undefined,
): Stripe.RequestOptions | undefined {
  if (!idempotencyKey) return undefined
  return { idempotencyKey }
}

// ── Public surface: per-operation wrappers ───────────────────────────────

/**
 * Kernel-gated Stripe SDK operations. Each method:
 *
 *   1. Builds a SYSTEM-tainted envelope with the appropriate
 *      `stripe.*` intent kind.
 *   2. Runs `adjudicate(...)` against the inline policy bundle.
 *   3. Emits an audit record (best-effort, fire-and-forget).
 *   4. On EXECUTE / REWRITE, dispatches to the Stripe SDK with the
 *      kernel-approved payload. On REFUSE / DEFER / needs-review,
 *      throws the corresponding typed error.
 *
 * The SDK return type flows through unchanged — callers see the same
 * `Stripe.PaymentIntent`, `Stripe.Refund`, etc. shapes they would get
 * from the bare client.
 */
export const stripeAdjudicated = {
  paymentIntents: {
    async create(
      params: Stripe.PaymentIntentCreateParams,
      meta: Omit<StripeAdjudicatedArgs<unknown>, "intentKind" | "payload">,
    ): Promise<Stripe.PaymentIntent> {
      const env = await runKernelAndAudit<Stripe.PaymentIntentCreateParams>({
        intentKind: "stripe.payment_intent.create",
        payload: params,
        idempotencyKey: meta.idempotencyKey,
        sourceSubject: meta.sourceSubject,
        auditSink: meta.auditSink,
        log: meta.log,
      })
      const stripe = getStripeClient()
      return stripe.paymentIntents.create(
        env.payload,
        buildRequestOptions(meta.idempotencyKey),
      )
    },

    async confirm(
      id: string,
      params: Stripe.PaymentIntentConfirmParams,
      meta: Omit<StripeAdjudicatedArgs<unknown>, "intentKind" | "payload">,
    ): Promise<Stripe.PaymentIntent> {
      const env = await runKernelAndAudit<{
        id: string
        params: Stripe.PaymentIntentConfirmParams
      }>({
        intentKind: "stripe.payment_intent.confirm",
        payload: { id, params },
        idempotencyKey: meta.idempotencyKey,
        sourceSubject: meta.sourceSubject,
        auditSink: meta.auditSink,
        log: meta.log,
      })
      const stripe = getStripeClient()
      return stripe.paymentIntents.confirm(
        env.payload.id,
        env.payload.params,
        buildRequestOptions(meta.idempotencyKey),
      )
    },

    async update(
      id: string,
      params: Stripe.PaymentIntentUpdateParams,
      meta: Omit<StripeAdjudicatedArgs<unknown>, "intentKind" | "payload">,
    ): Promise<Stripe.PaymentIntent> {
      const env = await runKernelAndAudit<{
        id: string
        params: Stripe.PaymentIntentUpdateParams
      }>({
        intentKind: "stripe.payment_intent.update",
        payload: { id, params },
        idempotencyKey: meta.idempotencyKey,
        sourceSubject: meta.sourceSubject,
        auditSink: meta.auditSink,
        log: meta.log,
      })
      const stripe = getStripeClient()
      return stripe.paymentIntents.update(
        env.payload.id,
        env.payload.params,
        buildRequestOptions(meta.idempotencyKey),
      )
    },

    async cancel(
      id: string,
      meta: Omit<StripeAdjudicatedArgs<unknown>, "intentKind" | "payload"> & {
        readonly params?: Stripe.PaymentIntentCancelParams
      },
    ): Promise<Stripe.PaymentIntent> {
      const params = meta.params ?? {}
      const env = await runKernelAndAudit<{
        id: string
        params: Stripe.PaymentIntentCancelParams
      }>({
        intentKind: "stripe.payment_intent.cancel",
        payload: { id, params },
        idempotencyKey: meta.idempotencyKey,
        sourceSubject: meta.sourceSubject,
        auditSink: meta.auditSink,
        log: meta.log,
      })
      const stripe = getStripeClient()
      return stripe.paymentIntents.cancel(
        env.payload.id,
        env.payload.params,
        buildRequestOptions(meta.idempotencyKey),
      )
    },
  },

  refunds: {
    async create(
      params: Stripe.RefundCreateParams,
      meta: Omit<StripeAdjudicatedArgs<unknown>, "intentKind" | "payload">,
    ): Promise<Stripe.Refund> {
      const env = await runKernelAndAudit<Stripe.RefundCreateParams>({
        intentKind: "stripe.refund.create",
        payload: params,
        idempotencyKey: meta.idempotencyKey,
        sourceSubject: meta.sourceSubject,
        auditSink: meta.auditSink,
        log: meta.log,
      })
      const stripe = getStripeClient()
      return stripe.refunds.create(
        env.payload,
        buildRequestOptions(meta.idempotencyKey),
      )
    },
  },

  customers: {
    async create(
      params: Stripe.CustomerCreateParams,
      meta: Omit<StripeAdjudicatedArgs<unknown>, "intentKind" | "payload">,
    ): Promise<Stripe.Customer> {
      const env = await runKernelAndAudit<Stripe.CustomerCreateParams>({
        intentKind: "stripe.customer.create",
        payload: params,
        idempotencyKey: meta.idempotencyKey,
        sourceSubject: meta.sourceSubject,
        auditSink: meta.auditSink,
        log: meta.log,
      })
      const stripe = getStripeClient()
      return stripe.customers.create(
        env.payload,
        buildRequestOptions(meta.idempotencyKey),
      )
    },
  },

  checkout: {
    sessions: {
      async create(
        params: Stripe.Checkout.SessionCreateParams,
        meta: Omit<StripeAdjudicatedArgs<unknown>, "intentKind" | "payload">,
      ): Promise<Stripe.Checkout.Session> {
        const env = await runKernelAndAudit<Stripe.Checkout.SessionCreateParams>({
          intentKind: "stripe.checkout_session.create",
          payload: params,
          idempotencyKey: meta.idempotencyKey,
          sourceSubject: meta.sourceSubject,
          auditSink: meta.auditSink,
          log: meta.log,
        })
        const stripe = getStripeClient()
        return stripe.checkout.sessions.create(
          env.payload,
          buildRequestOptions(meta.idempotencyKey),
        )
      },
    },
  },
}

// ── Nonce helper ────────────────────────────────────────────────────────

/**
 * Per-call nonce when no idempotency key is supplied. Uses
 * `crypto.randomUUID()` when available (Node 19+, all browsers); else
 * falls back to a time-based hex. Replay safety requires the caller
 * to supply `idempotencyKey`.
 */
function cryptoRandomNonce(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `stripe-${Date.now()}-${randomBytes(4).toString("hex")}`
}
