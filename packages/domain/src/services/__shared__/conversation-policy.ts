// conversation-policy.ts — domain-internal PolicyBundle for the
// ConversationService chokepoint.
//
// Scope (intent kinds covered):
//   - conversation.message.append   — SYSTEM. NATS subscriber-driven
//                                     archival of conversation messages
//                                     (the `conversation-archiver.ts`
//                                     subscriber).
//   - conversation.delete           — SYSTEM. Single-session purge
//                                     (admin-triggered or LGPD purge
//                                     downstream of `customer.anonymize`).
//   - conversation.delete_all       — SYSTEM. Full-archive purge (test /
//                                     ops command). High blast radius —
//                                     guarded by SYSTEM-only taint.
//
// These are NOT the `whatsapp.{message,template}.send` outbound channel
// intents from `@ibatexas/pack-whatsapp` — those govern Twilio API
// sends. This bundle governs the durable Postgres archive at
// `ibx_domain.conversations` / `ibx_domain.conversation_messages`.
//
// The pack-whatsapp policy would not be a clean fit here (it inspects
// `lastCustomerMessageAt`, recipient role, etc. — all egress concerns).
// A domain-local policy keeps the audit + provenance trail without
// pulling in unrelated semantic state.

import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  createAuthorityGraphStore,
  decisionExecute,
  resolveOwnership,
} from "@adjudicate/core"
import {
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { createSystemTaintPolicy } from "@adjudicate/primitives"
import { NonRetryableError } from "@ibatexas/types"
import { prisma } from "../../client.js"

export type ConversationIntentKind =
  | "conversation.message.append"
  | "conversation.delete"
  | "conversation.delete_all"

export interface ConversationMessageAppendPayload {
  readonly conversationId: string
  readonly role: "user" | "assistant" | "system"
  readonly content: string
}

export interface ConversationDeletePayload {
  readonly sessionId: string
}

export interface ConversationDeleteAllPayload {
  /** Confirmation token — caller (CLI/admin route) projects this. */
  readonly confirmationToken: string
}

export type ConversationPayload =
  | ConversationMessageAppendPayload
  | ConversationDeletePayload
  | ConversationDeleteAllPayload

export interface ConversationState {
  readonly ctx: {
    /** True when the operation targets a known existing conversation. */
    readonly conversationExists?: boolean
    /** Total archived conversation count (for delete_all guard). */
    readonly totalConversations?: number
  }
}

/**
 * All three kinds are SYSTEM-only — only subscribers, the LGPD purge
 * job, or ops CLI may emit them. The LLM has no business mutating the
 * durable conversation archive directly.
 */
export const conversationTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: [
    "conversation.message.append",
    "conversation.delete",
    "conversation.delete_all",
  ],
  userMinimum: "UNTRUSTED",
})

type ConversationGuard = Guard<
  ConversationIntentKind,
  ConversationPayload,
  ConversationState
>

const executeAll: ConversationGuard = (envelope) => {
  switch (envelope.kind) {
    case "conversation.message.append":
    case "conversation.delete":
    case "conversation.delete_all":
      return decisionExecute([
        basis("business", BASIS_CODES.business.RULE_SATISFIED, {
          kind: envelope.kind,
        }),
      ])
    default:
      return null
  }
}

export const conversationPolicyBundle: PolicyBundle<
  ConversationIntentKind,
  ConversationPayload,
  ConversationState
> = {
  stateGuards: [],
  authGuards: [],
  taint: conversationTaintPolicy,
  business: [executeAll],
  default: "REFUSE",
}

