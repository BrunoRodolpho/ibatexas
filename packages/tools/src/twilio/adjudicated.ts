// twilioAdjudicated — kernel-gated wrapper around the Twilio SDK egress.
//
// ── Audit-2026-05-23 — 2× direct `messages.create` in apps/api/src/whatsapp/client.ts ─
//
// The coverage audit (`docs/adjudicate-migration/audit-2026-05-23/
// coverage-baseline.md`) identified two direct Twilio `messages.create`
// calls at `apps/api/src/whatsapp/client.ts:132,204` that bypass the
// kernel. The bypass-detection allowlist entry `ALLOWED_TWILIO_MESSAGES`
// pointed at a non-existent `sender.ts` — the surface was both
// gate-blind AND unwrapped.
//
// This wrapper applies the same M3/Task-17 + W7-P5 pattern used by
// `medusaAdjudicated` / `stripeAdjudicated`:
//
//   - Build an IntentEnvelope per mutating call.
//   - Run `adjudicate(envelope, state, twilioWrapperPolicyBundle)`.
//   - Emit a best-effort audit record.
//   - Branch the kernel Decision:
//       EXECUTE / REWRITE        → dispatch to the Twilio SDK.
//       REFUSE                   → throw TwilioAdjudicateRefusedError.
//       DEFER                    → throw TwilioAdjudicateDeferredError.
//       REQUEST_CONFIRMATION /
//       ESCALATE                 → throw TwilioAdjudicateNeedsReviewError.
//
// ── Scope ──────────────────────────────────────────────────────────────
//
// The wrapper governs the *outbound HTTP egress* to Twilio's REST API —
// specifically the `messages.create` surface (free-form WhatsApp / SMS
// sends with optional media). Read-only Twilio surfaces (message
// retrieves, account fetches) DO NOT pass through this wrapper.
//
// Twilio Verify (OTP — `verifications.create`, `verificationChecks.create`)
// is a separate surface and is NOT wrapped here. It is filtered out by
// the bypass-detection allowlist (it's a different SDK resource).
//
// ── Parallel-surface convention (D8) ───────────────────────────────────
//
// The wrapper does NOT replace the bare `twilio` client; callers migrate
// incrementally. The two call sites in
// `apps/api/src/whatsapp/client.ts` are migrated in the same change-set
// that introduces this wrapper.
//
// ── Intent-kind taxonomy (D10 precedent) ───────────────────────────────
//
// Per the W7-P5 precedent for `stripe.*`, the wrapper's intent kind
// `twilio.message.send` is a wrapper-local egress kind, NOT a Pack
// intent. The pack-whatsapp's `whatsapp.message.send` is the *channel-
// level* business intent (24h-window, rate-limit, sanitization); this
// wrapper's `twilio.message.send` is the *transport-level* HTTP-egress
// audit. The two are complementary: a future enhancement may
// supersession-link them when the Pack adjudicates upstream of the
// wrapper.
//
// ── CLAUDE.md rules ────────────────────────────────────────────────────
//
//   - #4 pt-BR: refusal text propagated from the kernel's Refusal
//     (pt-BR locale already wired by `@adjudicate/locales-pt-BR`).
//   - #9 LLM authority: this wrapper is the Twilio-egress chokepoint.
//     Audit emit is best-effort.
//   - #5 Twilio auth flow: this wrapper governs `messages.create` only;
//     the OTP flow (`verifications.create`) remains untouched.

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
import { randomBytes } from "node:crypto"
import twilio from "twilio"

// ── Intent-kind vocabulary ──────────────────────────────────────────────

/**
 * `twilio.*` intent kinds — one per mutating Twilio SDK operation the
 * wrapper governs. The taxonomy is internal to this wrapper (not promoted
 * to a Pack) and is keyed by resource × verb. The set is closed: any
 * operation not in `TWILIO_INTENT_KINDS` falls through to the wrapper's
 * default REFUSE branch with `kind: "twilio.unknown"` to surface the gap
 * explicitly in audit.
 *
 * Read-only Twilio calls (retrieves, lists) DO NOT pass through this
 * wrapper. Twilio Verify (OTP) is a different surface and is allow-listed
 * in the bypass-detection gate; it is not represented here.
 */
export type TwilioIntentKind = "twilio.message.send" | "twilio.unknown"

/** Convenience for tests / introspection. */
export const TWILIO_INTENT_KINDS: ReadonlyArray<TwilioIntentKind> = [
  "twilio.message.send",
  "twilio.unknown",
]

// ── Inline policy bundle (system-only) ──────────────────────────────────

/**
 * Wrapper-local state. Empty by design — same rationale as
 * `MedusaWrapperState` / `StripeWrapperState`: the substantive business
 * policy already runs upstream (`@ibatexas/pack-whatsapp` adjudicates
 * the 24h customer-initiated window, handover rate-limit, sanitization).
 * This is a second envelope per call (HTTP-egress audit).
 */
