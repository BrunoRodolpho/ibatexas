// NATS subscriber: support.handoff_requested
//
// Listens for handoff requests from the AI agent and notifies staff via WhatsApp.

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { getWhatsAppSender } from "@ibatexas/tools";
import type { FastifyBaseLogger } from "fastify";

export async function startHandoffSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  await subscribeNatsEvent("support.handoff_requested", async (payload) => {
    const { sessionId, reason } = payload as { sessionId: string; reason?: string };

    log?.info(
      { session_id: sessionId, reason },
      "[handoff-subscriber] support.handoff_requested received",
    );

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
    const message = [
      `📞 *Solicitação de atendimento humano*`,
      ``,
      `Sessão: ${sessionId}${reasonLine}`,
      ``,
      `Um cliente solicitou falar com um atendente.`,
    ].join("\n");

    try {
      await sender.sendText(`whatsapp:${staffPhone}`, message);
      log?.info({ session_id: sessionId }, "[handoff-subscriber] Staff notified via WhatsApp");
    } catch (err) {
      log?.error(
        { session_id: sessionId, error: String(err) },
        "[handoff-subscriber] Failed to send WhatsApp notification",
      );
    }
  });
}
