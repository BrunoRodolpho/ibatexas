// NATS subscriber: conversation.incident_opened (W1 no-reply incident — staff ping)
//
// Mirrors handoff-subscriber.ts. Out-of-band staff WhatsApp notification (D9)
// for a genuinely NEW no-reply incident. The subject is published ONLY when an
// open returns `opened === true` (see openIncidentInline), so dropCount
// increments never re-ping and a re-open's fresh incidentId correctly does.
//
// The in-app badge is the source of truth; this WhatsApp ping is a best-effort,
// at-most-once courtesy nudge. Distinctions from the cart-intelligence staff
// alert (deliberate — they must not share budget or identity):
//   • phone:        STAFF_NOTIFICATION_PHONE   (not the cart STAFF_ALERT_PHONE)
//   • rate-limit:   rk("alert:staff:incident:hourly")  (not rk("alert:staff:hourly"))
//   • dedup:        isNewEvent(`incident:${incidentId}`)  (7-day TTL)
//
// Storm digest (P1-6): a multi-session model outage opens one incident per
// session. Rather than silently dropping pings past the hourly cap — which would
// mute the very signal that the model is down — we send ONE aggregate digest per
// 5-minute window and emit a per-open `incident_opened_total{cause,channel}`
// metric (as a structured counter log; the prom-client Registry is not exposed
// to subscribers in Phase 1).

import { mintBroadcastReply } from "@adjudicate/core";
import { subscribeNatsEvent } from "@ibatexas/nats-client";
import {
  INCIDENT_CAUSE_LABELS_PT,
  INCIDENT_SEVERITY_LABELS_PT,
  isOpsPlaneChannel,
  type IncidentCause,
  type IncidentSeverity,
} from "@ibatexas/domain";
import { getWhatsAppSender, getRedisClient, rk, atomicIncr } from "@ibatexas/tools";
import type { FastifyBaseLogger } from "fastify";
import { pushToDlq } from "./dlq.js";
import { isNewEvent } from "./dedup.js";

const HOURLY_TTL = 60 * 60;
const SPIKE_TTL = 5 * 60;
/** Individual pings per hour before falling back to the storm digest. */
function hourlyCap(): number {
  return Number.parseInt(process.env.INCIDENT_ALERT_HOURLY_CAP || "10", 10);
}

interface IncidentOpenedPayload {
  incidentId?: string;
  sessionId?: string;
  cause?: string;
  severity?: string;
  channel?: string;
}

export async function startIncidentNotificationSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  // Boot-time WARN (P1-7): if staff phone / sender are absent the ping is a
  // silent no-op for the whole process — surface it once at start.
  if (!process.env.STAFF_NOTIFICATION_PHONE) {
    log?.warn("[incident-notification] STAFF_NOTIFICATION_PHONE not set — staff incident pings disabled");
  }
  if (!getWhatsAppSender()) {
    log?.warn("[incident-notification] WhatsApp sender not configured — staff incident pings disabled");
  }

  await subscribeNatsEvent(
    "conversation.incident_opened",
    async (payload) => {
      const { incidentId, sessionId, cause, severity, channel } = payload as IncidentOpenedPayload;
      if (!incidentId) {
        log?.warn({ payload }, "[incident-notification] malformed conversation.incident_opened — missing incidentId");
        return;
      }

      // Idempotency — one ping per incident even under redelivery.
      try {
        if (!(await isNewEvent(`incident:${incidentId}`))) {
          log?.info({ incident_id: incidentId }, "[incident-notification] duplicate — skipping");
          return;
        }
      } catch { /* dedup failure is non-fatal — continue */ }

      // Per-open metric (P1-6) — structured counter log scraped from VictoriaLogs.
      log?.info(
        { metric: "incident_opened_total", cause: cause ?? "unknown", channel: channel ?? "unknown", incident_id: incidentId },
        "[incident-notification] incident_opened_total",
      );

      const staffPhone = process.env.STAFF_NOTIFICATION_PHONE;
      if (!staffPhone) return; // boot WARN already emitted
      const sender = getWhatsAppSender();
      if (!sender) return; // boot WARN already emitted

      let redis: Awaited<ReturnType<typeof getRedisClient>>;
      try {
        redis = await getRedisClient();
      } catch (err) {
        // Without Redis we cannot rate-limit; send the individual ping anyway
        // (badge remains source of truth) rather than dropping the signal.
        await sendIncidentPing(sender, staffPhone, { sessionId, cause, severity, channel }, payload, log);
        log?.warn({ incident_id: incidentId, error: String(err) }, "[incident-notification] redis unavailable — sent ping without rate-limit");
        return;
      }

      // Count every open in the 5-min spike window so the digest is accurate.
      let spikeCount = 1;
      try {
        spikeCount = await atomicIncr(redis, rk("alert:staff:incident:spike:5m"), SPIKE_TTL);
      } catch { /* best-effort */ }

      let hourly = 1;
      try {
        hourly = await atomicIncr(redis, rk("alert:staff:incident:hourly"), HOURLY_TTL);
      } catch { /* best-effort — fall through to individual ping */ }

      if (hourly <= hourlyCap()) {
        await sendIncidentPing(sender, staffPhone, { sessionId, cause, severity, channel }, payload, log);
        return;
      }

      // Over the cap → storm: send ONE aggregate digest per 5-min window instead
      // of dropping the ping silently. SET NX claims the window.
      let digestClaimed = false;
      try {
        const claim = await redis.set(rk("alert:staff:incident:digest"), "1", { EX: SPIKE_TTL, NX: true });
        digestClaimed = claim === "OK";
      } catch { /* best-effort */ }

      if (digestClaimed) {
        await sendStormDigest(sender, staffPhone, spikeCount, payload, log);
      } else {
        log?.info({ incident_id: incidentId, hourly }, "[incident-notification] over hourly cap, digest already sent this window — skipping ping");
      }
    },
    { queueGroup: "incident-notification-subscriber" },
  );
}