export interface TwilioWrapperState {
  readonly egress: "twilio"
}

const wrapperState: TwilioWrapperState = { egress: "twilio" }

type TwilioGuard = Guard<TwilioIntentKind, unknown, TwilioWrapperState>

/**
 * The wrapper accepts only system-actor calls. All `twilio.*` kinds
 * require SYSTEM taint — `userMinimum` defaults to "TRUSTED" so any
 * UNTRUSTED LLM-proposed envelope (which the wrapper should never
 * receive) is refused at the taint phase.
 */
const twilioWrapperTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: ["twilio.message.send", "twilio.unknown"],
  systemMinimum: "SYSTEM",
  userMinimum: "TRUSTED",
})

/**
 * Payload shape passed to `twilio.message.send`. Mirrors the Twilio SDK
 * `MessageListInstanceCreateOptions` reduced to the fields the IbateXas
 * client actually uses today (`from`, `to`, `body`, optional `mediaUrl`).
 *
 * `to` and `from` are E.164 phone numbers, possibly prefixed with
 * `whatsapp:` (Twilio's WhatsApp channel marker). The wrapper does NOT
 * itself validate the phone format — that lives in pack-whatsapp's
 * upstream guards; here we only sanity-check non-empty.
 */
export interface TwilioMessageSendPayload {
  readonly from: string
  readonly to: string
  readonly body?: string
  readonly mediaUrl?: ReadonlyArray<string>
}

/**
 * Light validation of `twilio.message.send` payloads:
 *   - `from` and `to` must be non-empty strings.
 *   - At least one of `body` / `mediaUrl` must be present and non-empty
 *     (Twilio rejects empty messages anyway; surfacing the refuse here
 *     keeps the audit trail explicit).
 *
 * Heavy validation (E.164 format, body length caps, pt-BR copy checks)
 * already runs upstream in pack-whatsapp — this guard is the egress
 * chokepoint's last-line sanity check.
 */
const refuseInvalidMessagePayload: TwilioGuard = (envelope) => {
  if (envelope.kind !== "twilio.message.send") return null
  const payload = envelope.payload as TwilioMessageSendPayload
  if (
    typeof payload.from !== "string" ||
    payload.from.trim().length === 0 ||
    typeof payload.to !== "string" ||
    payload.to.trim().length === 0
  ) {
    return decisionRefuse(
      refuse(
        "BUSINESS_RULE",
        "twilio.message.invalid_phone",
        "Não foi possível enviar a mensagem porque o remetente ou destinatário está vazio.",
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "twilio_message_invalid_phone",
        }),
      ],
    )
  }
  const hasBody = typeof payload.body === "string" && payload.body.length > 0
  const hasMedia = Array.isArray(payload.mediaUrl) && payload.mediaUrl.length > 0
  if (!hasBody && !hasMedia) {
    return decisionRefuse(
      refuse(
        "BUSINESS_RULE",
        "twilio.message.empty",
        "Não foi possível enviar a mensagem porque o conteúdo está vazio.",
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "twilio_message_empty",
        }),
      ],
    )
  }
  return null
}

const executeKnownKinds: TwilioGuard = (envelope) => {
  if (envelope.kind === "twilio.unknown") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

const refuseUnknownKind: TwilioGuard = (envelope) => {
  if (envelope.kind !== "twilio.unknown") return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "twilio.kind.unmapped",
      "Não foi possível processar a chamada Twilio porque a operação não está mapeada.",
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "twilio_kind_unmapped",
      }),
    ],
  )
}

/**
 * The wrapper-local policy bundle. Used ONLY for the Twilio-egress
 * adjudication step. Kept inline (no Pack export) because:
 *
 *   - The wrapper is consumed only inside IbateXas internals.
 *   - The substantive intents already live in `@ibatexas/pack-whatsapp`.
 *   - Per D10 precedent, `twilio.*` kinds are EXCLUDED from the
 *     `KNOWN_INTENT_KINDS` registry; they are not flippable via env config.
 *   - `default: "REFUSE"` — fail-closed for any unmatched envelope.
 */
export const twilioWrapperPolicyBundle: PolicyBundle<
  TwilioIntentKind,
  unknown,
  TwilioWrapperState
> = {
  stateGuards: [],
  authGuards: [],
  taint: twilioWrapperTaintPolicy,
  business: [refuseUnknownKind, refuseInvalidMessagePayload, executeKnownKinds],
  default: "REFUSE",
}

// ── Typed errors ────────────────────────────────────────────────────────

/**
 * Thrown when the kernel REFUSEs an outbound Twilio call. `userFacing`
 * is the pt-BR refusal copy from the kernel's Refusal (CLAUDE.md rule
 * #4); `code` is the structured refusal code suitable for routing.
 */
