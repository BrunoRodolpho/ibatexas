// incident-policy.ts — domain-internal PolicyBundle for the
// IncidentService chokepoint (no-reply incident journal, W1).
//
// Scope (intent kinds covered):
//   - incident.ticket.open  — SYSTEM. Opened inline at the WhatsApp send site
//                             (and, Phase 4, by the durable JetStream
//                             subscriber / web plane) when a turn was
//                             generated but NOT delivered to the customer.
//   - incident.ticket.close — SYSTEM. Closed on a successfully-delivered
//                             reply (auto-heal), a staff Resolver action, or a
//                             handoff take-over.
//
// Mirrors `conversation-policy.ts` / `loyalty-policy.ts`: a small SYSTEM-only
// bundle that lets the IncidentService route through the kernel via
// `withAdjudicate` without minting an LLM-proposable intent vocabulary. The
// LLM has no business opening or closing incident tickets — these are
// system-driven mutations (CLAUDE.md rule #9).
//
// `incident.ticket.*` are deliberately ABSENT from `KNOWN_INTENT_KINDS`
// (`@ibatexas/intent-kinds`) and are not installed as a Pack — `assertPackCoverage`
// runs over `PACK_REGISTERED_INTENT_KINDS` so a kind absent from `KNOWN` is
// never checked and cannot throw `PackCoverageError` (the `conversation.delete`
// situation; D6).

import {
  basis,
  BASIS_CODES,
  decisionExecute,
  decisionRefuse,
  refuse,
} from "@adjudicate/core"
import {
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { createSystemTaintPolicy } from "@adjudicate/primitives"
import type {
  IncidentCause,
  IncidentResolutionType,
} from "../../generated/prisma-client/client.js"

// ── Intent kinds + payloads ────────────────────────────────────────────────

export type IncidentIntentKind =
  | "incident.ticket.open"
  | "incident.ticket.close"

/**
 * The frozen no-reply cause taxonomy. A defensive kernel guard
 * (`rejectFalseIncident`) REFUSEs any `incident.ticket.open` whose `cause` is
 * outside this set, so even a buggy detector fails CLOSED at the chokepoint
 * (the inline / NATS payload is otherwise cast with no runtime validation).
 * Pinned to the `IncidentCause` enum via `satisfies`.
 */
export const FROZEN_CAUSES = [
  "empty_completion",
  "whitespace_only",
  "send_failed",
  "retry_exhausted",
  "timeout",
  // A bot-pause gate READ-ERROR (Redis unreachable) fails closed and silences the
  // customer — a genuine ghost distinct from an intentional handoff pause (W1).
  "pause_read_error",
] as const satisfies readonly IncidentCause[]

export interface IncidentOpenPayload {
  /** Soft session correlation (no FK), matching `Conversation.sessionId`. */
  readonly sessionId: string
  /** Must be one of `FROZEN_CAUSES` — the guard REFUSEs anything else. */
  readonly cause: IncidentCause
  /** Plain string channel ("whatsapp" | "web" | …) — NOT an enum (agent plane later). */
  readonly channel: string
  /** `<sourceSubject>:<eventId>` per-event create idempotency backstop (@unique). */
  readonly externalId: string
  readonly conversationId?: string | null
  readonly customerId?: string | null
  /** Channel-addressable handle to route a staff reply (P1-5). */
  readonly senderRef?: string | null
  /** false when a canned holding message was delivered (degraded, not a ghost). */
  readonly customerImpacted?: boolean
  /** LGPD hash for analytics/correlation — never raw E.164. */
  readonly phoneHash?: string | null
  /** Non-PII diagnostic. */
  readonly detail?: string | null
  readonly lastTurnId?: string | null
  readonly lastDecisionKind?: string | null
}

export interface IncidentClosePayload {
  readonly id: string
  /** `"system"` (auto-heal), `"staff:<id>"` / `"admin-key"` (Resolver), etc. */
  readonly resolvedBy: string
  /** AUTO → AUTO_RESOLVED; STAFF / HANDED_OFF → RESOLVED. */
  readonly resolutionType: IncidentResolutionType
  readonly closingTurnId?: string | null
}

export type IncidentPayload = IncidentOpenPayload | IncidentClosePayload

/**
 * Per-call state snapshot. The incident policy relies entirely on the SYSTEM
 * taint floor + the frozen-cause check; it reads no projected state (the
 * imperative service body owns the dedup / state-machine logic). Kept as an
 * optional bag so callers can pass `{}`.
 */
export interface IncidentState {
  readonly ctx?: Record<string, unknown>
}

// ── Taint policy ───────────────────────────────────────────────────────────

/**
 * Both kinds are SYSTEM-only. Tickets are minted by the send-site detector /
 * subscriber / staff routes, never by the LLM. The taint gate REFUSEs any
 * UNTRUSTED proposal before the business guards run.
 */
export const incidentTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: ["incident.ticket.open", "incident.ticket.close"],
  userMinimum: "UNTRUSTED",
})

// ── Guards ────────────────────────────────────────────────────────────────

type IncidentGuard = Guard<IncidentIntentKind, IncidentPayload, IncidentState>

/**
 * Defensive frozen-cause check. REFUSEs an `incident.ticket.open` whose `cause`
 * is outside `FROZEN_CAUSES` so even a buggy detector fails CLOSED. The kernel
 * evaluates business guards first-match in array order, so this MUST precede
 * `executeAll` in the bundle for the REFUSE to win on a bad cause.
 *
 * REVIEW-v2 (forward-protection, INERT in Phase 1): a companion
 * `decisionKind === "PAUSED_FOR_HUMAN"` disjunct is intentionally NOT
 * implemented here. `PAUSED_FOR_HUMAN` is NOT one of the 6 kernel
 * `DecisionKind`s (it is emitted only by the managed-agent plane) so it can
 * never reach this guard; WhatsApp pause is already excluded upstream by the
 * `suppressed_paused → null` short-circuit. Keep this note as Phase-4
 * forward-protection only — do NOT let it gate anything.
 */
const rejectFalseIncident: IncidentGuard = (envelope) => {
  if (envelope.kind !== "incident.ticket.open") return null
  const payload = envelope.payload as IncidentOpenPayload
  if (FROZEN_CAUSES.includes(payload.cause)) return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "incident.cause_out_of_taxonomy",
      "Não foi possível registrar o incidente: causa inválida.",
      `cause '${String(payload.cause)}' is not in the frozen incident taxonomy`,
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "frozen_cause",
        cause: String(payload.cause),
      }),
    ],
  )
}

/**
 * Single EXECUTE producer for both kinds. Tickets move no money → plain
 * EXECUTE, no threshold bands. The bundle default is REFUSE so any uncovered
 * kind is denied by construction; the SYSTEM taint floor already rejected
 * UNTRUSTED proposals before this point.
 */
const executeAll: IncidentGuard = (envelope) => {
  switch (envelope.kind) {
    case "incident.ticket.open":
    case "incident.ticket.close":
      return decisionExecute([
        basis("business", BASIS_CODES.business.RULE_SATISFIED, {
          kind: envelope.kind,
        }),
      ])
    default:
      return null
  }
}

// ── PolicyBundle ──────────────────────────────────────────────────────────

export const incidentPolicyBundle: PolicyBundle<
  IncidentIntentKind,
  IncidentPayload,
  IncidentState
> = {
  stateGuards: [],
  authGuards: [],
  taint: incidentTaintPolicy,
  business: [rejectFalseIncident, executeAll],
  default: "REFUSE",
}
