// Twilio delivery-status callback (LE2-030) — the ingest half of "sent becomes
// delivered".
//
// Twilio POSTs one form-urlencoded callback per status transition of an
// outbound message (`queued` → `sent` → `delivered`, or `failed` /
// `undelivered`). This route ingests them, validates them with the SAME
// `verifyTwilioSignature` the inbound message webhook uses (imported, not
// re-implemented), and folds each one onto the `whatsapp_delivery` row the send
// path wrote for that SID.
//
// ── Governance posture (CLAUDE.md #9) ───────────────────────────────────────
//
// This ingest writes EXACTLY ONE writer-owned observability table
// (`whatsapp_delivery`, see whatsapp/delivery-store.ts) and nothing else: no
// Prisma domain model, no Medusa, no kernel-governed resource, no
// customer-visible state, no NATS mutation. It is pure trace/telemetry, so the
// system-actor envelope rule (`buildSystemEnvelope()` for system-driven
// MUTATIONS) has nothing to adjudicate here. The governed act — the send —
// was already adjudicated upstream at `twilioAdjudicated.messages.create`.
//
// ── Callback URL configuration ──────────────────────────────────────────────
//
// `TWILIO_STATUS_CALLBACK_URL` is the exact public URL Twilio posts to,
// configured on the Twilio sender / Messaging Service (exactly like
// `TWILIO_WEBHOOK_URL` for inbound). It is used HERE for signature
// verification only — the send payload is untouched, so send behaviour is
// unchanged (LE2-030 AC5). Twilio signs the URL verbatim: no proxy rewrite, no
// query string, and http/https must match byte-for-byte or every callback is
// rejected with 403.
//
// ── Always 200 ──────────────────────────────────────────────────────────────
//
// After a valid signature the route ALWAYS answers 200. A non-2xx makes Twilio
// retry the callback, and there is nothing a retry can fix for an unknown SID
// or an unreachable trace store — a retry storm against a degraded store is
// strictly worse than a logged no-op. Malformed/unsigned requests still get
// 4xx/5xx (they are not Twilio's retries; they are rejections).

import { parse as parseQuerystring } from "node:querystring";
import type { FastifyInstance } from "fastify";
import {
  normalizeWhatsAppStatus,
  recordDeliveryStatus,
} from "../whatsapp/delivery-store.js";
import { verifyTwilioSignature } from "./whatsapp-webhook.js";

/** The subset of Twilio's status-callback form params this route reads. */
interface TwilioStatusCallbackBody {
  MessageSid?: string;
  MessageStatus?: string;
  SmsStatus?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
}

/** Path Twilio is configured to POST delivery events to. */
export const WHATSAPP_STATUS_CALLBACK_PATH = "/api/webhooks/whatsapp/status";

/** Bound the free-text Twilio error message before it reaches the store. */
const MAX_ERROR_MESSAGE = 500;

export async function whatsappStatusCallbackRoutes(server: FastifyInstance): Promise<void> {
  // Scope the form-urlencoded parser to this route only (Fastify encapsulated
  // plugin) — same shape as whatsapp-webhook.ts, which owns the identical
  // parser for the inbound path.
  await server.register(async function whatsappStatusCallbackPlugin(scoped) {
    scoped.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer", bodyLimit: 64_000 },
      (_req, body, done) => {
        try {
          done(null, parseQuerystring((body as Buffer).toString("utf-8")));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    scoped.post(
      WHATSAPP_STATUS_CALLBACK_PATH,
      {
        schema: {
          tags: ["webhooks"],
          summary: "Twilio WhatsApp delivery-status callback",
        },
      },
      async (request, reply) => {
        const body = (request.body ?? {}) as TwilioStatusCallbackBody;

        // ── 1. Verify Twilio signature (the inbound webhook's own function) ──
        const signatureError = verifyTwilioSignature(
          request,
          body as Record<string, unknown>,
          {
            webhookUrl: process.env.TWILIO_STATUS_CALLBACK_URL,
            logTag: "whatsapp.status",
            urlEnvVar: "TWILIO_STATUS_CALLBACK_URL",
          },
        );
        if (signatureError) {
          server.log.warn({ ip: request.ip }, signatureError.logMessage);
          return reply.code(signatureError.code).send({ error: signatureError.error });
        }

        // ── 2. Correlate by SID + normalize the status ───────────────────────
        const messageSid = typeof body.MessageSid === "string" ? body.MessageSid : "";
        // Twilio sends `MessageStatus` on the Messages API; `SmsStatus` is the
        // legacy alias still present on some callback shapes. Accept both.
        const status = normalizeWhatsAppStatus(body.MessageStatus ?? body.SmsStatus);

        if (messageSid.length === 0 || status === null) {
          // Not a Twilio retry candidate — the payload itself is unusable.
          server.log.warn(
            {
              component: "whatsapp",
              event: "status_callback_malformed",
              message_sid: messageSid || null,
              raw_status: body.MessageStatus ?? body.SmsStatus ?? null,
            },
            "[whatsapp.status] Missing MessageSid or unrecognized MessageStatus",
          );
          return reply.code(400).send({ error: "Missing or unrecognized status fields" });
        }

        // ── 3. Fold onto the send row (never throws) ─────────────────────────
        const errorMessage =
          typeof body.ErrorMessage === "string" && body.ErrorMessage.length > 0
            ? body.ErrorMessage.slice(0, MAX_ERROR_MESSAGE)
            : null;
        const outcome = await recordDeliveryStatus({
          messageSid,
          status,
          at: new Date().toISOString(),
          errorCode: typeof body.ErrorCode === "string" && body.ErrorCode.length > 0 ? body.ErrorCode : null,
          errorMessage,
        });

        // SIGNAL: one structured line per callback so VictoriaLogs can slice
        // component:whatsapp event:status_callback. Carries no PII — SID,
        // status and Twilio's own error code only.
        server.log.info(
          {
            component: "whatsapp",
            event: "status_callback",
            message_sid: messageSid,
            status,
            outcome,
            error_code: body.ErrorCode ?? null,
          },
          outcome === "unknown"
            ? "[whatsapp.status] Callback for an unknown SID — no-op"
            : "[whatsapp.status] Delivery status recorded",
        );

        // Always 200 after a valid signature (see header).
        return reply.code(200).type("text/xml").send("<Response/>");
      },
    );
  });
}
