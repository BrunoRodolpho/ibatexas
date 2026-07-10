// Broadcast / blast orchestration (responder-trace-admin D3).
//
// Pure, injectable core: iterate a recipient segment, skip opted-out numbers,
// send the (pre-approved) template via the injected sender, and collect a
// per-recipient status + aggregate counts. Sending is SEQUENTIAL so the
// underlying WhatsApp client's per-number token-bucket rate limiter
// (WHATSAPP_SEND_RATE_PER_SECOND) + Redis idempotency naturally pace the blast —
// runBroadcast never floods.
//
// WhatsApp policy: the `template` MUST be a pre-approved template / be inside the
// 24h customer-service window; enforcement is delegated to the send path
// (Twilio rejects an out-of-policy proactive send, surfaced here as `failed`).
// Opt-out is honored BEFORE the send (see broadcast-optout.ts).

export type BroadcastStatus = "sent" | "skipped_opted_out" | "failed";

export interface BroadcastRecipientResult {
  readonly recipient: string;
  readonly status: BroadcastStatus;
  readonly error?: string;
}

export interface BroadcastResult {
  readonly total: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly results: BroadcastRecipientResult[];
}

export interface RunBroadcastOptions {
  readonly recipients: readonly string[];
  readonly template: string;
  /** Deliver one message (the route wraps the rate-limited WhatsApp send). */
  readonly send: (recipient: string, body: string) => Promise<void>;
  /** Opt-out gate — honored BEFORE the send. */
  readonly isOptedOut: (recipient: string) => Promise<boolean>;
  /** Hard cap on a single blast (defense against an accidental mega-segment). */
  readonly maxRecipients?: number;
}

const DEFAULT_MAX_RECIPIENTS = 5000;

export async function runBroadcast(
  opts: RunBroadcastOptions,
): Promise<BroadcastResult> {
  const cap = opts.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;
  // Dedup (a segment may repeat a number) + cap.
  const recipients = [...new Set(opts.recipients)].slice(0, Math.max(0, cap));

  const results: BroadcastRecipientResult[] = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const recipient of recipients) {
    // Consent gate. A transient consent-read rejection must NOT abort the whole
    // blast (that would discard the tally for every already-sent recipient and
    // provoke a full retry — a double-send past the WhatsApp idempotency TTL).
    // Fail-closed for compliance: if we cannot confirm consent we do NOT send,
    // and record the recipient as `failed` so the manager can re-target just
    // those numbers instead of re-blasting everyone.
    let optedOut: boolean;
    try {
      optedOut = await opts.isOptedOut(recipient);
    } catch (err) {
      results.push({
        recipient,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
      continue;
    }
    if (optedOut) {
      results.push({ recipient, status: "skipped_opted_out" });
      skipped++;
      continue;
    }
    try {
      await opts.send(recipient, opts.template);
      results.push({ recipient, status: "sent" });
      sent++;
    } catch (err) {
      results.push({
        recipient,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  return { total: recipients.length, sent, skipped, failed, results };
}
