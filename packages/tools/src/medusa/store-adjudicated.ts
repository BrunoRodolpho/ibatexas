// medusaStoreAdjudicated — kernel-gated wrapper around STORE-scope Medusa
// HTTP egress (customer-cart mutations).
//
// ── W9 — LLM-callable cart-store medusa bypasses ────────────────────────
//
// Per `docs/adjudicate-migration/correctness-remediation/WAVE9-CART-EGRESS-
// BACKLOG.md`, 10 LLM-callable STORE-scope mutations live in
// `packages/tools/src/cart/`. They are reachable from the LLM via the
// intent-bridge (`packages/llm-provider/src/tool-registry.ts`) and mutate
// customer cart state (line items, promotions, payment collections,
// checkout completion). All 10 bypass the kernel today — no envelope,
// no policy bundle, no audit record.
//
// The sibling wrapper `medusaAdjudicated` (./adjudicated.ts) covers the
// ADMIN-scope egress (system-only). Its `createSystemTaintPolicy`
// requires `SYSTEM` taint for every kind, which is wrong for the cart-
// store surface: customer-cart mutations originate from the LLM on the
// customer's behalf and arrive as `UNTRUSTED` envelopes. This wrapper
// therefore declares its own kinds and a parallel inline policy whose
// taint posture matches the actor surface.
//
// ── Pattern (D10 wrapper-local egress-kind precedent) ───────────────────
//
// Mirrors `twilioAdjudicated` (`packages/tools/src/twilio/adjudicated.ts`)
// and `stripeAdjudicated` (`packages/tools/src/stripe/adjudicated.ts`):
//
//   - Wrapper-local intent kinds (`medusa.store.*`), not promoted to a
//     Pack. Excluded from the `KNOWN_INTENT_KINDS` registry.
//   - Build an IntentEnvelope per mutating call.
//   - Run `adjudicate(envelope, state, medusaStoreWrapperPolicyBundle)`.
//   - Emit a best-effort audit record (fail-open).
//   - Branch the kernel Decision:
//       EXECUTE / REWRITE        → dispatch to medusaStore.
//       REFUSE                   → throw MedusaStoreAdjudicateRefusedError.
//       DEFER                    → throw MedusaStoreAdjudicateDeferredError.
//       REQUEST_CONFIRMATION /
//       ESCALATE                 → throw MedusaStoreAdjudicateNeedsReviewError.
//
// ── Actor model ─────────────────────────────────────────────────────────
//
// Cart-store mutations have three legitimate actors:
//
//   - `"user"`  — customer-driven (e.g. a hypothetical future REST API
//                  where the customer directly mutates their cart).
//                  Taint: `UNTRUSTED`.
//   - `"llm"`   — LLM proposing a cart mutation on the customer's behalf
//                  (the dominant case today via the intent-bridge).
//                  Taint: `UNTRUSTED`.
//   - `"system"`— back-office or job-driven (e.g. a cart-recovery
//                  subscriber re-adding an item). Taint: `SYSTEM`.
//
// Default actor when callers don't specify: `"system"` (matches the
// existing cart-tool surface, which runs inside the API process).
//
// ── Scope ──────────────────────────────────────────────────────────────
//
// STORE-scope `/store/*` paths only. ADMIN-scope `/admin/*` paths go
// through `medusaAdjudicated`. The intent-kind set is closed: any
// operation not represented falls through to `medusa.store.unknown`
// and hits the default-REFUSE branch.
//
// ── CLAUDE.md rules ────────────────────────────────────────────────────
//
//   - #4 pt-BR: refusal text propagated from the kernel's Refusal
//     (pt-BR locale already wired by `@adjudicate/locales-pt-BR`).
//   - #9 LLM authority: this wrapper is the STORE-egress chokepoint.
//     Audit emit is best-effort; the kernel is always-on.
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
  type Taint,
  type TaintPolicy,
} from "@adjudicate/core"
import {
  adjudicate,
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { medusaStore as defaultMedusaStore } from "./client.js"

// ── Intent-kind vocabulary ──────────────────────────────────────────────

/**
 * `medusa.store.*` intent kinds — one per mutating STORE-scope HTTP
 * endpoint the wrapper governs. The taxonomy is internal to this wrapper
 * (D10 precedent: not promoted to a Pack, excluded from
 * `KNOWN_INTENT_KINDS`) and is keyed by Medusa resource × verb. The set
 * is closed: any operation not in `MEDUSA_STORE_INTENT_KINDS` falls
 * through to the wrapper's default REFUSE branch with
 * `kind: "medusa.store.unknown"` to surface the gap explicitly in audit.
 */
export type MedusaStoreIntentKind =
  | "medusa.store.cart.create"
  | "medusa.store.cart.line_item.add"
  | "medusa.store.cart.line_item.update"
  | "medusa.store.cart.line_item.remove"
  | "medusa.store.cart.email.update"
  | "medusa.store.cart.metadata.update"
  | "medusa.store.cart.promotion.add"
  | "medusa.store.cart.complete"
  | "medusa.store.payment_collection.create"
  | "medusa.store.payment_collection.payment_session.create"
  | "medusa.store.unknown"

/** Convenience for tests / introspection. */
export const MEDUSA_STORE_INTENT_KINDS: ReadonlyArray<MedusaStoreIntentKind> = [
  "medusa.store.cart.create",
  "medusa.store.cart.line_item.add",
  "medusa.store.cart.line_item.update",
  "medusa.store.cart.line_item.remove",
  "medusa.store.cart.email.update",
  "medusa.store.cart.metadata.update",
  "medusa.store.cart.promotion.add",
  "medusa.store.cart.complete",
  "medusa.store.payment_collection.create",
  "medusa.store.payment_collection.payment_session.create",
  "medusa.store.unknown",
]

// ── Inline policy bundle ────────────────────────────────────────────────

/**
 * Wrapper-local state. Empty by design — substantive cart-state policy
 * (idempotency, ownership, mealtime windows) already runs upstream at
 * the cart-tool layer (`assertCartOwnership`, `isAvailableNow`). This
 * wrapper is the HTTP-egress chokepoint: a second envelope per outbound
 * call, supersession-linked to any future upstream envelope.
 */
export interface MedusaStoreWrapperState {
  readonly egress: "medusa-store"
}

const wrapperState: MedusaStoreWrapperState = { egress: "medusa-store" }

type MedusaStoreGuard = Guard<
  MedusaStoreIntentKind,
  unknown,
  MedusaStoreWrapperState
>

/**
 * Custom taint policy. Unlike the admin-scope wrapper (which uses
 * `createSystemTaintPolicy` — every kind requires SYSTEM), STORE-scope
 * kinds tolerate `UNTRUSTED` because the customer / LLM-proposed
 * envelopes arrive untainted by construction. Any non-`medusa.store.*`
 * kind (including `medusa.store.unknown`) is treated as UNTRUSTED — the
 * business guard handles the REFUSE on unmapped kind.
 *
 * We do NOT use `createSystemTaintPolicy` here. That factory would tag
 * every known kind as system-only, which would REFUSE legitimate
 * `llm`-actor and `user`-actor envelopes before they reach the business
 * guards.
 */
const medusaStoreTaintPolicy: TaintPolicy = {
  minimumFor(_kind: string): Taint {
    return "UNTRUSTED"
  },
}

// ── Payload shapes (per intent kind) ────────────────────────────────────

/**
 * Payload schemas for each `medusa.store.*` kind. The wrapper does NOT
 * deeply validate (Medusa itself enforces strict server-side validation
 * — we want the kernel to stay cheap). It DOES enforce a minimum
 * non-empty check on ids / sane quantity bounds.
 *
 * Per the W9 inventory, the 10 cart-store sites need:
 *
 *   - cart.create                  — POST /store/carts                (body: { region_id?, ... })
 *   - cart.line_item.add           — POST /store/carts/:id/line-items  (body: { variant_id, quantity })
 *   - cart.line_item.update        — POST /store/carts/:id/line-items/:itemId (body: { quantity })
 *   - cart.line_item.remove        — DELETE /store/carts/:id/line-items/:itemId (no body)
 *   - cart.email.update            — POST /store/carts/:id            (body: { email | metadata })
 *   - cart.promotion.add           — POST /store/carts/:id/promotions  (body: { promo_codes: string[] })
 *   - cart.complete                — POST /store/carts/:id/complete    (body: {})
 *   - payment_collection.create    — POST /store/payment-collections   (body: { cart_id })
 *   - payment_collection.payment_session.create
 *                                  — POST /store/payment-collections/:id/payment-sessions
 *                                                                      (body: { provider_id })
 */
export interface MedusaStoreCartCreatePayload {
  readonly body?: Record<string, unknown>
}

export interface MedusaStoreCartLineItemAddPayload {
  readonly cartId: string
  readonly variantId: string
  readonly quantity: number
  readonly metadata?: Record<string, unknown>
}

export interface MedusaStoreCartLineItemUpdatePayload {
  readonly cartId: string
  readonly itemId: string
  readonly quantity: number
  readonly metadata?: Record<string, unknown>
}

export interface MedusaStoreCartLineItemRemovePayload {
  readonly cartId: string
  readonly itemId: string
}

export interface MedusaStoreCartEmailUpdatePayload {
  readonly cartId: string
  readonly body: Record<string, unknown>
}

export interface MedusaStoreCartPromotionAddPayload {
  readonly cartId: string
  readonly promoCodes: ReadonlyArray<string>
}

export interface MedusaStoreCartCompletePayload {
  readonly cartId: string
  readonly body?: Record<string, unknown>
}

export interface MedusaStorePaymentCollectionCreatePayload {
  readonly cartId: string
  readonly body?: Record<string, unknown>
}

export interface MedusaStorePaymentSessionCreatePayload {
  readonly paymentCollectionId: string
  readonly providerId: string
  readonly data?: Record<string, unknown>
}

/**
 * Light payload validation. Required ids must be non-empty strings;
 * quantities must be >= 1. We avoid UUID validation (Medusa's cart_*
 * and pcol_* ids are not RFC-4122 UUIDs).
 */
const refuseInvalidPayload: MedusaStoreGuard = (envelope) => {
  const kind = envelope.kind
  const p = envelope.payload as Record<string, unknown>

  const empty = (v: unknown): boolean =>
    typeof v !== "string" || v.trim().length === 0

  const refuseEmpty = (rule: string, message: string): Decision => {
    return decisionRefuse(
      refuse("BUSINESS_RULE", `medusa.store.payload.${rule}`, message),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: `medusa_store_payload_${rule}`,
          kind,
        }),
      ],
    )
  }

  switch (kind) {
    case "medusa.store.cart.line_item.add": {
      if (empty(p["cartId"])) {
        return refuseEmpty(
          "empty_cart_id",
          "Não foi possível processar a operação no carrinho porque o identificador está vazio.",
        )
      }
      if (empty(p["variantId"])) {
        return refuseEmpty(
          "empty_variant_id",
          "Não foi possível adicionar o item porque o produto não foi identificado.",
        )
      }
      const q = p["quantity"]
      if (typeof q !== "number" || !Number.isFinite(q) || q < 1) {
        return refuseEmpty(
          "invalid_quantity",
          "Não foi possível processar a operação no carrinho porque a quantidade é inválida.",
        )
      }
      return null
    }
    case "medusa.store.cart.line_item.update": {
      if (empty(p["cartId"])) {
        return refuseEmpty(
          "empty_cart_id",
          "Não foi possível processar a operação no carrinho porque o identificador está vazio.",
        )
      }
      if (empty(p["itemId"])) {
        return refuseEmpty(
          "empty_item_id",
          "Não foi possível processar a operação no carrinho porque o item não foi identificado.",
        )
      }
      const q = p["quantity"]
      if (typeof q !== "number" || !Number.isFinite(q) || q < 1) {
        return refuseEmpty(
          "invalid_quantity",
          "Não foi possível processar a operação no carrinho porque a quantidade é inválida.",
        )
      }
      return null
    }
    case "medusa.store.cart.line_item.remove": {
      if (empty(p["cartId"])) {
        return refuseEmpty(
          "empty_cart_id",
          "Não foi possível processar a operação no carrinho porque o identificador está vazio.",
        )
      }
      if (empty(p["itemId"])) {
        return refuseEmpty(
          "empty_item_id",
          "Não foi possível processar a operação no carrinho porque o item não foi identificado.",
        )
      }
      return null
    }
    case "medusa.store.cart.email.update":
    case "medusa.store.cart.metadata.update":
    case "medusa.store.cart.complete":
    case "medusa.store.payment_collection.create": {
      if (empty(p["cartId"])) {
        return refuseEmpty(
          "empty_cart_id",
          "Não foi possível processar a operação no carrinho porque o identificador está vazio.",
        )
      }
      return null
    }
    case "medusa.store.cart.promotion.add": {
      if (empty(p["cartId"])) {
        return refuseEmpty(
          "empty_cart_id",
          "Não foi possível processar a operação no carrinho porque o identificador está vazio.",
        )
      }
      const codes = p["promoCodes"]
      if (
        !Array.isArray(codes) ||
        codes.length === 0 ||
        codes.some((c) => empty(c))
      ) {
        return refuseEmpty(
          "empty_promo_codes",
          "Não foi possível aplicar o cupom porque o código está vazio.",
        )
      }
      return null
    }
    case "medusa.store.payment_collection.payment_session.create": {
      if (empty(p["paymentCollectionId"])) {
        return refuseEmpty(
          "empty_payment_collection_id",
          "Não foi possível inicializar o pagamento porque a coleção de pagamento não foi identificada.",
        )
      }
      if (empty(p["providerId"])) {
        return refuseEmpty(
          "empty_provider_id",
          "Não foi possível inicializar o pagamento porque o provedor não foi identificado.",
        )
      }
      return null
    }
    case "medusa.store.cart.create":
    case "medusa.store.unknown":
    default:
      return null
  }
}

