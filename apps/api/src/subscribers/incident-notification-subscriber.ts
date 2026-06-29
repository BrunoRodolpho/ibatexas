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

import { subscribeNatsEvent } from "@ibatexas/nats-client";
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

const CAUSE_PT: Record<string, string> = {
  empty_completion: "resposta vazia do modelo",
  whitespace_only: "resposta em branco do modelo",
  send_failed: "falha no envio",
  retry_exhausted: "tentativas esgotadas",
  timeout: "tempo de resposta esgotado",
};
const SEVERITY_PT: Record<string, string> = {
  low: "baixa",
  medium: "média",
  high: "alta",
};

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
        await sendIncidentPing(sender, staffPhone, { sessionId, cause, severity }, payload, log);
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
        await sendIncidentPing(sender, staffPhone, { sessionId, cause, severity }, payload, log);
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

async function sendIncidentPing(
  sender: SenderLike,
  staffPhone: string,
  fields: { sessionId?: string; cause?: string; severity?: string },
  payload: unknown,
  log?: FastifyBaseLogger,
): Promise<void> {
  const causeLine = fields.cause ? `\nCausa: ${CAUSE_PT[fields.cause] ?? fields.cause}` : "";
  const sevLine = fields.severity ? `\nGravidade: ${SEVERITY_PT[fields.severity] ?? fields.severity}` : "";
  const message = [
    `🚨 *Incidente no atendimento*`,
    ``,
    `Uma falha de resposta automática impediu a entrega ao cliente.`,
    `Sessão: ${fields.sessionId ?? "desconhecida"}${causeLine}${sevLine}`,
    ``,
    `Verifique o painel de Incidentes.`,
  ].join("\n");

  try {
    await sender.sendText(`whatsapp:${staffPhone}`, message);
    log?.info({ session_id: fields.sessionId }, "[incident-notification] staff notified via WhatsApp");
  } catch (err) {
    log?.error({ session_id: fields.sessionId, error: String(err) }, "[incident-notification] failed to send WhatsApp ping");
    await pushToDlq("conversation.incident_opened", payload as Record<string, unknown>, err, log);
  }
}

async function sendStormDigest(
  sender: SenderLike,
  staffPhone: string,
  spikeCount: number,
  payload: unknown,
  log?: FastifyBaseLogger,
): Promise<void> {
  const message = [
    `🚨 *Incidentes em massa no atendimento*`,
    ``,
    `${spikeCount} falhas de resposta automática nos últimos minutos — provável indisponibilidade do modelo.`,
    ``,
    `Verifique o painel de Incidentes e o status do modelo.`,
  ].join("\n");

  try {
    await sender.sendText(`whatsapp:${staffPhone}`, message);
    log?.warn({ spike_count: spikeCount }, "[incident-notification] storm digest sent (rate-spike)");
  } catch (err) {
    log?.error({ spike_count: spikeCount, error: String(err) }, "[incident-notification] failed to send storm digest");
    await pushToDlq("conversation.incident_opened", payload as Record<string, unknown>, err, log);
  }
}
