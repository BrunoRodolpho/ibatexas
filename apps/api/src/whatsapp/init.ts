// Initialize WhatsApp sender — called once at server startup.
// Wires the Twilio-backed implementation into packages/tools
// so notification stubs can send real WhatsApp messages.

import { setWhatsAppSender } from "@ibatexas/tools";
import logger from "../lib/logger.js";
import { sendText } from "./client.js";

export function initWhatsAppSender(): void {
  if (!process.env.TWILIO_WHATSAPP_NUMBER) {
    logger.info("[whatsapp.init] TWILIO_WHATSAPP_NUMBER not set — notifications will use console stubs");
    return;
  }

  setWhatsAppSender({ sendText });
  logger.info("[whatsapp.init] WhatsApp sender initialized");
}
