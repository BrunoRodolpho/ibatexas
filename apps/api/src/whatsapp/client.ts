// WhatsApp client — send text messages via Twilio.
//
// Singleton Twilio client, auto-splits at 4096 chars,
// retry with exponential backoff on failures.
// All sends log phone hash, never raw phone numbers.

import twilio from "twilio";
import { createHash } from "node:crypto";

// ── Twilio client (singleton) ─────────────────────────────────────────────────

let _client: ReturnType<typeof twilio> | null = null;

function getTwilioClient(): ReturnType<typeof twilio> {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !auth) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set");
    _client = twilio(sid, auth);
  }
  return _client;
}

export function getWhatsAppNumber(): string {
  const num = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!num) throw new Error("TWILIO_WHATSAPP_NUMBER not set");
  return num;
}

/** One-way hash of a phone number — safe to log. */
export function phoneHash(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 12);
}

// ── Message splitting ──────────────────────────────────────────────────────────

const MAX_WHATSAPP_LENGTH = 4096;

/**
 * Split text at sentence boundaries (`.!?`), then newline, then space.
 * If split, each part is prefixed with `(1/N)`.
 */
export function splitForWhatsApp(text: string): string[] {
  if (text.length <= MAX_WHATSAPP_LENGTH) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_WHATSAPP_LENGTH) {
    const chunk = remaining.slice(0, MAX_WHATSAPP_LENGTH);

    // Prefer sentence boundary
    let splitIdx = -1;
    for (let i = chunk.length - 1; i > MAX_WHATSAPP_LENGTH * 0.5; i--) {
      if (chunk[i] === "." || chunk[i] === "!" || chunk[i] === "?") {
        splitIdx = i + 1;
        break;
      }
    }

    // Fallback to newline
    if (splitIdx === -1) {
      splitIdx = chunk.lastIndexOf("\n");
      if (splitIdx !== -1) splitIdx += 1;
    }

    // Fallback to space
    if (splitIdx === -1) {
      splitIdx = chunk.lastIndexOf(" ");
      if (splitIdx !== -1) splitIdx += 1;
    }

    // Hard split as last resort
    if (splitIdx <= 0) splitIdx = MAX_WHATSAPP_LENGTH;

    parts.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) parts.push(remaining);

  // Add part indicators
  if (parts.length > 1) {
    return parts.map((p, i) => `(${i + 1}/${parts.length})\n${p}`);
  }
  return parts;
}

// ── Send helpers ───────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a text message, auto-splitting if >4096 chars.
 * Retries up to 3x with exponential backoff.
 */
export async function sendText(to: string, body: string): Promise<void> {
  const parts = splitForWhatsApp(body);
  const hash = phoneHash(to.replace("whatsapp:", ""));

  for (let i = 0; i < parts.length; i++) {
    // Typing simulation: 600ms delay before first part
    if (i === 0) await sleep(600);
    // 200ms delay between subsequent parts to preserve order
    if (i > 0) await sleep(200);

    await sendSingleMessage(to, parts[i], hash);
  }

  console.info("[whatsapp.send]", { phone_hash: hash, parts_count: parts.length });
}

async function sendSingleMessage(to: string, body: string, hash: string): Promise<void> {
  const client = getTwilioClient();
  const from = getWhatsAppNumber();
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await client.messages.create({ from, to, body });
      return;
    } catch (err) {
      const isLast = attempt === maxRetries - 1;
      console.error(
        `[whatsapp.send.error] attempt=${attempt + 1}/${maxRetries}`,
        { phone_hash: hash, error: String(err) },
      );
      if (isLast) throw err;
      await sleep(200 * 2 ** attempt);
    }
  }
}

/**
 * Send an interactive list message via Twilio Content API.
 * Uses `contentVariables` with a pre-created Content Template,
 * or falls back to numbered text if not configured / fails.
 */
export async function sendInteractiveList(
  to: string,
  body: string,
  _buttonText: string,
  sections: InteractiveSection[],
): Promise<void> {
  // Interactive messages via Twilio require pre-registered Content Templates (contentSid).
  // Until templates are approved in production, send as formatted numbered text.
  const lines: string[] = [body, ""];

  let counter = 1;
  for (const section of sections) {
    if (section.title) lines.push(`*${section.title}*`);
    for (const row of section.rows) {
      const desc = row.description ? ` — ${row.description}` : "";
      lines.push(`${counter}️⃣ ${row.title}${desc}`);
      counter++;
    }
    lines.push("");
  }

  await sendText(to, lines.join("\n").trimEnd());
}

/**
 * Send an interactive button message via Twilio Content API.
 * Falls back to formatted text with labeled options.
 */
export async function sendInteractiveButtons(
  to: string,
  body: string,
  buttons: InteractiveButton[],
): Promise<void> {
  // Until Twilio Content Templates are approved, send as formatted text
  const buttonLabels = buttons.map((b) => `▸ *${b.title}*`).join("\n");
  await sendText(to, `${body}\n\n${buttonLabels}\n\n_Responda com a opção desejada._`);
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InteractiveRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveSection {
  title?: string;
  rows: InteractiveRow[];
}

export interface InteractiveButton {
  id: string;
  title: string;
}