const executeKnownKinds: MedusaStoreGuard = (envelope) => {
  if (envelope.kind === "medusa.store.unknown") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const refuseUnknownKind: MedusaStoreGuard = (envelope) => {
  if (envelope.kind !== "medusa.store.unknown") return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "medusa.store.kind.unmapped",
      "Não foi possível processar a chamada Medusa porque a operação não está mapeada.",
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "medusa_store_kind_unmapped",
      }),
    ],
  )
}

/**
 * The wrapper-local policy bundle. Used ONLY for STORE-scope egress
 * adjudication. Kept inline (no Pack export) because:
 *
 *   - The wrapper is consumed only inside `packages/tools/cart/` callers.
 *   - The substantive cart policy (ownership, availability, mealtime
 *     windows) already runs upstream at the cart-tool entry point.
 *   - Per D10 precedent, `medusa.store.*` kinds are EXCLUDED from
 *     `KNOWN_INTENT_KINDS` and are not flippable via env config.
 *   - `default: "REFUSE"` — fail-closed for any unmatched envelope.
 */
export const medusaStoreWrapperPolicyBundle: PolicyBundle<
  MedusaStoreIntentKind,
  unknown,
  MedusaStoreWrapperState
> = {
  stateGuards: [],
  authGuards: [],
  taint: medusaStoreTaintPolicy,
  business: [refuseUnknownKind, refuseInvalidPayload, executeKnownKinds],
  default: "REFUSE",
}

