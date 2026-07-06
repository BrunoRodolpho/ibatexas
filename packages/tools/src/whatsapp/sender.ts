// Abstract WhatsApp sender interface.
// Injected at app startup from apps/api (avoids pulling Twilio SDK into packages/tools).

import type { RenderedReply } from "@adjudicate/core";

export interface WhatsAppSender {
  // EGRESS BRAND (Plan 1 / Theorem E-1): proactive senders must hand a
  // runtime-non-forgeable `RenderedReply` minted by the closed set in
  // `@adjudicate/core` (an operational minter for templated sends). The string
  // is extracted only at the Twilio chokepoint via `unwrapRendered`.
  sendText(to: string, body: RenderedReply): Promise<void>;
}

let _sender: WhatsAppSender | null = null;

export function setWhatsAppSender(sender: WhatsAppSender): void {
  _sender = sender;
}

export function getWhatsAppSender(): WhatsAppSender | null {
  return _sender;
}
