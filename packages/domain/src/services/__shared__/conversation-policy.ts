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
  decisionExecute,
} from "@adjudicate/core"
import {
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { createSystemTaintPolicy } from "@adjudicate/primitives"

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
