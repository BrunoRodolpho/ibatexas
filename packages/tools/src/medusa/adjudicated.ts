// medusaAdjudicated — kernel-gated wrapper around medusaStore / medusaAdmin.
//
// ── Task 17 (M3) — Medusa HTTP mutation surface ─────────────────────────
//
// Per investigation 03 §"Medusa HTTP mutation surface" + §"Gaps and
// recommendations" #5, every cart / checkout / order-edit HTTP hop that
// leaves IbateXas to Medusa today bypasses the adjudicate kernel. The
// commerce-mutation surface includes 10+ endpoints (cart create, line-item
// add/update/remove, promotion apply, cart complete, payment-collection
// create, admin order metadata, order edits, admin cancel). Each of these
// is a mutation that should produce an audit record under CLAUDE.md rule #9.
//
// This wrapper adapts the existing transport (`medusaStore`, `medusaAdmin`
// in `./client.ts`) without altering its shape:
//
//   - GET requests pass through unchanged — reads are not governed.
//   - Mutations (POST / PATCH / PUT / DELETE) build an IntentEnvelope,
//     run the adjudicate kernel, emit an audit record, and only then
//     dispatch the HTTP call. The kernel decision branches:
//       EXECUTE / REWRITE        → call medusaStore / medusaAdmin
//       REFUSE                   → throw MedusaAdjudicateRefusedError
//       DEFER                    → throw MedusaAdjudicateDeferredError
//       REQUEST_CONFIRMATION /
//       ESCALATE                 → throw MedusaAdjudicateNeedsReviewError
//
// ── Scope of this wrapper ─────────────────────────────────────────────
//
// Per the Task 17 brief (open-blockers.md §"Task 17") the wrapper is
// purpose-built for the SYSTEM-actor surface — every Medusa egress
// originates inside the IbateXas process (cart tools, subscribers,
// jobs, admin routes) with `actor.principal = "system"`. The Pack-level
// surface (cart line-item add/remove, checkout) overlaps with
// `@ibatexas/pack-orders`' intent kinds and remains adjudicated at the
// service layer (`OrderCommandService.*FromEnvelope` per Task 15).
// This wrapper governs the HTTP egress itself — a second envelope per
// outbound call, supersession-linked to the originating service-layer
// envelope when the caller passes one through.
//
// ── Parallel-surface convention (D8) ─────────────────────────────────
//
// The wrapper does NOT replace `medusaStore` / `medusaAdmin`. Callers
// migrate incrementally — see CLAUDE.md decision D8 (parallel surfaces,
// `@deprecated` on legacy bare-arg calls). New code SHOULD use
// `medusaAdjudicated`; legacy direct calls remain for the cart-tool
// refactor task that follows.
//
// CLAUDE.md rules:
//   - #4 pt-BR: refusal text is propagated from the kernel's Refusal
//     (already pt-BR via `@adjudicate/locales-pt-BR`). The error
//     class messages here are operator-facing English (not user-facing).
//   - #9 LLM authority: this wrapper is the HTTP-egress chokepoint.
//     Audit emit is best-effort (mirrors the with-adjudicate helper in
//     packages/domain/src/services/__shared__/with-adjudicate.ts).
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
import { medusaAdmin, medusaStore } from "./client.js"

// ── Intent-kind vocabulary ──────────────────────────────────────────────

/**
 * `medusa.*` intent kinds — one per mutating HTTP endpoint the wrapper
 * governs. The taxonomy is internal to this wrapper (not promoted to a
 * Pack) and is keyed by HTTP method × URL shape. The set is closed: any
 * mutation against a path not in `MEDUSA_PATH_INTENT_MAP` falls through
 * to the wrapper's default REFUSE branch with `kind: "medusa.unknown"`
 * to surface the gap explicitly in audit.
 */
