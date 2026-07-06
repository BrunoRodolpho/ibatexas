// NATS subscriber: conversation.no_delivery (W1 no-reply incident — durable backstop)
//
// This is the DURABLE consumer of the no-delivery notification signal. Unlike
// the plain Core `subscribeNatsEvent` of conversation-archiver.ts, it carries a
// stable `queueGroup` → under `NATS_JETSTREAM_ENABLED` that maps to a DURABLE
// JetStream consumer with MANUAL ack/nak/term + DLQ (see @ibatexas/nats-client
// `jetstreamSubscribe`): a message published while this process was down is
// REDELIVERED on restart from the IBX_CONVERSATION stream (7-day retention).
//
// It exists to (a) provide a redelivery / replay backstop for the WhatsApp
// inline open (whatsapp-webhook.ts → openIncidentInline), and (b) serve future
// out-of-process emitters (Phase 4 web / agent planes) that have no inline open.
//
// The durable row itself is kernel- and NATS-independent (the inline path writes
// it synchronously). This consumer re-runs the SAME governed open; the
// `@@unique(externalId)` + `findFirst-OPEN` increment in the domain executor
// collapse a duplicate to a no-op, so it is safe to fire alongside the inline
// path for the same drop (no double open, no double `incident_opened` ping).
//
// On a governance REFUSE (a cause outside the frozen taxonomy — a buggy or
// forged emitter) the kernel fails CLOSED and the open never runs. We do NOT
// DLQ-and-forget an owed reply: we persist a flagged `suspect` row (quarantined
// by a distinct externalId namespace + a `[SUSPECT]` detail marker) and alert
// LOUDLY so a human sees the dropped reply.

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import {
  prisma,
  FROZEN_CAUSES,
  type IncidentCause,
} from "@ibatexas/domain";
import type { FastifyBaseLogger } from "fastify";
import {
  deriveEventId,
  openIncidentInline,
  type LogFn,
  type NoDeliverySignal,
} from "../conversation/no-delivery.js";
import { withDedup } from "./dedup.js";

/** Coerce a payload field to a NoDeliverySignal. Required: sessionId + cause. */
function toSignal(payload: Record<string, unknown>): NoDeliverySignal | null {
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
  const cause = typeof payload.cause === "string" ? payload.cause : null;
  if (!sessionId || !cause) return null;
  return {
    sessionId,
    cause: cause as IncidentCause, // governance frozen-cause guard validates downstream
    customerImpacted: payload.customerImpacted !== false,
    channel: typeof payload.channel === "string" ? payload.channel : "whatsapp",
    customerId: (payload.customerId as string | null | undefined) ?? null,
    senderRef: (payload.senderRef as string | null | undefined) ?? null,
    phoneHash: (payload.phoneHash as string | null | undefined) ?? null,
    turnId: (payload.turnId as string | null | undefined) ?? null,
    decisionKind: (payload.decisionKind as string | null | undefined) ?? null,
    messageSid: (payload.messageSid as string | null | undefined) ?? null,
    detail: (payload.detail as string | null | undefined) ?? null,
  };
}

/**
 * Persist a flagged `suspect` incident when governance REFUSED the open. There
 * is no SUSPECT status/cause in the Phase-1 enum, so the row is quarantined by
 * (a) a distinct `conversation.no_delivery:suspect:` externalId namespace and
 * (b) a `[SUSPECT]` `detail` marker carrying the raw refused cause. This is a
 * DELIBERATE, narrow write-bypass of the kernel chokepoint — by definition the
 * governed path refused — so an owed reply is never silently lost. `cause` is
 * coerced to a valid enum member (the raw value lives in `detail`).
 */
async function persistSuspectRow(
  signal: NoDeliverySignal,
  eventId: string,
  refusedCode: string | undefined,
  log: LogFn,
): Promise<void> {
  const isFrozen = (FROZEN_CAUSES as readonly string[]).includes(signal.cause);
  const safeCause: IncidentCause = isFrozen ? (signal.cause as IncidentCause) : "send_failed";
  const now = new Date();
  const externalId = `conversation.no_delivery:suspect:${eventId}`;
  const detail = `[SUSPECT] kernel REFUSED incident open — rawCause=${signal.cause}${
    refusedCode ? ` code=${refusedCode}` : ""
  }${signal.detail ? ` orig=${signal.detail}` : ""}`;

  try {
    await prisma.conversationIncident.create({
      data: {
        sessionId: signal.sessionId,
        conversationId: null,
        customerId: signal.customerId ?? null,
        channel: signal.channel,
        senderRef: signal.senderRef ?? null,
        cause: safeCause,
        severity: "high",
        status: "OPEN",
        dropCount: 1,
        customerImpacted: signal.customerImpacted,
        openedAt: now,
        lastDropAt: now,
        lastTurnId: signal.turnId ?? null,
        lastDecisionKind: signal.decisionKind ?? null,
        externalId,
        phoneHash: signal.phoneHash ?? null,
        detail,
      },
    });
    log.error(
      { session: signal.sessionId, rawCause: signal.cause, code: refusedCode, externalId },
      "[incident-subscriber][SUSPECT] governance REFUSED open — persisted flagged suspect row (owed reply NOT forgotten)",
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2002") {
      // Two DISTINCT unique constraints can fire here — disambiguate by target:
      //   (a) conversation_incidents_external_id_key → the SAME suspect row was
      //       already written (redelivery) → idempotent no-op.
      //   (b) conversation_incidents_session_open_uq (the partial unique index:
      //       one non-terminal incident per session) → the session already has a
      //       DIFFERENT open incident, so a second OPEN suspect row is impossible.
      //       Do NOT silently drop the owed reply this row promises to alert about —
      //       attach the suspect marker to the existing open incident instead.
      const target = String(
        (err as { meta?: { target?: unknown } }).meta?.target ?? "",
      );
      if (target.includes("external")) {
        log.info({ session: signal.sessionId, externalId }, "[incident-subscriber][SUSPECT] suspect row already persisted — skip");
        return;
      }
      await attachSuspectToOpenIncident(signal, detail, log);
      return;
    }
    log.error(
      { session: signal.sessionId, error: String(err) },
      "[incident-subscriber][SUSPECT] FAILED to persist suspect row — owed reply at risk",
    );
  }
}

