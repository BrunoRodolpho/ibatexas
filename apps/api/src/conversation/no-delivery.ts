// ── No-delivery detection seam (Plan 1 "fix C" + W1 no-reply incident) ────────
//
// THE merged empty/failure substitution mechanism. A WhatsApp turn can fail to
// reach the customer in several distinct ways (empty/whitespace completion, a
// raced-but-non-empty turn whose send was skipped, a thrown send, a thrown
// turn, an exhausted retry). This module turns every one of those into:
//
//   1. a PURE classification (`classifyTurnDelivery`) that decides whether the
//      turn was a *genuine* customer-facing drop — short-circuiting the two
//      no-false-positive cases (the intentional bot-pause and an ESCALATE
//      handoff) BEFORE any text/empty branch, and
//   2. a best-effort NOTIFICATION publish (`emitNoDelivery`) on the standardized
//      `conversation.no_delivery` subject (fan-out backstop; never throws), and
//   3. a synchronous, fail-open, governed incident OPEN (`openIncidentInline`)
//      through the same kernel chokepoint every system mutation uses, so the
//      durable record is kernel- and (for the row itself) NATS-independent.
//
// The customer-facing holding message is sent by the webhook AFTER all three of
// the above, so a substitution bug can never mask emission.

import { publishNatsEvent } from "@ibatexas/nats-client";
import { createIncidentService, type IncidentCause, type IncidentOpenPayload } from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";

