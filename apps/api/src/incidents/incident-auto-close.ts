// ── No-reply incident auto-close seam (W1 Phase 2 — Q2 "auto-close when") ─────
//
// An incident AUTO_RESOLVES when the NEXT assistant reply on the same
// `sessionId` is successfully DELIVERED + appended — not when the customer
// types, not when the model emits text. The close fires at the post-send/append
// site (never at `emitTurn`, which reflects *generated* not *delivered* text):
//
//   - whatsapp-webhook.ts — after the PIX block, OUT of the text gate, gated on
//     the SAME delivered predicate as detection (`textSent || hasPixData`) so a
//     PIX-only recovery also closes (REVIEW-v2).
//   - whatsapp-webhook.ts retryForMissedMessages — the best-effort second-attempt
//     delivered branch.
//   - escalations.ts staff take-over reply — a staff reply IS a delivered
//     assistant reply, and is the ONLY thing that can close an incident on a
//     session since paused for human handoff (P1-3).
//
// Both entry points are FAIL-OPEN wrapped: an incident-close failure must NEVER
// break the reply path. The close routes through the same kernel chokepoint
// every system mutation uses (`buildSystemEnvelope` → `withAdjudicate`), and is
// idempotent (the executor's `updateMany WHERE status non-terminal` makes a
// repeat / already-terminal close a no-op).

import {
  createIncidentService,
  type IncidentClosePayload,
  type IncidentResolutionType,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";
import type { LogFn } from "../conversation/no-delivery.js";

/** Build the incident service with the audit sink wired (withAdjudicate skips the
 *  emit entirely if the sink is absent — CLAUDE.md rule #9 / D6). */
function service(log?: LogFn) {
  return createIncidentService({
    auditSink: getAuditSink(),
    ...(log ? { log } : {}),
  });
}

interface CloseSpec {
  readonly resolutionType: IncidentResolutionType;
  readonly resolvedBy: string;
  /** Per-event component of the close `eventId` — keeps re-opened incidents from
   *  colliding under any future ledger dedup. */
  readonly deliveredId: string;
  readonly sourceSubject: string;
  readonly closingTurnId?: string | null;
}

/**
 * Shared core: cheap indexed lookup for a non-terminal incident on the session
 * (fast null on the ~99.9% happy path), then route a governed
 * `incident.ticket.close`. NEVER throws — wrapped fail-open.
 */
async function closeActiveIncident(
  sessionId: string,
  spec: CloseSpec,
  log?: LogFn,
): Promise<void> {
  try {
    const svc = service(log);
    // Cheap indexed lookup — fast null on the happy path (no open incident).
    const incident = await svc.findOpenBySession(sessionId);
    if (!incident) return;

    const payload: IncidentClosePayload = {
      id: incident.id,
      resolvedBy: spec.resolvedBy,
      resolutionType: spec.resolutionType,
      closingTurnId: spec.closingTurnId ?? null,
    };
    const envelope = buildSystemEnvelope({
      kind: "incident.ticket.close" as const,
      payload,
      sourceSubject: spec.sourceSubject,
      eventId: `${incident.id}:${spec.deliveredId}`,
    });
    await svc.closeIncidentFromEnvelope(envelope, {});
  } catch (err) {
    log?.error?.(
      { err: String(err), session: sessionId, source: spec.sourceSubject },
      "[incident-auto-close] failed (fail-open; reply path continues)",
    );
  }
}

/**
 * AUTO self-heal: the next assistant reply on `sessionId` was successfully
 * delivered + appended → AUTO_RESOLVED, `resolved_by=system`. Idempotent and
 * fail-open. `deliveredTurnId` is the delivered turn's id (the close `eventId`
 * needs a per-delivered-turn-unique component).
 */
export async function closeIncidentOnDeliveredReply(
  sessionId: string,
  deliveredTurnId: string,
  log?: LogFn,
): Promise<void> {
  return closeActiveIncident(
    sessionId,
    {
      resolutionType: "AUTO",
      resolvedBy: "system",
      deliveredId: deliveredTurnId,
      sourceSubject: "incident.auto_close",
      closingTurnId: deliveredTurnId,
    },
    log,
  );
}

/**
 * HANDED_OFF: a human handoff opened on a session that still has an OPEN
 * incident. The bot is now paused and can never auto-close it, so resolve it
 * here → RESOLVED, `resolved_by=system:escalation` (P1-3). Idempotent and
 * fail-open. `handoffMarker` (e.g. an ISO timestamp) keys the close `eventId`.
 */
export async function resolveIncidentOnHandoff(
  sessionId: string,
  handoffMarker: string,
  log?: LogFn,
): Promise<void> {
  return closeActiveIncident(
    sessionId,
    {
      resolutionType: "HANDED_OFF",
      resolvedBy: "system:escalation",
      deliveredId: `handoff:${handoffMarker}`,
      sourceSubject: "incident.handoff_close",
    },
    log,
  );
}