export type MedusaIntentKind =
  | "medusa.cart.create"
  | "medusa.cart.update"
  | "medusa.cart.line_items.add"
  | "medusa.cart.line_items.update"
  | "medusa.cart.line_items.remove"
  | "medusa.cart.promotion.apply"
  | "medusa.cart.complete"
  | "medusa.payment_collection.create"
  | "medusa.payment_session.create"
  | "medusa.admin.order.update_metadata"
  | "medusa.admin.order.edit.create"
  | "medusa.admin.order.edit.items"
  | "medusa.admin.order.edit.confirm"
  | "medusa.admin.order.cancel"
  | "medusa.admin.product.update"
  | "medusa.unknown"

// Convenience for tests / introspection.
export const MEDUSA_INTENT_KINDS: ReadonlyArray<MedusaIntentKind> = [
  "medusa.cart.create",
  "medusa.cart.update",
  "medusa.cart.line_items.add",
  "medusa.cart.line_items.update",
  "medusa.cart.line_items.remove",
  "medusa.cart.promotion.apply",
  "medusa.cart.complete",
  "medusa.payment_collection.create",
  "medusa.payment_session.create",
  "medusa.admin.order.update_metadata",
  "medusa.admin.order.edit.create",
  "medusa.admin.order.edit.items",
  "medusa.admin.order.edit.confirm",
  "medusa.admin.order.cancel",
  "medusa.admin.product.update",
  "medusa.unknown",
]

// ── Path × method → intent-kind detection ────────────────────────────────

/**
 * Pattern definition for a single endpoint. `pattern` is a regular
 * expression anchored on `^/` so e.g. `/store/carts/cart_01/line-items`
 * does NOT collide with `/store/carts/cart_01`. Specificity ordering
 * matters: the first matching pattern wins, so longer paths must
 * appear before their shorter prefixes.
 */
interface PathRule {
  readonly method: "POST" | "PATCH" | "PUT" | "DELETE"
  readonly pattern: RegExp
  readonly kind: MedusaIntentKind
}

// Most-specific paths first — the first match wins.
const PATH_RULES: ReadonlyArray<PathRule> = [
  // Admin order edits — confirm / items / create (in that specificity order).
  {
    method: "POST",
    pattern: /^\/admin\/orders\/[^/]+\/edits\/confirm\/?$/,
    kind: "medusa.admin.order.edit.confirm",
  },
  {
    method: "POST",
    pattern: /^\/admin\/orders\/[^/]+\/edits\/items\/?$/,
    kind: "medusa.admin.order.edit.items",
  },
  {
    method: "POST",
    pattern: /^\/admin\/orders\/[^/]+\/edits\/?$/,
    kind: "medusa.admin.order.edit.create",
  },
  {
    method: "POST",
    pattern: /^\/admin\/orders\/[^/]+\/cancel\/?$/,
    kind: "medusa.admin.order.cancel",
  },
  // Admin order metadata — bare POST against /admin/orders/:id.
  {
    method: "POST",
    pattern: /^\/admin\/orders\/[^/]+\/?$/,
    kind: "medusa.admin.order.update_metadata",
  },
  // Admin product update — bare POST against /admin/products/:id.
  {
    method: "POST",
    pattern: /^\/admin\/products\/[^/]+\/?$/,
    kind: "medusa.admin.product.update",
  },
  // Store cart line-items — update / remove (item-scoped) before bare add.
  {
    method: "POST",
    pattern: /^\/store\/carts\/[^/]+\/line-items\/[^/]+\/?$/,
    kind: "medusa.cart.line_items.update",
  },
  {
    method: "DELETE",
    pattern: /^\/store\/carts\/[^/]+\/line-items\/[^/]+\/?$/,
    kind: "medusa.cart.line_items.remove",
  },
  {
    method: "POST",
    pattern: /^\/store\/carts\/[^/]+\/line-items\/?$/,
    kind: "medusa.cart.line_items.add",
  },
  // Promotion apply.
  {
    method: "POST",
    pattern: /^\/store\/carts\/[^/]+\/promotions\/?$/,
    kind: "medusa.cart.promotion.apply",
  },
  // Cart complete (checkout).
  {
    method: "POST",
    pattern: /^\/store\/carts\/[^/]+\/complete\/?$/,
    kind: "medusa.cart.complete",
  },
  // Bare cart update — must appear AFTER the more-specific cart subpaths.
  {
    method: "POST",
    pattern: /^\/store\/carts\/[^/]+\/?$/,
    kind: "medusa.cart.update",
  },
  // Cart create.
  {
    method: "POST",
    pattern: /^\/store\/carts\/?$/,
    kind: "medusa.cart.create",
  },
  // Payment session create on an existing payment collection — must
  // appear BEFORE the bare payment-collections create rule so the
  // longer path wins.
  {
    method: "POST",
    pattern: /^\/store\/payment-collections\/[^/]+\/payment-sessions\/?$/,
    kind: "medusa.payment_session.create",
  },
  // Payment collection create.
  {
    method: "POST",
    pattern: /^\/store\/payment-collections\/?$/,
    kind: "medusa.payment_collection.create",
  },
]

