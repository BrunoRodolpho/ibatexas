// Auth routes — Twilio Verify WhatsApp OTP + JWT
//
// POST /api/auth/send-otp    — trigger OTP via Twilio Verify (WhatsApp)
// POST /api/auth/verify-otp  — verify code, upsert Customer, issue JWT cookie
// POST /api/auth/logout      — clear JWT cookie
// GET  /api/auth/me          — return current customer from JWT

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import twilio from "twilio";
import { createHash } from "node:crypto";
import { prisma } from "@ibatexas/domain";
import { getRedisClient, rk } from "@ibatexas/tools";
import { requireAuth } from "../middleware/auth.js";

// ── Twilio client ─────────────────────────────────────────────────────────────

function twilioClient(): ReturnType<typeof twilio> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !auth) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set");
  return twilio(sid, auth);
}

function verifySid(): string {
  const sid = process.env.TWILIO_VERIFY_SID;
  if (!sid) throw new Error("TWILIO_VERIFY_SID not set");
  return sid;
}

function otpChannel(): "sms" | "whatsapp" {
  const ch = process.env.TWILIO_OTP_CHANNEL ?? "sms";
  if (ch !== "sms" && ch !== "whatsapp") {
    throw new Error(`TWILIO_OTP_CHANNEL must be "sms" or "whatsapp", got "${ch}"`);
  }
  return ch;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** One-way hash of a phone number — safe to log. */
function phoneHash(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 12);
}

// Validate E.164 format (+55 11 999999999)
const PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, "Telefone inválido — use formato internacional: +5511999999999");

// ── Zod schemas ───────────────────────────────────────────────────────────────

const SendOtpBody = z.object({
  phone: PhoneSchema,
});

const VerifyOtpBody = z.object({
  phone: PhoneSchema,
  code: z.string().regex(/^\d{6}$/, "Código inválido — deve ter 6 dígitos"),
  name: z.string().max(100).optional(),
});