// ── Typed errors ────────────────────────────────────────────────────────

/**
 * Thrown when the kernel REFUSEs an outbound Medusa STORE call.
 * `userFacing` is the pt-BR refusal copy (CLAUDE.md rule #4); `code`
 * is the structured refusal code suitable for routing.
 */
export class MedusaStoreAdjudicateRefusedError extends Error {
  readonly code: string
  readonly userFacing: string
  readonly decision: Decision

  constructor(decision: Extract<Decision, { kind: "REFUSE" }>) {
    super(`Medusa store egress refused by kernel: ${decision.refusal.code}`)
    this.name = "MedusaStoreAdjudicateRefusedError"
    this.code = decision.refusal.code
    this.userFacing = decision.refusal.userFacing
    this.decision = decision
  }
}

/** Thrown when the kernel DEFERs an outbound Medusa STORE call. */
export class MedusaStoreAdjudicateDeferredError extends Error {
  readonly signal: string
  readonly timeoutMs: number
  readonly decision: Decision

  constructor(decision: Extract<Decision, { kind: "DEFER" }>) {
    super(`Medusa store egress deferred — awaiting signal: ${decision.signal}`)
    this.name = "MedusaStoreAdjudicateDeferredError"
    this.signal = decision.signal
    this.timeoutMs = decision.timeoutMs
    this.decision = decision
  }
}

