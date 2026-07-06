// NATS subscriber: support.handoff_requested
//
// Listens for handoff requests from the AI agent and (1) records escalation
// state so the session is PAUSED for the bot + appears in the staff takeover
// queue (D2), and (2) notifies staff via WhatsApp.

import { mintBroadcastReply } from "@adjudicate/core";
import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { getWhatsAppSender } from "@ibatexas/tools";
import type { FastifyBaseLogger } from "fastify";
import { pushToDlq } from "./dlq.js";
import { isNewEvent } from "./dedup.js";
import { getEscalationStore } from "../escalation/escalation-store.js";
import { resolveIncidentOnHandoff } from "../incidents/incident-auto-close.js";

export async function startHandoffSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  await subscribeNatsEvent("support.handoff_requested", async (payload) => {
    const {
      sessionId,
      reason,
      // AUT-017 — present ONLY when the ESCALATE parked a resumable money intent.
      // The FULL envelope stays in the escalation park store; only these opaque
      // fields ride NATS (the payload itself NEVER does).
      parkToken,
      intentHash,
      intentKind,
      summaryPtBr,
      // BKL-122 — present when a managed-agent approval was parked: the BKL-105
      // one-tap deep-link (/admin/aprovacoes/:token) built by the publisher from
      // ADMIN_BASE_URL. Absent when the admin base URL is unavailable (prod +
      // unset), in which case no link line is rendered.
      approvalUrl,
    } = payload as {
      sessionId: string;
      reason?: string;
      parkToken?: string;
      intentHash?: string;
      intentKind?: string;
      summaryPtBr?: string;
      approvalUrl?: string;
    };

    // Idempotency guard — prevent duplicate staff alerts on NATS redelivery
    try {
      if (!(await isNewEvent(`handoff:${sessionId}`))) {
        log?.info({ session_id: sessionId }, "[handoff-subscriber] duplicate — skipping");
        return;
      }
    } catch { /* dedup failure is non-fatal — continue processing */ }

    log?.info(
      { session_id: sessionId, reason },
      "[handoff-subscriber] support.handoff_requested received",
    );

    // D2 — record the escalation (pauses the bot for this session + enqueues it
    // for staff). Best-effort: a recording failure must not block the staff
    // alert below (the WhatsApp ping is the fallback signal).
    const handoffAt = new Date().toISOString();
    try {
      const store = await getEscalationStore();
      await store.recordHandoff({
        sessionId,
        reason: reason ?? null,
        at: handoffAt,
      });
      // AUT-017 — record the parked money intent's projection on the record so
      // the escalações UI shows it as "Pendente de aprovação" and the OWNER can
      // resolve it. Idempotent on intentHash (NATS redelivery does not duplicate).
      if (parkToken && intentHash && intentKind) {
        await store.appendPendingIntent(sessionId, {
          token: parkToken,
          intentKind,
          intentHash,
          summaryPtBr: summaryPtBr ?? intentKind,
          requestedAt: handoffAt,
          status: "pending",
        });
      }
    } catch (err) {
      log?.error(
        { session_id: sessionId, error: String(err) },
        "[handoff-subscriber] failed to record escalation state (swallowed)",
      );
    }

    // P1-3: if the handoff opens on a session that still has an OPEN incident,
    // the bot is now paused and can never auto-close it — resolve it here as
    // HANDED_OFF (resolved_by=system:escalation). Fail-open, idempotent.
    await resolveIncidentOnHandoff(sessionId, handoffAt, {
      info: (...a: unknown[]) => log?.info(a[0] as object, a[1] as string),
      warn: (...a: unknown[]) => log?.warn(a[0] as object, a[1] as string),
      error: (...a: unknown[]) => log?.error(a[0] as object, a[1] as string),
    });

    const staffPhone = process.env.STAFF_NOTIFICATION_PHONE;
    if (!staffPhone) {
      log?.info("[handoff-subscriber] STAFF_NOTIFICATION_PHONE not set — skipping WhatsApp notification");
      return;
    }

    const sender = getWhatsAppSender();
    if (!sender) {
      log?.info("[handoff-subscriber] WhatsApp sender not configured — skipping notification");
      return;
    }

    const reasonLine = reason ? `\nMotivo: ${reason}` : "";
    // AUT-017 — when a resumable money intent was parked, tell staff an OWNER
    // approval is pending and where to act (the escalações panel).
    const pendingLine =
      parkToken && summaryPtBr
        ? `\n\n⚠️ Ação pendente de aprovação (OWNER): ${summaryPtBr} — aprove no painel, em Escalações.`
        : "";
    // BKL-122 — one-tap link to the exact approval (BKL-105 deep-link route). Only
    // when the publisher supplied it (ADMIN_BASE_URL available). One clean line.
    const approvalLinkLine = approvalUrl ? `\n\nAprovar/recusar: ${approvalUrl}` : "";
    const message = [
      `📞 *Solicitação de atendimento humano*`,
      ``,
      `Sessão: ${sessionId}${reasonLine}`,
      ``,
      `Um cliente solicitou falar com um atendente.${pendingLine}${approvalLinkLine}`,
    ].join("\n");

    try {
      await sender.sendText(`whatsapp:${staffPhone}`, mintBroadcastReply(message));
      log?.info({ session_id: sessionId }, "[handoff-subscriber] Staff notified via WhatsApp");
    } catch (err) {
      log?.error(
        { session_id: sessionId, error: String(err) },
        "[handoff-subscriber] Failed to send WhatsApp notification",
      );
      await pushToDlq("support.handoff_requested", payload as Record<string, unknown>, err, log);
    }
  }, { queueGroup: "handoff-subscriber" });
}