/** Auto-detect the intent kind for a (method, path) pair. */
export function detectMedusaIntentKind(
  method: string,
  path: string,
): MedusaIntentKind {
  // Strip any query string before matching — patterns are path-only.
  const cleanPath = path.split("?")[0] ?? path
  for (const rule of PATH_RULES) {
    if (rule.method === method && rule.pattern.test(cleanPath)) {
      return rule.kind
    }
  }
  return "medusa.unknown"
}

// ── Inline policy bundle (system-only) ──────────────────────────────────

/**
 * Wrapper-local state. Empty by design: the wrapper does not have
 * access to per-cart or per-order state (those live in Postgres /
 * Redis and are loaded at the service layer). The wrapper governs
 * the HTTP egress itself — the substantive business policy already
 * ran upstream via `@ibatexas/pack-orders` or
 * `orderProjectionPolicyBundle` at the service layer. This is a
 * second envelope per call (per Task 17 §"Rollout notes": "two
 * envelopes, two audit records, supersession-linked").
 */
export interface MedusaWrapperState {
  readonly egress: "medusa"
}

const wrapperState: MedusaWrapperState = { egress: "medusa" }

type MedusaGuard = Guard<MedusaIntentKind, unknown, MedusaWrapperState>

/**
 * The wrapper accepts only system-actor calls. All `medusa.*` kinds
 * require SYSTEM taint — `userMinimum` defaults to "TRUSTED" so any
 * UNTRUSTED LLM-proposed envelope (which the wrapper should never
 * receive) is refused at the taint phase.
 */
const medusaWrapperTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: [...MEDUSA_INTENT_KINDS],
  systemMinimum: "SYSTEM",
  userMinimum: "TRUSTED",
})

/**
 * Single business guard — EXECUTE every known `medusa.*` kind. The
 * substantive policy already ran upstream (service-layer envelopes
 * adjudicated by pack-orders / projection bundles); the wrapper's
 * job is to record the egress, not to second-guess it.
 *
 * Unknown kinds (`medusa.unknown`) fall through and hit the default
 * REFUSE — surfaces the gap in audit so we can extend the path map.
 */
const executeKnownKinds: MedusaGuard = (envelope) => {
  if (envelope.kind === "medusa.unknown") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const refuseUnknownKind: MedusaGuard = (envelope) => {
  if (envelope.kind !== "medusa.unknown") return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "medusa.path.unmapped",
      "Não foi possível processar a chamada Medusa porque a rota não está mapeada.",
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "medusa_path_unmapped",
      }),
    ],
  )
}

/**
 * The wrapper-local policy bundle. Used ONLY for the HTTP-egress
 * adjudication step. Kept inline (no Pack export) because:
 *
 *   - The wrapper is consumed only inside `packages/tools/` callers.
 *   - The substantive intents already live in `@ibatexas/pack-orders`
 *     and `orderProjectionPolicyBundle` (M3 governance).
 *   - Per Task 17 brief, scope is `packages/tools/src/medusa/` only
 *     — extending packs is out of scope.
 */