/**
 * A governance-REFUSED suspect collided with the per-session open-incident
 * partial unique index — the session already has a DIFFERENT open incident, so a
 * second OPEN row cannot exist. Rather than DROP the owed reply, fold the suspect
 * marker into the existing open incident (bump the drop count, keep
 * customerImpacted monotonic, append the [SUSPECT] detail) and alert LOUDLY.
 */
async function attachSuspectToOpenIncident(
  signal: NoDeliverySignal,
  suspectDetail: string,
  log: LogFn,
): Promise<void> {
  try {
    const existing = await prisma.conversationIncident.findFirst({
      where: { sessionId: signal.sessionId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      orderBy: { openedAt: "desc" },
    });
    if (!existing) {
      // Race: the blocking incident closed between our failed create and this
      // re-read. The owed reply is still unrecorded → surface it loudly rather
      // than swallow (consistent with the generic persist-failure branch).
      log.error(
        { session: signal.sessionId, rawCause: signal.cause },
        "[incident-subscriber][SUSPECT] session-open collision but no open incident on re-read — owed reply at risk",
      );
      return;
    }
    await prisma.conversationIncident.update({
      where: { id: existing.id },
      data: {
        dropCount: { increment: 1 },
        lastDropAt: new Date(),
        // customerImpacted is MONOTONIC (never downgrade true→false).
        customerImpacted: existing.customerImpacted || signal.customerImpacted,
        detail: existing.detail ? `${existing.detail}\n${suspectDetail}` : suspectDetail,
      },
    });
    log.error(
      { session: signal.sessionId, incidentId: existing.id, rawCause: signal.cause },
      "[incident-subscriber][SUSPECT] governance REFUSED open + session already has an open incident — attached suspect to it (owed reply NOT forgotten)",
    );
  } catch (err) {
    log.error(
      { session: signal.sessionId, error: String(err) },
      "[incident-subscriber][SUSPECT] FAILED to attach suspect to open incident — owed reply at risk",
    );
  }
}

export async function startIncidentSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  const lf: LogFn = {
    info: (...a: unknown[]) => log?.info(a[0] as object, a[1] as string),
    warn: (...a: unknown[]) => log?.warn(a[0] as object, a[1] as string),
    error: (...a: unknown[]) => log?.error(a[0] as object, a[1] as string),
  };

  await subscribeNatsEvent(
    "conversation.no_delivery",
    async (payload) => {
      const signal = toSignal(payload);
      if (!signal) {
        log?.warn({ payload }, "[incident-subscriber] malformed conversation.no_delivery — missing sessionId/cause");
        return;
      }

      const eventId = deriveEventId(signal.sessionId, signal.turnId, signal.messageSid);

      // Two-phase idempotency (withDedup): the 7-day dedup key is committed ONLY
      // after the side effect SUCCEEDS. A transient failure (kind:"error") is
      // rethrown so (a) the dedup key is NOT committed and (b) JetStream
      // redelivers (Core NATS → DLQ) — an owed reply is never ack-suppressed for
      // 7 days. Genuine duplicates collapse via the claim + the domain
      // findFirst-OPEN / @@unique(externalId) guards. The claim fails CLOSED on
      // Redis-down (DedupUnavailableError → redeliver / DLQ), consistent with the
      // other side-effecting subscribers (payment-lifecycle, cart-intelligence).
      const processed = await withDedup(
        `incident:no_delivery:${eventId}`,
        async () => {
          // Same governed open the inline webhook path uses (publishes
          // conversation.incident_opened on a genuinely NEW open).
          const result = await openIncidentInline(signal, lf);

          if (result.kind === "refused") {
            await persistSuspectRow(signal, eventId, result.code, lf);
          } else if (result.kind === "opened") {
            log?.info(
              { session: signal.sessionId, incident_id: result.incidentId, cause: signal.cause },
              "[incident-subscriber] opened incident via durable backstop",
            );
          } else if (result.kind === "error") {
            // Do NOT swallow: swallowing would ack the message AND promote the
            // dedup key to the full TTL, silently losing the owed reply for 7
            // days. Rethrow → withDedup releases the claim (key uncommitted) and
            // the subscriber surfaces it for redelivery (JetStream) / DLQ (Core).
            throw result.error instanceof Error
              ? result.error
              : new Error(
                  `[incident-subscriber] inline incident open failed: ${String(result.error)}`,
                );
          }
          // kind:"duplicate" → success no-op; the claim promotes to the full TTL.
        },
      );

      if (!processed) {
        log?.info(
          { session: signal.sessionId, event_id: eventId },
          "[incident-subscriber] duplicate — skipping",
        );
      }
    },
    { queueGroup: "incident-subscriber" },
  );
}