/**
 * Thrown when the kernel emits REQUEST_CONFIRMATION or ESCALATE. The
 * egress must not proceed without out-of-band review.
 */
export class MedusaStoreAdjudicateNeedsReviewError extends Error {
  readonly decision: Decision

  constructor(
    decision: Extract<
      Decision,
      { kind: "REQUEST_CONFIRMATION" } | { kind: "ESCALATE" }
    >,
  ) {
    const message =
      decision.kind === "REQUEST_CONFIRMATION"
        ? `Medusa store egress needs confirmation: ${decision.prompt}`
        : `Medusa store egress escalated to ${decision.to}: ${decision.reason}`
    super(message)
    this.name = "MedusaStoreAdjudicateNeedsReviewError"
    this.decision = decision
  }
}

// ── Medusa store client injection (test seam) ───────────────────────────

/**
 * The shape of the underlying Medusa store transport. Restricted to
 * the minimal `(path, init)` signature so tests can inject a fake
 * without re-implementing the full transport.
 */
export type MedusaStoreFetchLike = (
  path: string,
  init?: RequestInit,
) => Promise<unknown>

let _injectedMedusaStore: MedusaStoreFetchLike | null = null

function getMedusaStore(): MedusaStoreFetchLike {
  return _injectedMedusaStore ?? defaultMedusaStore
}