export const medusaWrapperPolicyBundle: PolicyBundle<
  MedusaIntentKind,
  unknown,
  MedusaWrapperState
> = {
  stateGuards: [],
  authGuards: [],
  taint: medusaWrapperTaintPolicy,
  business: [refuseUnknownKind, executeKnownKinds],
  default: "REFUSE",
}

// ── Typed errors ────────────────────────────────────────────────────────

/**
 * Thrown when the kernel REFUSEs an outbound Medusa call. `userFacing`
 * is the pt-BR refusal copy from the kernel's Refusal (CLAUDE.md rule
 * #4); `code` is the structured refusal code suitable for routing.
 */
export class MedusaAdjudicateRefusedError extends Error {
  readonly code: string
  readonly userFacing: string
  readonly decision: Decision

  constructor(decision: Extract<Decision, { kind: "REFUSE" }>) {
    super(`Medusa egress refused by kernel: ${decision.refusal.code}`)
    this.name = "MedusaAdjudicateRefusedError"
    this.code = decision.refusal.code
    this.userFacing = decision.refusal.userFacing
    this.decision = decision
  }
}

/**
 * Thrown when the kernel DEFERs an outbound Medusa call (the egress
 * is valid but is waiting on an external signal — e.g. PIX
 * confirmation). The caller may park the operation; LLM-driven flows
 * already wire DEFER signals through `@adjudicate/runtime`.
 */
export class MedusaAdjudicateDeferredError extends Error {
  readonly signal: string
  readonly timeoutMs: number
  readonly decision: Decision

  constructor(decision: Extract<Decision, { kind: "DEFER" }>) {
    super(`Medusa egress deferred — awaiting signal: ${decision.signal}`)
    this.name = "MedusaAdjudicateDeferredError"
    this.signal = decision.signal
    this.timeoutMs = decision.timeoutMs
    this.decision = decision
  }
}

/**
 * Thrown when the kernel emits REQUEST_CONFIRMATION or ESCALATE for
 * an outbound Medusa call. Either decision means the egress must not
 * proceed without out-of-band human review (admin force-cancel
 * confirmations, escalated refunds, etc.).
 */
export class MedusaAdjudicateNeedsReviewError extends Error {
  readonly decision: Decision

  constructor(
    decision: Extract<
      Decision,
      { kind: "REQUEST_CONFIRMATION" } | { kind: "ESCALATE" }
    >,
  ) {
    const message =
      decision.kind === "REQUEST_CONFIRMATION"
        ? `Medusa egress needs confirmation: ${decision.prompt}`
        : `Medusa egress escalated to ${decision.to}: ${decision.reason}`
    super(message)
    this.name = "MedusaAdjudicateNeedsReviewError"
    this.decision = decision
  }
}

// ── Wrapper arguments + entry point ─────────────────────────────────────

/**
 * Arguments for `medusaAdjudicated`. Generic over `P` (the JSON body
 * type) so callers get exhaustive payload typing at the call site.
 *
 * The `actor` shape is intentionally narrow: every Medusa-egress call
 * originates inside an IbateXas process (a tool, subscriber, job, or
 * admin route handler), so the principal is "system" by construction.
 * `sourceSubject` is a short label identifying the call site (e.g.
 * `"tool:add-to-cart"`, `"subscriber:cart-intelligence"`,
 * `"route:checkout"`) and shows up as the prefix of `actor.sessionId`
 * in the audit record.
 *
 * `idempotencyKey`, when supplied, doubles as the envelope `nonce` so
 * replays produce a byte-identical `intentHash` and the kernel /
 * Execution Ledger can dedupe. The same value is also forwarded to
 * Medusa as the `Idempotency-Key` header.
 */
