// Shared staff take-over reply flow (dedup of admin/incidents.ts + admin/escalations.ts).
//
// Both the incident `/reply` and the escalation `/reply` admin routes implement
// the SAME "a human takes over the conversation" delivery flow. This is the ONE
// copy both call:
//
//   1. record the reply in the durable transcript as an `assistant` message
//      tagged via:staff_takeover (best-effort — the Conversation row may not
//      exist yet for a guest / not-yet-archived session → skip the append but
//      still deliver);
//   2. deliver it live on the channel (WhatsApp; other channels are recorded-only);
//   3. on a genuine delivery, close any OPEN no-reply incident on the session as
//      STAFF — the staff identity, NOT AUTO/system (P1-3). A delivered staff
//      take-over IS a delivered assistant reply and is the ONLY thing that can
//      close an incident on a session paused for human handoff; crediting it to
//      the bot would corrupt the self-heal-rate metric. Fail-open, idempotent.
//
// Each ROUTE keeps its own lookup + 404 contract and resolves the recipient
// itself (the incident path adds a senderRef fallback for guests, per P1-5),
// then hands the common core here as pre-resolved `channel` + `to`.

import { mintBroadcastReply } from "@adjudicate/core";
import { getWhatsAppSender } from "@ibatexas/tools";
import { closeIncidentOnStaffReply } from "../../incidents/incident-auto-close.js";
import type { LogFn } from "../../conversation/no-delivery.js";

/** The slice of the conversation service the staff-reply flow needs (kept
 *  structural so the helper never imports the heavy domain package for a type,
 *  and so it stays trivially test-doubleable). */
interface TranscriptAppender {
  appendMessage(params: {
    conversationId: string;
    role: "user" | "assistant" | "system";
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export interface StaffTakeoverReplyInput {
  /** The conversation service (lazily built by the caller). */
  readonly service: TranscriptAppender;
  /** Session the reply belongs to — keys the incident close. */
  readonly sessionId: string;
  /** The staff-authored reply text. */
  readonly text: string;
  /** Resolved channel (`"whatsapp"` delivers live; anything else is recorded-only). */
  readonly channel: string | null;
  /** Channel-addressable recipient (e.g. `whatsapp:+55…`), or null if unresolvable. */
  readonly to: string | null;
  /** Staff identity (null → `admin-key`). */
  readonly staffId: string | null;
  /** Conversation to append to; null → skip the append (guest / not-yet-archived). */
  readonly conversation: { readonly id: string } | null;
  /** Extra metadata merged into the transcript message (e.g. `{ incidentId }`). */
  readonly metadata?: Record<string, unknown>;
  /** Caller tag for the delivery-failure log line (`"incidents"` | `"escalations"`). */
  readonly logLabel: string;
  readonly log: LogFn;
}

/**
 * Record + deliver + (on delivery) close. Returns whether the reply was actually
 * delivered to the customer. Mirrors the pre-dedup inline flow.
 */
export async function staffTakeoverReply(input: StaffTakeoverReplyInput): Promise<boolean> {
  const { service, sessionId, text, channel, to, staffId, conversation, metadata, logLabel, log } =
    input;

  // 1. Record in the durable transcript (assistant-side), tagged via:staff_takeover.
  if (conversation) {
    await service.appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: text,
      metadata: {
        via: "staff_takeover",
        ...(metadata ?? {}),
        ...(staffId ? { staffId } : {}),
      },
    });
  }

  // 2. Deliver on the channel. WhatsApp delivers live; web is recorded-only.
  let delivered = false;
  if (channel === "whatsapp" && to) {
    try {
      const sender = getWhatsAppSender();
      if (sender) {
        await sender.sendText(to, mintBroadcastReply(text));
        delivered = true;
      }
    } catch (err) {
      log.error(
        { sessionId, error: String(err) },
        `[${logLabel}] WhatsApp delivery of staff reply failed (recorded in transcript regardless)`,
      );
    }
  }

  // 3. A delivered staff take-over reply closes the incident as STAFF (P1-3).
  if (delivered) {
    await closeIncidentOnStaffReply(
      sessionId,
      staffId ? `staff:${staffId}` : "admin-key",
      `staff_takeover:${staffId ?? "admin-key"}:${Date.now()}`,
      log,
    );
  }

  return delivered;
}