export class TwilioAdjudicateRefusedError extends Error {
  readonly code: string
  readonly userFacing: string
  readonly decision: Decision

  constructor(decision: Extract<Decision, { kind: "REFUSE" }>) {
    super(`Twilio egress refused by kernel: ${decision.refusal.code}`)
    this.name = "TwilioAdjudicateRefusedError"
    this.code = decision.refusal.code
    this.userFacing = decision.refusal.userFacing
    this.decision = decision
  }
}

/** Thrown when the kernel DEFERs an outbound Twilio call. */
export class TwilioAdjudicateDeferredError extends Error {
  readonly signal: string
  readonly timeoutMs: number
  readonly decision: Decision

  constructor(decision: Extract<Decision, { kind: "DEFER" }>) {
    super(`Twilio egress deferred — awaiting signal: ${decision.signal}`)
    this.name = "TwilioAdjudicateDeferredError"
    this.signal = decision.signal
    this.timeoutMs = decision.timeoutMs
    this.decision = decision
  }
}

/**
 * Thrown when the kernel emits REQUEST_CONFIRMATION or ESCALATE. The
 * egress must not proceed without out-of-band review.
 */
export class TwilioAdjudicateNeedsReviewError extends Error {
  readonly decision: Decision

  constructor(
    decision: Extract<
      Decision,
      { kind: "REQUEST_CONFIRMATION" } | { kind: "ESCALATE" }
    >,
  ) {
    const message =
      decision.kind === "REQUEST_CONFIRMATION"
        ? `Twilio egress needs confirmation: ${decision.prompt}`
        : `Twilio egress escalated to ${decision.to}: ${decision.reason}`
    super(message)
    this.name = "TwilioAdjudicateNeedsReviewError"
    this.decision = decision
  }
}

// ── Twilio client factory ───────────────────────────────────────────────

/**
 * Twilio SDK client surface the wrapper needs. Restricted to the
 * `messages.create` shape so tests can inject a fake without
 * implementing the entire Twilio SDK.
 */
export interface TwilioClientLike {
  readonly messages: {
    create(input: {
      from: string
      to: string
      body?: string
      mediaUrl?: string[]
    }): Promise<unknown>
  }
}

let _twilioClient: TwilioClientLike | null = null
let _injectedClient: TwilioClientLike | null = null

function getTwilioClient(): TwilioClientLike {
  if (_injectedClient) return _injectedClient
  if (_twilioClient) return _twilioClient
  const sid = process.env["TWILIO_ACCOUNT_SID"]
  const auth = process.env["TWILIO_AUTH_TOKEN"]
  if (!sid || !auth) {
    throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set")
  }
  // 10s timeout mirrors apps/api/src/whatsapp/client.ts — prevents
  // indefinite hangs during Twilio API outages.
  _twilioClient = twilio(sid, auth, { timeout: 10_000 }) as unknown as TwilioClientLike
  return _twilioClient
}

/**
 * Test-only seam — inject a fake Twilio client. Production code does
 * not call this. The wrapper module exports it so unit tests can
 * verify the kernel-then-SDK ordering without networking.
 */
export function __setTwilioClientForTests(client: TwilioClientLike | null): void {
  _injectedClient = client
  _twilioClient = null
}

// ── Wrapper arguments + entry point ─────────────────────────────────────

/**
 * Metadata required for every Twilio egress call. Mirrors the
 * `StripeAdjudicatedArgs` shape: `sourceSubject` identifies the call
 * site, `idempotencyKey` doubles as the envelope `nonce`, and
 * `auditSink` is optional (best-effort emit).
 */
export interface TwilioAdjudicatedMeta {
  /**
   * Short label for the call site — surfaces in the audit record's
   * `actor.sessionId` as `"${sourceSubject}:twilio.message.send"`.
   * Conventions: `"whatsapp:sendText"`, `"whatsapp:sendMedia"`,
   * `"subscriber:<name>"`, `"job:<name>"`.
   */
  readonly sourceSubject: string
  /**
   * Optional idempotency key. When supplied, drives the envelope
   * `nonce` (replay-safe `intentHash`). Twilio does NOT expose an
   * SDK-level Idempotency-Key header on `messages.create` — but the
   * nonce still pins the kernel/Execution-Ledger dedup contract.
   */
  readonly idempotencyKey?: string
  /**
   * Audit sink. REQUIRED post audit-2026-05-24 H2 (A1) — every Twilio
   * egress now emits an audit record by contract. Wrapper-call sites
   * pass `auditSink: getAuditSink()` imported from `@ibatexas/audit-sink`
   * (the leaf package that owns the boot-time DI). Fail-closed: calling
   * before `__setAuditSinkDependencies(...)` throws
   * `AuditSinkNotInitializedError`.
   */
  readonly auditSink: AuditSink
  /** Optional logger used for audit-emit failures (best-effort). */
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
  /**
   * Short human-readable reason describing why the call is happening
   * — surfaced in the envelope's `actor.sessionId` suffix for
   * operator-visible audit trails. Optional but encouraged.
   */
  readonly reason?: string
  /**
   * Actor principal override — currently only "system" is allowed
   * (the wrapper's taint policy rejects anything else). Exposed for
   * forward-compat / explicit-intent documentation at call sites.
   */
  readonly actorPrincipal?: "system"
}