type SenderLike = NonNullable<ReturnType<typeof getWhatsAppSender>>;

/**
 * Shared idempotent staff-WhatsApp delivery. Both entrypoints (per-incident
 * ping + storm digest) build a pt-BR line array then run this identical send:
 * join → mint a broadcast reply → send → log success → DLQ the source event on
 * failure. Only the message lines, the success log level/message, and the log
 * context differ per entrypoint; the send + failure handling are behavior-
 * identical (this was previously copy-pasted).
 */
async function deliverStaffMessage(
  sender: SenderLike,
  staffPhone: string,
  payload: unknown,
  spec: {
    lines: string[];
    logCtx: Record<string, unknown>;
    successMsg: string;
    failureMsg: string;
    successLevel: "info" | "warn";
  },
  log?: FastifyBaseLogger,
): Promise<void> {
  const message = spec.lines.join("\n");
  try {
    await sender.sendText(`whatsapp:${staffPhone}`, mintBroadcastReply(message));
    if (spec.successLevel === "warn") log?.warn(spec.logCtx, spec.successMsg);
    else log?.info(spec.logCtx, spec.successMsg);
  } catch (err) {
    log?.error({ ...spec.logCtx, error: String(err) }, spec.failureMsg);
    await pushToDlq("conversation.incident_opened", payload as Record<string, unknown>, err, log);
  }
}

async function sendIncidentPing(
  sender: SenderLike,
  staffPhone: string,
  fields: { sessionId?: string; cause?: string; severity?: string; channel?: string },
  payload: unknown,
  log?: FastifyBaseLogger,
): Promise<void> {
  const causeLine = fields.cause
    ? `\nCausa: ${INCIDENT_CAUSE_LABELS_PT[fields.cause as IncidentCause] ?? fields.cause}`
    : "";
  const sevLine = fields.severity
    ? `\nGravidade: ${INCIDENT_SEVERITY_LABELS_PT[fields.severity as IncidentSeverity] ?? fields.severity}`
    : "";
  // BKL-235 — the ops plane joined this journal, so the ping must not assert WHO was
  // ghosted without checking. "impediu a entrega ao cliente" is FLATLY FALSE for an
  // ops-channel row: no customer was involved — a staff member's own operational
  // command went unanswered. Sending the customer wording for an ops ghost would tell
  // the owner their customers are being dropped during a staff-channel outage, which
  // is a factually wrong outage alert (the same class of error that made the
  // attack-review journal suppress this ping entirely). The channel is already on the
  // payload; this reads it.
  const isOps = isOpsPlaneChannel(fields.channel);
  await deliverStaffMessage(
    sender,
    staffPhone,
    payload,
    {
      lines: [
        isOps ? `🚨 *Incidente no canal operacional*` : `🚨 *Incidente no atendimento*`,
        ``,
        isOps
          ? `Uma falha de resposta automática deixou um comando da equipe sem resposta.`
          : `Uma falha de resposta automática impediu a entrega ao cliente.`,
        `Sessão: ${fields.sessionId ?? "desconhecida"}${causeLine}${sevLine}`,
        ``,
        `Verifique o painel de Incidentes.`,
      ],
      logCtx: { session_id: fields.sessionId, channel: fields.channel ?? null },
      successMsg: "[incident-notification] staff notified via WhatsApp",
      failureMsg: "[incident-notification] failed to send WhatsApp ping",
      successLevel: "info",
    },
    log,
  );
}

async function sendStormDigest(
  sender: SenderLike,
  staffPhone: string,
  spikeCount: number,
  payload: unknown,
  log?: FastifyBaseLogger,
): Promise<void> {
  await deliverStaffMessage(
    sender,
    staffPhone,
    payload,
    {
      lines: [
        `🚨 *Incidentes em massa no atendimento*`,
        ``,
        `${spikeCount} falhas de resposta automática nos últimos minutos — provável indisponibilidade do modelo.`,
        ``,
        `Verifique o painel de Incidentes e o status do modelo.`,
      ],
      logCtx: { spike_count: spikeCount },
      successMsg: "[incident-notification] storm digest sent (rate-spike)",
      failureMsg: "[incident-notification] failed to send storm digest",
      successLevel: "warn",
    },
    log,
  );
}
