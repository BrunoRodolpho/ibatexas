// Abstract WhatsApp sender interface.
// Injected at app startup from apps/api (avoids pulling Twilio SDK into packages/tools).

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
}

let _sender: WhatsAppSender | null = null;

export function setWhatsAppSender(sender: WhatsAppSender): void {
  _sender = sender;
}

export function getWhatsAppSender(): WhatsAppSender | null {
  return _sender;
}
