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
import {
  claimIdempotency,
  confirmProcessed,
  releaseClaim,
} from "./whatsapp-idempotency.js";

const MAX_RATE_PER_MINUTE = 20;

// ── Signature verification (uses @claustrum/channel-whatsapp helper) ─────────

interface SignatureError {
  code: number;
  error: string;
  logMessage: string;
}

function verifySig(request: FastifyRequest, body: TwilioWebhookBody): SignatureError | null {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  // D-AUTHURL: webhookUrl MUST be the exact public URL Twilio posted to — it is
  // hashed verbatim with the sorted POST params into X-Twilio-Signature. No proxy
  // rewrite, no extra query string, and http/https must match byte-for-byte, or
  // verifyTwilioSignature below rejects every request. The shape (no query, https
  // in prod) is asserted at startup in ../config.ts; see .env.example for the full
  // contract.
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

// ── Idempotency (two-phase) + rate-limit, Redis-keyed ───────────────────────
//
// The two-phase idempotency primitives (claim → confirm/release) live in
// ./whatsapp-idempotency.ts so the conductor path (handleInboundAsync) and the
// flag-OFF legacy path (whatsapp-legacy.ts) share ONE dedup-key source of truth.

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

        // Phase 1: claim with a short in-flight TTL (P2-SEC-WAIDEMPOTENCY).
        const claim = await claimIdempotency(redis, messageSid);
        if (claim === "unavailable") {
          // Fail closed: don't process unguarded. Twilio retries on non-2xx.
          server.log.error({ messageSid }, "[whatsapp] Idempotency claim unavailable — failing closed for Twilio retry");
          return reply.code(503).send({ error: "Service unavailable" });
        }
        if (claim === "duplicate") {
          return reply.code(200).type("text/xml").send("<Response/>");
        }

        if (await checkRateLimit(redis, fromRaw)) {
          // Rate-limited: release the claim so a later (slowed) retry of the SAME
          // message isn't permanently black-holed by our in-flight marker.
          await releaseClaim(redis, messageSid).catch(() => {});
          return reply.code(429).type("text/xml").send("<Response/>");
        }

        // Twilio expects synchronous 200; the conductor turn runs async. The async
        // handler owns Phase 3: promote the claim on success / release it on failure.
        void reply.code(200).type("text/xml").send("<Response/>");
        void handleInboundAsync(body, messageSid, server.log).catch((err) => {
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

// Max wall-clock for a single WhatsApp turn (P2-CONC-ABORT). A hung provider
// must not pin the turn open forever (Twilio already got its 200). Mirrors the
// 60s guard in whatsapp/formatter.ts; overridable via env (Hard Rule #3).
const WA_TURN_TIMEOUT_MS = Number.parseInt(process.env.WA_TURN_TIMEOUT_MS ?? "60000", 10);

async function handleInboundAsync(
  body: TwilioWebhookBody,
  messageSid: string,
  log: LogFn,
): Promise<void> {
  const redis = await getRedisClient();

  // Max-turn timeout (P2-CONC-ABORT). We can't thread this into the inert,
  // deferred conductor's handleTurn (its wiring must not change), so it bounds
  // the turn via Promise.race and gates the outbound render: a turn that
  // resolves after the deadline does not send a stale reply to the customer.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WA_TURN_TIMEOUT_MS);

  let succeeded = false;
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
      //    Raced against the timeout so a hung provider can't block forever.
      const turnPromise = handleTurn(capsule, inbound);
      // If the timeout wins the race, the turn promise is orphaned; swallow a
      // late rejection so it doesn't surface as an unhandledRejection.
      turnPromise.catch(() => {});
      const turn = await Promise.race([
        turnPromise,
        new Promise<never>((_, reject) => {
          if (ac.signal.aborted) reject(new Error("WhatsApp turn timed out"));
          ac.signal.addEventListener("abort", () => reject(new Error("WhatsApp turn timed out")), { once: true });
        }),
      ]);

      // 4. Render outbound. WhatsAppChannel.render handles chunking +
      //    Twilio API calls; we hand it the `to` via `artifacts`. Skip if the
      //    turn raced past the deadline — the customer shouldn't get a stale reply.
      if (turn.response.text && !ac.signal.aborted) {
        await wa.render({
          ...turn.response,
          artifacts: [{ to: body.From }],
        });
      }
      succeeded = true;
    } finally {
      await conductor.closeCapsule(capsule);
    }
  } catch (err) {
    log.error(err, "[whatsapp.async.error] Unhandled error");
  } finally {
    clearTimeout(timer);
    // Phase 3 (P2-SEC-WAIDEMPOTENCY): promote the claim on success so the SID is
    // dedup'd for the full window; on failure release it so Twilio's retry can
    // reprocess instead of being black-holed for 24h. Both best-effort — the
    // short in-flight TTL is the backstop.
    try {
      if (succeeded) {
        await confirmProcessed(redis, messageSid);
      } else {
        await releaseClaim(redis, messageSid);
      }
    } catch (err) {
      log.warn(err, "[whatsapp.async] Idempotency finalize failed (in-flight TTL is the backstop)");
    }
  }
}