/**
 * Test-only seam — inject a fake medusaStore transport. Production code
 * does not call this. The wrapper module exports it so unit tests can
 * verify the kernel-then-transport ordering without networking.
 */
export function __setMedusaStoreForTests(
  fetcher: MedusaStoreFetchLike | null,
): void {
  _injectedMedusaStore = fetcher
}

// ── Wrapper meta ────────────────────────────────────────────────────────

/**
 * Metadata required for every Medusa STORE egress call. Mirrors the
 * `TwilioAdjudicatedMeta` / `StripeAdjudicatedArgs` shape, extended
 * with the actor model unique to STORE-scope: customer-cart mutations
 * may arrive from `user`, `llm`, or `system` actors.
 */
export interface MedusaStoreAdjudicatedMeta {
  /**
   * Short label for the call site — surfaces in the audit record's
   * `actor.sessionId` as `"${sourceSubject}:${kind}"` (or with `:reason`
   * appended when supplied). Conventions: `"tool:add_to_cart"`,
   * `"tool:apply_coupon"`, `"tool:create_checkout"`,
   * `"subscriber:<name>"`, `"job:<name>"`.
   */
  readonly sourceSubject: string
  /**
   * Optional idempotency key. When supplied:
   *   - Drives the envelope `nonce` (replay-safe `intentHash`).
   *   - Forwarded to Medusa as the `Idempotency-Key` header.
   */
  readonly idempotencyKey?: string
  /**
   * Optional audit sink. When omitted, the wrapper skips audit emit
   * — same fail-open posture as `medusaAdjudicated` / `twilioAdjudicated`.
   */
  readonly auditSink?: AuditSink
  /** Optional logger used for audit-emit failures (best-effort). */
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
  /**
   * Short human-readable reason describing why the call is happening
   * — surfaced as the trailing segment of `actor.sessionId` for
   * operator-visible audit trails. Optional but encouraged.
   */
  readonly reason?: string
  /**
   * Actor principal. Defaults to `"system"` (the cart tools today run
   * inside the API process and call without an explicit actor). The
   * intent-bridge migration will pass `"llm"` when the LLM proposes
   * the cart mutation, or `"user"` for a future direct-customer API.
   */
  readonly actorPrincipal?: "user" | "llm" | "system"
  /**
   * Optional customer-id for audit-trail correlation. Surfaces in
   * `actor.sessionId` after the kind segment so a future Postgres
   * audit query can `WHERE actor.sessionId LIKE '%cust_…%'` to find
   * every cart mutation for a given customer.
   */
  readonly customerId?: string
  /**
   * Optional session id (e.g. WhatsApp session) — kept for symmetry
   * with the cart-tool `AgentContext.sessionId` field. When supplied,
   * appended to `actor.sessionId` after `customerId`.
   */
  readonly sessionId?: string
}

// ── Internal: build envelope + run kernel + emit audit ──────────────────

/**
 * Resolve the taint level for an envelope based on actor principal.
 *
 * - "system" → "SYSTEM"
 * - "user" / "llm" → "UNTRUSTED"
 *
 * This matches `createSystemTaintPolicy`'s default minimum for user-
 * initiated kinds (UNTRUSTED) and the canonical SYSTEM-tainted shape
 * for back-office calls.
 */
function taintForActor(
  principal: "user" | "llm" | "system",
): Taint {
  return principal === "system" ? "SYSTEM" : "UNTRUSTED"
}