// ── Customer-scoping guard (Phase D · D3) ──────────────────────────────────
//
// Defense-in-depth PRIMITIVE for FUTURE customer-facing conversation reads.
// It is NOT wired into `getTranscript()` — that method's only caller today is
// the staff-authed admin route (`apps/api/src/routes/admin/conversations.ts`,
// the intentionally un-redacted support surface), so wiring a customer guard
// there would break the legitimate staff path. The guard exists so that the
// moment a customer-facing read of a transcript is added, it FAILS CLOSED by
// construction instead of leaking another customer's PII (SDD Invariant 13 —
// "Read access enforces PII-minimization + tenant-isolation; never cross
// tenant boundaries").
//
// Strict-by-default, mirroring R0b's order ownership (`assertOrderOwnership`):
// the (customer, conversation) binding is resolved through the SINGLE canonical
// ownership predicate — `resolveOwnership` from `@adjudicate/core` (SDD
// Invariant 2: "ownership is a validation predicate"; we do NOT invent a second
// ownership mechanism). A conversation whose registered owner does not match the
// caller, OR has NO owner attribution at all, REFUSES — "no owner" ≠ "any owner"
// (Invariant 2) — UNLESS the caller opens the explicit `{ allowUnowned: true }`
// staff/legacy escape hatch, the ONLY way an unowned conversation passes.

/** Authority-edge action name for the (customer, conversation) read binding.
 *  Descriptive only — `resolveOwnership`'s `bound` predicate keys on edge
 *  existence, not on the permitted-action set. */
const CONVERSATION_READ_ACTION = "conversation.read"

export interface AssertConversationOwnershipOpts {
  /**
   * Explicit staff/legacy escape hatch. When `true`, a conversation with NO
   * owner attribution (null/absent `customerId` — a guest/system/legacy row)
   * passes instead of failing closed. This is the ONLY way an unowned
   * conversation is read by a customer-scoped caller; omitting it fails CLOSED
   * (SDD Invariant 2). It NEVER relaxes a cross-customer mismatch — a
   * conversation owned by a DIFFERENT customer always REFUSES regardless.
   */
  readonly allowUnowned?: boolean
}

/**
 * Assert that a durable conversation belongs to the given customer, binding the
 * (customer, conversation) pair through the canonical `resolveOwnership`
 * predicate. Defense-in-depth primitive for future customer-facing reads.
 *
 * STRICT BY DEFAULT (SDD Invariant 2): a conversation owned by another customer
 * REFUSES; a conversation with NO owner attribution REFUSES ("no owner" ≠ "any
 * owner") unless `{ allowUnowned: true }` is passed.
 *
 * Does NOT mutate and is NOT on the staff `getTranscript()` path.
 *
 * @throws NonRetryableError if the conversation doesn't exist, belongs to
 *   another customer, or (absent `allowUnowned`) has no owner attribution.
 */
export async function assertConversationOwnership(
  conversationId: string,
  customerId: string,
  opts?: AssertConversationOwnershipOpts,
): Promise<void> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { customerId: true },
  })

  if (!row) {
    throw new NonRetryableError("Conversa não encontrada.")
  }

  const ownerCustomerId = row.customerId
  if (!ownerCustomerId) {
    // No owner attribution. Inv 2 strict default: "no owner" ≠ "any owner" →
    // fail CLOSED, unless a genuine staff/legacy path opens the escape hatch.
    if (opts?.allowUnowned) return
    throw new NonRetryableError(
      "Acesso negado: esta conversa pertence a outro cliente.",
    )
  }

  // Owner IS attributed: bind the DECLARED (caller = owner, conversation =
  // resource) pair against the conversation's real owner through the single
  // canonical ownership predicate. `bound` is false when the caller is not the
  // registered owner (cross-customer) — REFUSE.
  const store = createAuthorityGraphStore({
    edges: [
      {
        principal: ownerCustomerId,
        relationship: "owns",
        resource: conversationId,
        permits: { actions: [CONVERSATION_READ_ACTION] },
      },
    ],
  })
  const envelope = buildEnvelope({
    kind: "conversation.read",
    payload: { conversationId },
    actor: { principal: "user", sessionId: customerId },
    taint: "UNTRUSTED",
    // Nonce is immaterial — this envelope is never adjudicated; `resolveOwnership`
    // reads only `resourceRefs`. Deterministic so the guard does no RNG/IO.
    nonce: `conversation.read:${customerId}:${conversationId}`,
    resourceRefs: { owner: customerId, resource: conversationId },
  })
  const fact = resolveOwnership(store, envelope)
  if (!fact.bound) {
    throw new NonRetryableError(
      "Acesso negado: esta conversa pertence a outro cliente.",
    )
  }
}