/** Mirror of the webhook `LogFn` (lives only at whatsapp-webhook.ts:66). */
export type LogFn = {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/**
 * The turn delivery disposition computed by `runConductorTurn`. Required-ness on
 * the `WhatsAppTurn` interface forces every return path to classify itself; this
 * is the discriminator that distinguishes an intentional bot-pause `{text:""}`
 * from an empty model completion (byte-identical text otherwise).
 */
export type TurnDisposition =
  | "deliverable"
  | "suppressed_paused"
  | "empty_completion"
  | "whitespace_only";

/** Pre-send catch discrimination — `turn_error` is OUT of the frozen taxonomy. */
export type CatchCause = "timeout" | "send_failed" | "turn_error";

export interface ClassifyTurnDeliveryInput {
  readonly disposition: TurnDisposition;
  /** `turn.decision.kind`; an `ESCALATE` handoff is never a drop. */
  readonly decisionKind?: string;
  /**
   * Whether ANYTHING actually reached the customer by end-of-turn —
   * `textSent || hasPixData`. Keyed on the real send result, NOT on disposition
   * alone, so the abort-with-text false-negative (P0-2) is caught: a
   * `deliverable` turn whose send was skipped because it raced the deadline.
   */
  readonly deliveredText: boolean;
}

export interface NoDeliveryClassification {
  readonly cause: IncidentCause;
  readonly customerImpacted: boolean;
}

/**
 * PURE. Returns `null` when the turn is NOT a genuine customer-facing drop.
 *
 * No-false-positives layer 1 (defense in depth; the kernel frozen-cause guard is
 * layer 2): `suppressed_paused` (intentional bot-pause) and `decisionKind ===
 * "ESCALATE"` (human handoff) short-circuit to `null` BEFORE any text/empty
 * branch is evaluated.
 */
export function classifyTurnDelivery(
  input: ClassifyTurnDeliveryInput,
): NoDeliveryClassification | null {
  // Layer 1, no-false-positives: never an incident for the intentional pause…
  if (input.disposition === "suppressed_paused") return null;
  // …nor for an ESCALATE handoff (the bot deliberately yields to a human).
  if (input.decisionKind === "ESCALATE") return null;

  // Abort-with-text false-NEGATIVE (P0-2): the turn produced text but the send
  // was skipped because it raced the deadline — nothing reached the customer.
  // Key on the ACTUAL send result, not disposition alone.
  if (input.disposition === "deliverable") {
    if (input.deliveredText) return null;
    return { cause: "timeout", customerImpacted: true };
  }

  if (input.disposition === "empty_completion") {
    return { cause: "empty_completion", customerImpacted: true };
  }
  if (input.disposition === "whitespace_only") {
    return { cause: "whitespace_only", customerImpacted: true };
  }

  return null;
}

/**
 * PURE. Discriminate a thrown send/turn into a cause. `sendEntered` MUST be set
 * `true` immediately before `sendText` (NOT by wrapping+swallowing it — that
 * breaks Twilio retry/idempotency). A pre-send turn exception → `turn_error`,
 * which is OUT of the frozen taxonomy (canned apology only, no incident).
 */
export function classifyCatchError(input: {
  readonly aborted: boolean;
  readonly message: string;
  readonly sendEntered: boolean;
}): CatchCause {
  if (input.aborted || /timed out/i.test(input.message)) return "timeout";
  if (input.sendEntered) return "send_failed";
  return "turn_error";
}

export interface NoDeliverySignal {
  readonly sessionId: string;
  readonly cause: IncidentCause;
  readonly customerImpacted: boolean;
  readonly channel: string;
  readonly customerId?: string | null;
  /** Channel-addressable handle to route a staff reply later (P1-5). */
  readonly senderRef?: string | null;
  /** LGPD hash for correlation — never raw E.164. */
  readonly phoneHash?: string | null;
  readonly turnId?: string | null;
  readonly decisionKind?: string | null;
  /** Dedup fallback when no `turnId` is in scope (the catch path). */
  readonly messageSid?: string | null;
  readonly detail?: string | null;
}

/**
 * Best-effort NOTIFICATION fan-out. The durable open is inline (`openIncidentInline`);
 * this publishes the redelivery-backstop / out-of-process signal. NEVER throws.
 */
export async function emitNoDelivery(
  signal: NoDeliverySignal,
  log: LogFn,
): Promise<void> {
  try {
    await publishNatsEvent("conversation.no_delivery", {
      sessionId: signal.sessionId,
      cause: signal.cause,
      customerImpacted: signal.customerImpacted,
      channel: signal.channel,
      customerId: signal.customerId ?? null,
      senderRef: signal.senderRef ?? null,
      phoneHash: signal.phoneHash ?? null,
      turnId: signal.turnId ?? null,
      decisionKind: signal.decisionKind ?? null,
      messageSid: signal.messageSid ?? null,
      detail: signal.detail ?? null,
    });
  } catch (err) {
    log.warn(
      { err: String(err), session: signal.sessionId, cause: signal.cause },
      "[no-delivery] emit failed (best-effort; inline open is the durable net)",
    );
  }
}

/** Build the per-event dedup id: `turnId`-keyed when available, else `messageSid`. */
function deriveEventId(sessionId: string, turnId?: string | null, messageSid?: string | null): string {
  if (turnId) return `${sessionId}:${turnId}`;
  if (messageSid) return `${sessionId}:${messageSid}`;
  return `${sessionId}:no-id`;
}

/**
 * Synchronous, FAIL-OPEN, governed incident OPEN through the kernel chokepoint.
 * Constructs the incident service with `auditSink: getAuditSink()` (withAdjudicate
 * silently skips the audit emit if the sink is absent). Only ever called for a
 * genuine drop (never `suppressed_paused`, never `ESCALATE` — the caller has
 * already classified). On a NEW open (`opened === true`) publishes
 * `conversation.incident_opened` (best-effort) so increments never re-ping.
 *
 * NEVER throws — the webhook response must not break on an incident-open failure.
 */
export async function openIncidentInline(
  signal: NoDeliverySignal,
  log: LogFn,
): Promise<void> {
  try {
    const eventId = deriveEventId(signal.sessionId, signal.turnId, signal.messageSid);
    const externalId = `conversation.no_delivery:${eventId}`;

    const svc = createIncidentService({ auditSink: getAuditSink(), log });

    const payload: IncidentOpenPayload = {
      sessionId: signal.sessionId,
      cause: signal.cause,
      channel: signal.channel,
      externalId,
      customerId: signal.customerId ?? null,
      senderRef: signal.senderRef ?? null,
      customerImpacted: signal.customerImpacted,
      phoneHash: signal.phoneHash ?? null,
      detail: signal.detail ?? null,
      lastTurnId: signal.turnId ?? null,
      lastDecisionKind: signal.decisionKind ?? null,
    };

    const envelope = buildSystemEnvelope({
      kind: "incident.ticket.open" as const,
      payload,
      sourceSubject: "conversation.no_delivery",
      eventId,
    });

    const outcome = await svc.openIncidentFromEnvelope(envelope, {});

    if (outcome.decision.kind === "EXECUTE" && outcome.result) {
      if (outcome.result.opened) {
        // A genuinely NEW incident → ping/badge fan-out. Increments do not.
        try {
          await publishNatsEvent("conversation.incident_opened", {
            incidentId: outcome.result.incident.id,
            sessionId: signal.sessionId,
            cause: signal.cause,
            severity: outcome.result.incident.severity,
            channel: signal.channel,
            customerImpacted: signal.customerImpacted,
            customerId: signal.customerId ?? null,
            senderRef: signal.senderRef ?? null,
            phoneHash: signal.phoneHash ?? null,
          });
        } catch (pubErr) {
          log.warn(
            { err: String(pubErr), incidentId: outcome.result.incident.id },
            "[no-delivery] incident_opened publish failed (badge is source of truth)",
          );
        }
      }
    } else if (outcome.decision.kind === "REFUSE") {
      // Frozen-cause guard fired — a buggy detector failed CLOSED at the kernel.
      log.error(
        { session: signal.sessionId, cause: signal.cause },
        "[no-delivery] kernel REFUSED incident open (cause out of frozen taxonomy)",
      );
    }
  } catch (err) {
    log.error(err, "[no-delivery] inline incident open failed (fail-open; webhook continues)");
  }
}