/**
 * Compose the audit-record `actor.sessionId`. Format:
 *   "${sourceSubject}:${kind}[:reason][:cust=${customerId}][:sess=${sessionId}]"
 *
 * The pattern is intentionally flat — operators grep audit records by
 * the kind segment, so we keep everything append-only and prefixed.
 */
function buildSessionId(
  sourceSubject: string,
  kind: MedusaStoreIntentKind,
  meta: MedusaStoreAdjudicatedMeta,
): string {
  let s = `${sourceSubject}:${kind}`
  if (meta.reason) s += `:${meta.reason}`
  if (meta.customerId) s += `:cust=${meta.customerId}`
  if (meta.sessionId) s += `:sess=${meta.sessionId}`
  return s
}

/**
 * Run the kernel for a Medusa STORE egress and return the (possibly
 * REWRITE-rewritten) envelope. Internal — used by the per-operation
 * helpers below.
 */
async function runKernelAndAudit<P>(
  kind: MedusaStoreIntentKind,
  payload: P,
  meta: MedusaStoreAdjudicatedMeta,
): Promise<IntentEnvelope<MedusaStoreIntentKind, P>> {
  const principal = meta.actorPrincipal ?? "system"
  const nonce = meta.idempotencyKey ?? cryptoRandomNonce()
  const envelope: IntentEnvelope<MedusaStoreIntentKind, P> = buildEnvelope({
    kind,
    payload,
    actor: {
      principal,
      sessionId: buildSessionId(meta.sourceSubject, kind, meta),
    },
    taint: taintForActor(principal),
    nonce,
  })

  const startedAt = Date.now()
  const decision = adjudicate(
    envelope,
    wrapperState,
    medusaStoreWrapperPolicyBundle,
  )

  if (meta.auditSink) {
    try {
      const record = buildAuditRecord({
        envelope,
        decision,
        durationMs: Date.now() - startedAt,
      })
      void meta.auditSink.emit(record).catch((err: unknown) => {
        meta.log?.error?.(
          "[medusa-store-adjudicated] audit emit failed:",
          (err as Error).message ?? String(err),
        )
      })
    } catch (err) {
      meta.log?.error?.(
        "[medusa-store-adjudicated] audit record build failed:",
        (err as Error).message ?? String(err),
      )
    }
  }

  switch (decision.kind) {
    case "EXECUTE":
      return envelope
    case "REWRITE":
      return decision.rewritten as IntentEnvelope<MedusaStoreIntentKind, P>
    case "REFUSE":
      throw new MedusaStoreAdjudicateRefusedError(decision)
    case "DEFER":
      throw new MedusaStoreAdjudicateDeferredError(decision)
    case "REQUEST_CONFIRMATION":
    case "ESCALATE":
      throw new MedusaStoreAdjudicateNeedsReviewError(decision)
  }
}

/**
 * Build a `RequestInit` for the HTTP dispatch. Encodes the JSON body,
 * sets the method, and merges the Idempotency-Key header when one is
 * supplied.
 */
function buildHttpInit(
  method: "POST" | "DELETE" | "PATCH" | "PUT",
  body: unknown | undefined,
  idempotencyKey: string | undefined,
): RequestInit {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  if (idempotencyKey !== undefined) {
    init.headers = { "Idempotency-Key": idempotencyKey }
  }
  return init
}

// ── Public surface: nested per-operation helpers ────────────────────────

/**
 * Kernel-gated Medusa STORE-scope SDK operations. Each method:
 *
 *   1. Builds an envelope with the appropriate `medusa.store.*` intent
 *      kind and the caller-supplied actor principal (defaults to
 *      "system").
 *   2. Runs `adjudicate(...)` against the inline policy bundle.
 *   3. Emits an audit record (best-effort, fire-and-forget).
 *   4. On EXECUTE / REWRITE, dispatches to `medusaStore(path, init)`
 *      with the kernel-approved payload. On REFUSE / DEFER / needs-
 *      review, throws the corresponding typed error.
 *
 * The transport return shape (Medusa response JSON) flows through
 * unchanged so callers see identical results to the bare
 * `medusaStore(...)` call.
 *
 * @example
 *   // Adding to cart (LLM-actor):
 *   await medusaStoreAdjudicated.carts.lineItems.add(
 *     { cartId: "cart_01", variantId: "var_01", quantity: 2 },
 *     { sourceSubject: "tool:add_to_cart", actorPrincipal: "llm",
 *       customerId: ctx.customerId, sessionId: ctx.sessionId },
 *   )
 */
