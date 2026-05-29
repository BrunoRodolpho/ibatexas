// WhatsApp webhook — thin delegate over the @claustrum/* Conductor.
//
// Was 586 LOC of signature-verify + idempotency + rate-limit + shortcut +
// state-machine + async agent orchestration. The claustrum cutover keeps
// the security envelope (signature, idempotency, rate limit, debounce) but
// hands the conversational logic to:
//
//   wa.perceive(rawBody)        → ChannelMessage
//   conductor.openCapsule({...}) → Capsule
//   handleTurn(capsule, msg)    → TurnResult { response, decision, audit }
//   wa.render(turn.response)    → outbound Twilio messages
//
// Returns 200 to Twilio synchronously; conductor work is fired-and-forgotten
// (same lifecycle as before — Twilio's webhook contract requires <15s, and
// the agent can take much longer in the worst case).

import { parse as parseQuerystring } from "node:querystring";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyTwilioSignature, type TwilioWebhookBody } from "@claustrum/channel-whatsapp";
import type { ChannelMessage } from "@claustrum/core";
import { handleTurn } from "@claustrum/core";
import { getRedisClient, rk, atomicIncr } from "@ibatexas/tools";
import { getConductor } from "../claustrum-bootstrap.js";
import { hashPhone } from "../lib/phone-hash.js";

const MAX_RATE_PER_MINUTE = 20;

// ── Signature verification (uses @claustrum/channel-whatsapp helper) ─────────

interface SignatureError {
  code: number;
  error: string;
  logMessage: string;
}

function verifySig(request: FastifyRequest, body: TwilioWebhookBody): SignatureError | null {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const webhookUrl = process.env.TWILIO_WEBHOOK_URL;
  if (!authToken || !webhookUrl) {
    return { code: 500, error: "Webhook not configured", logMessage: "TWILIO_AUTH_TOKEN or TWILIO_WEBHOOK_URL not set" };
  }
  const signature = request.headers["x-twilio-signature"];
  if (typeof signature !== "string") {
    return { code: 400, error: "Missing signature", logMessage: "Missing X-Twilio-Signature" };
  }
  const ok = verifyTwilioSignature({
    signature,
    url: webhookUrl,
    params: body as Record<string, string | undefined>,
    authToken,
  });
  if (!ok) {
    return { code: 403, error: "Invalid signature", logMessage: "Invalid Twilio signature" };
  }
  return null;
}

// ── Idempotency + rate-limit (unchanged, Redis-keyed) ───────────────────────

async function checkIdempotency(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  messageSid: string,
): Promise<boolean> {
  const key = rk(`wa:webhook:${messageSid}`);
  const wasSet = await redis.set(key, "1", { EX: 86400, NX: true });
  return !wasSet;
}

async function checkRateLimit(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  fromPhone: string,
): Promise<boolean> {
  // Keyed HMAC, full-length — centralized in ../lib/phone-hash.ts. (The legacy
  // whatsapp/session.ts module re-exports the same helper.)
  const hash = hashPhone(fromPhone);
  const key = rk(`wa:rate:${hash}`);
  const count = await atomicIncr(redis, key, 60);
  return count > MAX_RATE_PER_MINUTE;
}

// ── Route registration ───────────────────────────────────────────────────────

export async function whatsappWebhookRoutes(server: FastifyInstance): Promise<void> {
  await server.register(async function whatsappWebhookPlugin(scoped) {
    scoped.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer", bodyLimit: 1_048_576 },
      (_req, body, done) => {
        try {
          const parsed = parseQuerystring((body as Buffer).toString("utf-8"));
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    scoped.post(
      "/api/webhooks/whatsapp",
      {
        schema: {
          tags: ["webhooks"],
          summary: "Twilio WhatsApp incoming message webhook",
        },
      },
      async (request, reply) => {
        const body = request.body as TwilioWebhookBody;

        const sigError = verifySig(request, body);
        if (sigError) {
          server.log.warn({ ip: request.ip }, sigError.logMessage);
          return reply.code(sigError.code).send({ error: sigError.error });
        }

        const messageSid = body.MessageSid;
        const fromRaw = body.From;
        const messageBody = (body.Body ?? "").trim();
        const numMedia = Number.parseInt(body.NumMedia ?? "0", 10);
        const hasLocation = body.Latitude !== undefined && body.Longitude !== undefined;

        if (!messageBody && numMedia === 0 && !hasLocation) {
          return reply.code(200).type("text/xml").send("<Response/>");
        }
        if (!messageSid || !fromRaw) {
          return reply.code(400).send({ error: "Missing required fields" });
        }

        const redis = await getRedisClient();
        if (await checkIdempotency(redis, messageSid)) {
          return reply.code(200).type("text/xml").send("<Response/>");
        }
        if (await checkRateLimit(redis, fromRaw)) {
          return reply.code(429).type("text/xml").send("<Response/>");
        }

        // Twilio expects synchronous 200; agent runs async.
        void reply.code(200).type("text/xml").send("<Response/>");
        void handleInboundAsync(body, server.log).catch((err) => {
          server.log.error(err, "[whatsapp.async] Conductor turn failed");
        });
        return reply;
      },
    );
  });
}

// ── Async turn (conductor delegation) ────────────────────────────────────────

type LogFn = {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

async function handleInboundAsync(body: TwilioWebhookBody, log: LogFn): Promise<void> {
  try {
    const conductor = getConductor();
    const wa = conductor.channels.whatsapp;
    if (!wa) {
      log.error("[whatsapp.async] No whatsapp channel registered on conductor");
      return;
    }

    // 1. PERCEIVE — let the WhatsAppChannel normalize Twilio's body shape.
    const inbound: ChannelMessage = await wa.perceive(body);

    // 2. Open capsule (tenant resolution + session load happen here).
    const capsule = await conductor.openCapsule({
      channel: "whatsapp",
      customerId: inbound.customerId,
      sessionKey: inbound.conversationId,
      inbound,
    });

    try {
      // 3. handleTurn — perceive → understand → plan → submit → act → synthesize → observe.
      const turn = await handleTurn(capsule, inbound);

      // 4. Render outbound. WhatsAppChannel.render handles chunking +
      //    Twilio API calls; we hand it the `to` via `artifacts`.
      if (turn.response.text) {
        await wa.render({
          ...turn.response,
          artifacts: [{ to: body.From }],
        });
      }
    } finally {
      await conductor.closeCapsule(capsule);
    }
  } catch (err) {
    log.error(err, "[whatsapp.async.error] Unhandled error");
  }
}