const MeResponse = z.object({
  id: z.string(),
  phone: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  medusaId: z.string().nullable(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export async function authRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── POST /api/auth/send-otp ─────────────────────────────────────────────────

  app.post(
    "/api/auth/send-otp",
    {
      schema: {
        tags: ["auth"],
        summary: "Enviar OTP via WhatsApp",
        body: SendOtpBody,
      },
    },
    async (request, reply) => {
      const { phone } = request.body;
      const hash = phoneHash(phone);
      const ip = request.ip;

      server.log.info({ phone_hash: hash, ip, action: "send_otp" }, "OTP send requested");

      // Rate limit: max 3 sends per phone per 10 min
      const redis = await getRedisClient();
      const rateLimitKey = rk(`otp:rate:${hash}`);
      const count = await redis.incr(rateLimitKey);
      if (count === 1) {
        await redis.expire(rateLimitKey, 600); // 10 min
      }
      if (count > 3) {
        server.log.warn({ phone_hash: hash, ip, action: "send_otp_rate_limited" }, "OTP send rate limited");
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Muitas tentativas. Aguarde 10 minutos.",
        });
      }

      try {
        await twilioClient().verify.v2
          .services(verifySid())
          .verifications.create({ to: phone, channel: otpChannel() });
      } catch (err) {
        server.log.error({ phone_hash: hash, ip, action: "send_otp_error", err }, "Twilio error");
        return reply.code(502).send({
          statusCode: 502,
          error: "Bad Gateway",
          message: "Não foi possível enviar o código. Tente novamente.",
        });
      }

      return reply.code(200).send({ ok: true });
    },
  );

  // ── POST /api/auth/verify-otp ───────────────────────────────────────────────

  app.post(
    "/api/auth/verify-otp",
    {
      schema: {
        tags: ["auth"],
        summary: "Verificar código OTP e autenticar",
        body: VerifyOtpBody,
      },
    },
    async (request, reply) => {
      const { phone, code, name } = request.body;
      const hash = phoneHash(phone);
      const ip = request.ip;

      // Track consecutive failures
      const redis = await getRedisClient();
      const failKey = rk(`otp:fail:${hash}`);

      // Block brute-force: reject after 5 failed attempts per phone per hour
      const currentFails = await redis.get(failKey);
      if (currentFails && parseInt(currentFails, 10) >= 5) {
        server.log.warn(
          { action: "otp_brute_force_blocked", phone_hash: hash, ip },
          "OTP verify blocked — too many failures",
        );
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Muitas tentativas. Aguarde 1 hora.",
        });
      }

      let verification: { status: string };
      try {
        verification = await twilioClient().verify.v2
          .services(verifySid())
          .verificationChecks.create({ to: phone, code });
      } catch (err: unknown) {
        const twilioErr = err as { code?: number; status?: number; message?: string };
        server.log.error({ phone_hash: hash, ip, action: "verify_otp_error", err });

        // 20404 = no pending verification for this phone (expired or never sent)
        if (twilioErr.code === 20404) {
          return reply.code(400).send({
            statusCode: 400,
            error: "Bad Request",
            message: "Código expirado ou não encontrado. Solicite um novo código.",
          });
        }

        return reply.code(502).send({
          statusCode: 502,
          error: "Bad Gateway",
          message: "Erro ao verificar código. Tente novamente.",
        });
      }

      if (verification.status !== "approved") {
        const failCount = await redis.incr(failKey);
        await redis.expire(failKey, 3600); // 1h
        server.log.info(
          { phone_hash: hash, ip, action: "verify_otp", success: false, attempt_count: failCount },
          "OTP verification failed",
        );
        if (failCount >= 5) {
          server.log.warn(
            { action: "otp_abuse_suspected", phone_hash: hash, ip },
            "Possible OTP abuse detected",
          );
        }
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "Código inválido ou expirado.",
        });
      }

      // Clear failure counter on success
      await redis.del(failKey);

      // Upsert customer
      const customer = await prisma.customer.upsert({
        where: { phone },
        create: { phone, name: name ?? null },
        update: { ...(name ? { name } : {}) },
      });

      server.log.info(
        { phone_hash: hash, ip, action: "verify_otp", success: true, customer_id: customer.id },
        "OTP verified — customer authenticated",
      );

      // Issue JWT
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) throw new Error("JWT_SECRET not set");

      const token = (server as unknown as { jwt: { sign: (payload: object, options?: { expiresIn: string }) => string } }).jwt.sign({
        sub: customer.id,
        userType: "customer",
      }, { expiresIn: '24h' });

      const isProduction = process.env.NODE_ENV === "production";
      return reply
        .setCookie("token", token, {
          httpOnly: true,
          secure: isProduction,
          sameSite: "lax",
          path: "/",
          maxAge: 24 * 60 * 60, // 24h
        })
        .code(200)
        .send({
          id: customer.id,
          phone: customer.phone,
          name: customer.name,
          email: customer.email,
        });
    },
  );

  // ── POST /api/auth/logout ───────────────────────────────────────────────────

  app.post(
    "/api/auth/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Logout — limpar cookie de sessão",
      },
    },
    async (_request, reply) => {
      return reply
        .clearCookie("token", { path: "/" })
        .code(200)
        .send({ ok: true });
    },
  );

  // ── GET /api/auth/me ────────────────────────────────────────────────────────

  app.get(
    "/api/auth/me",
    {
      schema: {
        tags: ["auth"],
        summary: "Retornar dados do cliente autenticado",
        response: { 200: MeResponse },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customer = await prisma.customer.findUniqueOrThrow({
        where: { id: request.customerId },
      });
      return reply.send({
        id: customer.id,
        phone: customer.phone,
        name: customer.name,
        email: customer.email,
        medusaId: customer.medusaId,
      });
    },
  );
}