export const medusaStoreAdjudicated = {
  carts: {
    /**
     * Create a new customer cart. Mirrors
     * `POST /store/carts` with the supplied body.
     */
    async create(
      payload: MedusaStoreCartCreatePayload,
      meta: MedusaStoreAdjudicatedMeta,
    ): Promise<unknown> {
      const env = await runKernelAndAudit<MedusaStoreCartCreatePayload>(
        "medusa.store.cart.create",
        payload,
        meta,
      )
      const transport = getMedusaStore()
      return transport(
        "/store/carts",
        buildHttpInit("POST", env.payload.body ?? {}, meta.idempotencyKey),
      )
    },

    /**
     * Apply a metadata / email update to the cart. Mirrors
     * `POST /store/carts/:cartId` with the supplied body.
     *
     * The emitted intent kind is BRANCHED on payload shape so the audit
     * taxonomy reflects what's actually being shipped to Medusa:
     *
     *   - body has an `email` property → `medusa.store.cart.email.update`
     *     (the audit record carries customer email; downstream redactors
     *     must scrub the field — covered by the global REDACT_FIELDS
     *     rule for `email`).
     *   - otherwise → `medusa.store.cart.metadata.update` (the body is
     *     metadata-only; no PII semantics leak into the kind name).
     *
     * Before this split every cart-update emitted the `*.email.update`
     * kind regardless of payload, which leaked PII semantics into the
     * audit trail for metadata-only updates.
     */
    async update(
      payload: MedusaStoreCartEmailUpdatePayload,
      meta: MedusaStoreAdjudicatedMeta,
    ): Promise<unknown> {
      const hasEmail =
        payload.body !== null &&
        typeof payload.body === "object" &&
        Object.prototype.hasOwnProperty.call(payload.body, "email")
      const kind: MedusaStoreIntentKind = hasEmail
        ? "medusa.store.cart.email.update"
        : "medusa.store.cart.metadata.update"
      const env = await runKernelAndAudit<MedusaStoreCartEmailUpdatePayload>(
        kind,
        payload,
        meta,
      )
      const transport = getMedusaStore()
      return transport(
        `/store/carts/${env.payload.cartId}`,
        buildHttpInit("POST", env.payload.body, meta.idempotencyKey),
      )
    },

    /**
     * Complete the cart (checkout). Mirrors
     * `POST /store/carts/:cartId/complete`.
     */
    async complete(
      payload: MedusaStoreCartCompletePayload,
      meta: MedusaStoreAdjudicatedMeta,
    ): Promise<unknown> {
      const env = await runKernelAndAudit<MedusaStoreCartCompletePayload>(
        "medusa.store.cart.complete",
        payload,
        meta,
      )
      const transport = getMedusaStore()
      return transport(
        `/store/carts/${env.payload.cartId}/complete`,
        buildHttpInit("POST", env.payload.body ?? {}, meta.idempotencyKey),
      )
    },

    lineItems: {
      /**
       * Add a line item to the cart. Mirrors
       * `POST /store/carts/:cartId/line-items`.
       *
       * Medusa expects `{ variant_id, quantity }` (snake_case) in the
       * body — the wrapper translates the camelCase payload at egress
       * time so the kernel sees the natural TypeScript shape.
       */
      async add(
        payload: MedusaStoreCartLineItemAddPayload,
        meta: MedusaStoreAdjudicatedMeta,
      ): Promise<unknown> {
        const env = await runKernelAndAudit<MedusaStoreCartLineItemAddPayload>(
          "medusa.store.cart.line_item.add",
          payload,
          meta,
        )
        const transport = getMedusaStore()
        const body: Record<string, unknown> = {
          variant_id: env.payload.variantId,
          quantity: env.payload.quantity,
        }
        if (env.payload.metadata !== undefined) {
          body["metadata"] = env.payload.metadata
        }
        return transport(
          `/store/carts/${env.payload.cartId}/line-items`,
          buildHttpInit("POST", body, meta.idempotencyKey),
        )
      },

      /**
       * Update a line item quantity. Mirrors
       * `POST /store/carts/:cartId/line-items/:itemId`.
       */
      async update(
        payload: MedusaStoreCartLineItemUpdatePayload,
        meta: MedusaStoreAdjudicatedMeta,
      ): Promise<unknown> {
        const env = await runKernelAndAudit<
          MedusaStoreCartLineItemUpdatePayload
        >("medusa.store.cart.line_item.update", payload, meta)
        const transport = getMedusaStore()
        const body: Record<string, unknown> = { quantity: env.payload.quantity }
        if (env.payload.metadata !== undefined) {
          body["metadata"] = env.payload.metadata
        }
        return transport(
          `/store/carts/${env.payload.cartId}/line-items/${env.payload.itemId}`,
          buildHttpInit("POST", body, meta.idempotencyKey),
        )
      },

      /**
       * Remove a line item. Mirrors
       * `DELETE /store/carts/:cartId/line-items/:itemId`.
       */
      async remove(
        payload: MedusaStoreCartLineItemRemovePayload,
        meta: MedusaStoreAdjudicatedMeta,
      ): Promise<unknown> {
        const env = await runKernelAndAudit<
          MedusaStoreCartLineItemRemovePayload
        >("medusa.store.cart.line_item.remove", payload, meta)
        const transport = getMedusaStore()
        return transport(
          `/store/carts/${env.payload.cartId}/line-items/${env.payload.itemId}`,
          buildHttpInit("DELETE", undefined, meta.idempotencyKey),
        )
      },
    },

    promotions: {
      /**
       * Apply promotion code(s) to the cart. Mirrors
       * `POST /store/carts/:cartId/promotions`.
       *
       * The payload's `promoCodes` array is forwarded as the snake_case
       * `promo_codes` body field Medusa expects.
       */
      async add(
        payload: MedusaStoreCartPromotionAddPayload,
        meta: MedusaStoreAdjudicatedMeta,
      ): Promise<unknown> {
        const env = await runKernelAndAudit<MedusaStoreCartPromotionAddPayload>(
          "medusa.store.cart.promotion.add",
          payload,
          meta,
        )
        const transport = getMedusaStore()
        return transport(
          `/store/carts/${env.payload.cartId}/promotions`,
          buildHttpInit(
            "POST",
            { promo_codes: [...env.payload.promoCodes] },
            meta.idempotencyKey,
          ),
        )
      },
    },
  },

  paymentCollections: {
    /**
     * Create a payment collection on a cart. Mirrors
     * `POST /store/payment-collections`.
     */
    async create(
      payload: MedusaStorePaymentCollectionCreatePayload,
      meta: MedusaStoreAdjudicatedMeta,
    ): Promise<unknown> {
      const env = await runKernelAndAudit<
        MedusaStorePaymentCollectionCreatePayload
      >("medusa.store.payment_collection.create", payload, meta)
      const transport = getMedusaStore()
      const body: Record<string, unknown> = { cart_id: env.payload.cartId }
      if (env.payload.body !== undefined) {
        Object.assign(body, env.payload.body)
      }
      return transport(
        "/store/payment-collections",
        buildHttpInit("POST", body, meta.idempotencyKey),
      )
    },

    paymentSessions: {
      /**
       * Initialize a payment session on a payment collection. Mirrors
       * `POST /store/payment-collections/:id/payment-sessions`.
       */
      async create(
        payload: MedusaStorePaymentSessionCreatePayload,
        meta: MedusaStoreAdjudicatedMeta,
      ): Promise<unknown> {
        const env = await runKernelAndAudit<
          MedusaStorePaymentSessionCreatePayload
        >(
          "medusa.store.payment_collection.payment_session.create",
          payload,
          meta,
        )
        const transport = getMedusaStore()
        const body: Record<string, unknown> = {
          provider_id: env.payload.providerId,
        }
        if (env.payload.data !== undefined) {
          body["data"] = env.payload.data
        }
        return transport(
          `/store/payment-collections/${env.payload.paymentCollectionId}/payment-sessions`,
          buildHttpInit("POST", body, meta.idempotencyKey),
        )
      },
    },
  },
}

// ── Nonce helper ────────────────────────────────────────────────────────

/**
 * Per-call nonce when no idempotency key is supplied. Uses
 * `crypto.randomUUID()` when available (Node 19+, all browsers); else
 * falls back to a time-based hex. Replay safety requires the caller to
 * supply `idempotencyKey`.
 */
function cryptoRandomNonce(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `medusa-store-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