/**
 * Run the kernel for a Twilio egress and return the (possibly REWRITE-
 * rewritten) envelope.
 *
 * Internal — used by `twilioAdjudicated.messages.create`.
 */
async function runKernelAndAudit(
  payload: TwilioMessageSendPayload,
  meta: TwilioAdjudicatedMeta,
): Promise<IntentEnvelope<TwilioIntentKind, TwilioMessageSendPayload>> {
  const kind: TwilioIntentKind = "twilio.message.send"
  const nonce = meta.idempotencyKey ?? cryptoRandomNonce()
  const sessionSuffix = meta.reason ? `${kind}:${meta.reason}` : kind
  const envelope: IntentEnvelope<TwilioIntentKind, TwilioMessageSendPayload> =
    buildEnvelope({
      kind,
      payload,
      actor: {
        principal: "system",
        sessionId: `${meta.sourceSubject}:${sessionSuffix}`,
      },
      taint: "SYSTEM",
      nonce,
    })

  const startedAt = Date.now()
  const decision = adjudicate(
    envelope,
    wrapperState,
    twilioWrapperPolicyBundle,
  )

  try {
    const record = buildAuditRecord({
      envelope,
      decision,
      durationMs: Date.now() - startedAt,
    })
    void meta.auditSink.emit(record).catch((err: unknown) => {
      meta.log?.error?.(
        "[twilio-adjudicated] audit emit failed:",
        (err as Error).message ?? String(err),
      )
    })
  } catch (err) {
    meta.log?.error?.(
      "[twilio-adjudicated] audit record build failed:",
      (err as Error).message ?? String(err),
    )
  }

  switch (decision.kind) {
    case "EXECUTE":
      return envelope
    case "REWRITE":
      // REWRITE substitutes a sanitized envelope. By kernel contract
      // payload shape is preserved (sanitize / normalize / cap only).
      return decision.rewritten as IntentEnvelope<
        TwilioIntentKind,
        TwilioMessageSendPayload
      >
    case "REFUSE":
      throw new TwilioAdjudicateRefusedError(decision)
    case "DEFER":
      throw new TwilioAdjudicateDeferredError(decision)
    case "REQUEST_CONFIRMATION":
    case "ESCALATE":
      throw new TwilioAdjudicateNeedsReviewError(decision)
  }
}

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Kernel-gated Twilio SDK operations. Each method:
 *
 *   1. Builds a SYSTEM-tainted envelope with the appropriate
 *      `twilio.*` intent kind.
 *   2. Runs `adjudicate(...)` against the inline policy bundle.
 *   3. Emits an audit record (best-effort, fire-and-forget).
 *   4. On EXECUTE / REWRITE, dispatches to the Twilio SDK with the
 *      kernel-approved payload. On REFUSE / DEFER / needs-review,
 *      throws the corresponding typed error.
 *
 * The SDK return shape flows through unchanged.
 */
export const twilioAdjudicated = {
  messages: {
    /**
     * Kernel-gated `twilio.messages.create`. Mirrors the Twilio SDK
     * signature and return type so the call-site migration is a
     * 1-for-1 swap with an extra meta arg.
     *
     * @example
     *   await twilioAdjudicated.messages.create(
     *     { from, to, body },
     *     { sourceSubject: "whatsapp:sendText", reason: "send-text" },
     *   )
     */
    async create(
      input: TwilioMessageSendPayload,
      meta: TwilioAdjudicatedMeta,
    ): Promise<unknown> {
      const env = await runKernelAndAudit(input, meta)
      const client = getTwilioClient()
      // The Twilio SDK accepts a mutable plain object; clone the
      // (possibly-rewritten) payload to avoid surprising the SDK with
      // a frozen-from-kernel value. The clone is shallow — `mediaUrl`
      // is an array of strings which the SDK shallow-copies anyway.
      return client.messages.create({
        from: env.payload.from,
        to: env.payload.to,
        ...(env.payload.body === undefined ? {} : { body: env.payload.body }),
        ...(env.payload.mediaUrl === undefined
          ? {}
          : { mediaUrl: [...env.payload.mediaUrl] }),
      })
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
  return `twilio-${Date.now()}-${randomBytes(4).toString("hex")}`
}