export interface MedusaAdjudicatedArgs<P> {
  /** Which Medusa surface to call. */
  readonly scope: "store" | "admin"
  /** HTTP method. GET bypasses adjudicate; mutations are governed. */
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  /** Path beginning with `/store` or `/admin`. */
  readonly path: string
  /** Optional JSON body for the request. Omitted for GET / DELETE. */
  readonly payload?: P
  /**
   * Override the auto-detected intent kind. Defaults to the value
   * returned by `detectMedusaIntentKind(method, path)`.
   */
  readonly intentKind?: MedusaIntentKind
  /**
   * Optional idempotency key. When supplied:
   *   - Drives the envelope `nonce` (replay-safe `intentHash`).
   *   - Forwarded to Medusa as the `Idempotency-Key` header.
   */
  readonly idempotencyKey?: string
  /**
   * Short label for the call site — surfaces in the audit record's
   * `actor.sessionId` as `"${sourceSubject}:${path}"`. Conventions:
   * `"tool:<name>"`, `"subscriber:<name>"`, `"job:<name>"`,
   * `"route:<name>"`.
   */
  readonly sourceSubject: string
  /** Additional HTTP headers to merge into the upstream call. */
  readonly headers?: Record<string, string>
  /** Optional AbortSignal forwarded to the underlying fetch. */
  readonly signal?: AbortSignal
  /**
   * Optional audit sink. When omitted, the wrapper skips audit emit
   * — same fail-open posture as `withAdjudicate` in the domain
   * package. Consumers in `apps/api` SHOULD inject
   * `getAuditSink()` from `@ibatexas/llm-provider`.
   */
  readonly auditSink?: AuditSink
  /**
   * Optional logger used for audit-emit failures (best-effort).
   */
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
}

/**
 * Kernel-gated Medusa HTTP call.
 *
 * **Semantics:**
 *
 *   - GET: pass-through to `medusaStore` / `medusaAdmin`. No kernel,
 *     no envelope, no audit. Reads are not governed.
 *
 *   - Mutations (POST / PATCH / PUT / DELETE):
 *       1. Detect / accept the intent kind.
 *       2. Build a SYSTEM-tainted envelope (`actor.principal="system"`).
 *       3. Run `adjudicate(envelope, state, medusaWrapperPolicyBundle)`.
 *       4. Emit an audit record via `auditSink` (best-effort).
 *       5. Branch on the Decision:
 *            EXECUTE / REWRITE   → dispatch the HTTP call and return.
 *            REFUSE              → throw `MedusaAdjudicateRefusedError`.
 *            DEFER               → throw `MedusaAdjudicateDeferredError`.
 *            REQUEST_CONFIRMATION / ESCALATE
 *                                → throw `MedusaAdjudicateNeedsReviewError`.
 *
 * The wrapper preserves the upstream's response shape, status semantics,
 * and `MedusaRequestError` failures (admin JWT cache, publishable-key
 * cache, 400-retry and 401-retry are all preserved by virtue of calling
 * the existing `medusaStore` / `medusaAdmin` on the EXECUTE / REWRITE
 * branch).
 *
 * @example
 *   // Inside an LLM-tool handler:
 *   const result = await medusaAdjudicated<{ variantId: string }, { cart: unknown }>({
 *     scope: "store",
 *     method: "POST",
 *     path: `/store/carts/${cartId}/line-items`,
 *     payload: { variantId, quantity, allergens },
 *     idempotencyKey: `add:${cartId}:${variantId}`,
 *     sourceSubject: "tool:add-to-cart",
 *     auditSink: getAuditSink(),
 *   })
 */
