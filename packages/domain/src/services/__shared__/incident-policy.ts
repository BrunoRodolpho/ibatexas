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
  IncidentKind,
  IncidentResolutionType,
  IncidentSeverity,
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
  // BKL-211 — a security boundary REFUSED an LLM-proposed intent on a customer
  // turn (SCN-106 injection / SCN-109 cross-customer PII probe). NOT a delivery
  // failure: the customer WAS answered, with a refusal. See SECURITY_PROBE_KIND
  // for why it rides a distinct journal `kind`.
  "security_probe",
] as const satisfies readonly IncidentCause[]

/**
 * BKL-211 — the attack-review journal discriminator.
 *
 * `conversation_incidents.kind` has carried a single member (`no_reply`) since the
 * table was created; it exists so a second journal can share the table. A
 * security-probe incident is emphatically NOT a no-reply incident:
 *
 *   no_reply       — the customer got SILENCE. Self-heals: the next delivered
 *                    reply proves recovery, so it AUTO_RESOLVES.
 *   security_probe — the customer got a correct REFUSAL, delivered. Nothing
 *                    "recovers"; a human must review the attempt. It must
 *                    therefore NEVER auto-close on a delivered reply — the very
 *                    reply that would fire the close IS the refusal itself.
 *
 * The per-session open-incident partial unique index is scoped by
 * `(session_id, kind)` so one session can hold one open row of EACH journal.
 * Without that, the never-auto-closing security row would occupy the session's
 * single slot and silently suppress every later genuine no-reply open — and with
 * it the staff ping for a real customer-facing outage.
 */
export const SECURITY_PROBE_KIND = "security_probe" as const satisfies IncidentKind

/** The no-reply journal — the default `kind` for every W1 delivery-failure open. */
export const NO_REPLY_KIND = "no_reply" as const satisfies IncidentKind

/**
 * CANONICAL pt-BR labels for the frozen no-reply cause taxonomy — the single
 * server-side source of truth. Any server consumer that renders a cause label
 * (the incident-notification staff ping, digests, future planes) MUST read
 * from here rather than keep a private copy.
 *
 * Typed as an EXHAUSTIVE `Record<IncidentCause, string>`: adding a new member
 * to the `IncidentCause` enum fails the BUILD until it is labeled here, so a
 * cause can never silently fall back to its raw enum key (the `pause_read_error`
 * gap this map closes). Mirrors the `satisfies` pin on `FROZEN_CAUSES`.
 *
 * NOTE ON BOUNDARY: the admin UI keeps its own shorter badge register in
 * `@ibatexas/ui` (`INCIDENT_CAUSE_LABELS`) because that package is bundled into
 * the browser and cannot depend on `@ibatexas/domain` (Prisma). These maps are
 * two intentionally-distinct presentation registers over the SAME taxonomy;
 * each is exhaustive over `IncidentCause`.
 */
export const INCIDENT_CAUSE_LABELS_PT: Record<IncidentCause, string> = {
  empty_completion: "resposta vazia do modelo",
  whitespace_only: "resposta em branco do modelo",
  send_failed: "falha no envio",
  retry_exhausted: "tentativas esgotadas",
  timeout: "tempo de resposta esgotado",
  pause_read_error: "falha ao ler pausa (Redis) — erro interno",
  security_probe: "tentativa de acesso indevido (bloqueada)",
}

/** CANONICAL pt-BR severity labels — exhaustive over `IncidentSeverity`. */
export const INCIDENT_SEVERITY_LABELS_PT: Record<IncidentSeverity, string> = {
  low: "baixa",
  medium: "média",
  high: "alta",
}

export interface IncidentOpenPayload {
  /** Soft session correlation (no FK), matching `Conversation.sessionId`. */
  readonly sessionId: string
  /** Must be one of `FROZEN_CAUSES` — the guard REFUSEs anything else. */
  readonly cause: IncidentCause
  /**
   * Journal discriminator. Omitted ⇒ `no_reply`, so every pre-BKL-211 call site is
   * byte-identical. `rejectMismatchedJournal` REFUSEs a `security_probe` cause
   * carrying any other kind, and vice versa — the two must never be split apart,
   * because `kind` is what exempts the row from delivered-reply auto-close.
   */
  readonly kind?: IncidentKind
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
 * BKL-211 — the cause⇄journal coupling. `security_probe` is the ONLY cause that
 * may ride the `security_probe` journal, and it may ride no other. Fail-closed,
 * because the two carry OPPOSITE lifecycles and a split would fail SILENTLY: a
 * `security_probe` cause landing in the `no_reply` journal would be auto-closed by
 * the very refusal reply that opened it (the attack row vanishes inside the same
 * turn), and a delivery-failure cause landing in the `security_probe` journal
 * would never self-heal and would suppress the session's real no-reply opens.
 * Ordered BEFORE `executeAll` so the REFUSE wins (the kernel evaluates business
 * guards first-match in array order).
 */
const rejectMismatchedJournal: IncidentGuard = (envelope) => {
  if (envelope.kind !== "incident.ticket.open") return null
  const payload = envelope.payload as IncidentOpenPayload
  // Absent `kind` means the no_reply default — a mismatch only if the cause is
  // the security one.
  const kind = payload.kind ?? NO_REPLY_KIND
  const causeIsSecurity = payload.cause === "security_probe"
  const kindIsSecurity = kind === SECURITY_PROBE_KIND
  if (causeIsSecurity === kindIsSecurity) return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "incident.journal_mismatch",
      "Não foi possível registrar o incidente: causa inválida.",
      `cause '${String(payload.cause)}' cannot ride incident journal kind '${String(kind)}'`,
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "journal_kind_coupling",
        cause: String(payload.cause),
        kind: String(kind),
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
  business: [rejectFalseIncident, rejectMismatchedJournal, executeAll],
  default: "REFUSE",
}