export async function medusaAdjudicated<P, R = unknown>(
  args: MedusaAdjudicatedArgs<P>,
): Promise<R> {
  // GET → bypass kernel. Reads are not governed.
  if (args.method === "GET") {
    return dispatchHttp<R>(args)
  }

  const kind: MedusaIntentKind =
    args.intentKind ?? detectMedusaIntentKind(args.method, args.path)

  // Build the envelope. `nonce` uses idempotencyKey when provided so
  // replays produce a byte-identical intentHash; otherwise a fresh
  // UUID is generated.
  const nonce = args.idempotencyKey ?? cryptoRandomNonce()
  const envelope: IntentEnvelope<MedusaIntentKind, P> = buildEnvelope({
    kind,
    payload: (args.payload ?? ({} as P)) as P,
    actor: {
      principal: "system",
      sessionId: `${args.sourceSubject}:${args.path}`,
    },
    taint: "SYSTEM",
    nonce,
  })

  const startedAt = Date.now()

  // Adjudicate. The kernel is pure — no I/O.
  const decision = adjudicate(envelope, wrapperState, medusaWrapperPolicyBundle)

  // Audit emit (best-effort, fire-and-forget). Mirrors the pattern
  // in packages/domain/src/services/__shared__/with-adjudicate.ts.
  if (args.auditSink) {
    try {
      const record = buildAuditRecord({
        envelope,
        decision,
        durationMs: Date.now() - startedAt,
      })
      void args.auditSink.emit(record).catch((err: unknown) => {
        args.log?.error?.(
          "[medusa-adjudicated] audit emit failed:",
          (err as Error).message ?? String(err),
        )
      })
    } catch (err) {
      args.log?.error?.(
        "[medusa-adjudicated] audit record build failed:",
        (err as Error).message ?? String(err),
      )
    }
  }

  // Branch on Decision.
  switch (decision.kind) {
    case "EXECUTE":
      return dispatchHttp<R>(args)
    case "REWRITE": {
      // REWRITE substitutes a sanitized envelope. By kernel contract
      // the payload shape is preserved (sanitize / normalize / cap
      // only, per @adjudicate/core/README.md). We forward the
      // rewritten payload as the HTTP body.
      const rewritten = decision.rewritten as IntentEnvelope<
        MedusaIntentKind,
        P
      >
      return dispatchHttp<R>({ ...args, payload: rewritten.payload })
    }
    case "REFUSE":
      throw new MedusaAdjudicateRefusedError(decision)
    case "DEFER":
      throw new MedusaAdjudicateDeferredError(decision)
    case "REQUEST_CONFIRMATION":
    case "ESCALATE":
      throw new MedusaAdjudicateNeedsReviewError(decision)
  }
}

// ── HTTP dispatch (internal) ────────────────────────────────────────────

/**
 * Bridge to the underlying `medusaStore` / `medusaAdmin` transport.
 * Encodes the JSON body and merges the Idempotency-Key header when
 * an idempotency key is supplied. All retry / cache / 401-refresh
 * behaviour is owned by the transport — this function is a thin
 * shape adapter.
 */
async function dispatchHttp<R>(args: MedusaAdjudicatedArgs<unknown>): Promise<R> {
  const init: RequestInit = {}
  if (args.method !== "GET") {
    init.method = args.method
    if (args.payload !== undefined) {
      init.body = JSON.stringify(args.payload)
    }
  }
  const headers: Record<string, string> = { ...(args.headers ?? {}) }
  if (args.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = args.idempotencyKey
  }
  if (Object.keys(headers).length > 0) {
    init.headers = headers
  }
  if (args.signal !== undefined) {
    init.signal = args.signal
  }

  const transport = args.scope === "store" ? medusaStore : medusaAdmin
  return (await transport(args.path, init)) as R
}

// ── Nonce helper ────────────────────────────────────────────────────────

/**
 * Per-call nonce when no idempotency key is supplied. Uses
 * `crypto.randomUUID()` when available (Node 19+, all browsers), else
 * falls back to a time-based hex. The wrapper is server-side only;
 * `crypto.randomUUID()` is always available in our supported Node
 * versions.
 */
function cryptoRandomNonce(): string {
  // Resolve lazily so this module is importable in environments
  // without `globalThis.crypto` (legacy build tooling). The fallback
  // is deterministic-enough for envelope hashing — replay safety
  // requires the caller to supply idempotencyKey.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `medusa-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
