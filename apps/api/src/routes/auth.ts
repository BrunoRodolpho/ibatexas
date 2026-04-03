// Auth routes — Twilio Verify WhatsApp OTP + JWT + Refresh Tokens
//
// POST /api/auth/send-otp    — trigger OTP via Twilio Verify (WhatsApp)
// POST /api/auth/verify-otp  — verify code, upsert Customer, issue JWT + refresh cookies
// POST /api/auth/refresh     — rotate refresh token, issue new JWT
// POST /api/auth/logout      — revoke JWT, delete refresh token, clear cookies
// GET  /api/auth/me          — return current customer from JWT

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import twilio from "twilio";
import { createHash, randomUUID } from "node:crypto";
import { createCustomerService, createStaffService } from "@ibatexas/domain";
import { getRedisClient, rk, atomicIncr } from "@ibatexas/tools";
import { requireAuth, optionalAuth } from "../middleware/auth.js";

// ── Twilio client ─────────────────────────────────────────────────────────────

// Customer Twilio account
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

// Staff/Admin Twilio account — falls back to customer account if not set
function staffTwilioClient(): ReturnType<typeof twilio> {
  const sid = process.env.TWILIO_STAFF_ACCOUNT_SID ?? process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_STAFF_AUTH_TOKEN ?? process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !auth) throw new Error("TWILIO_STAFF_ACCOUNT_SID / TWILIO_STAFF_AUTH_TOKEN (or TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) not set");
  return twilio(sid, auth);
}

function staffVerifySid(): string {
  const sid = process.env.TWILIO_STAFF_VERIFY_SID ?? process.env.TWILIO_VERIFY_SID;
  if (!sid) throw new Error("TWILIO_STAFF_VERIFY_SID (or TWILIO_VERIFY_SID) not set");
  return sid;
}

function staffOtpChannel(): "sms" | "whatsapp" {
  const ch = process.env.TWILIO_STAFF_OTP_CHANNEL ?? process.env.TWILIO_OTP_CHANNEL ?? "sms";
  if (ch !== "sms" && ch !== "whatsapp") {
    throw new Error(`TWILIO_STAFF_OTP_CHANNEL must be "sms" or "whatsapp", got "${ch}"`);
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

// ── Rate-limit helpers ────────────────────────────────────────────────────────

interface RateLimitResult {
  exceeded: boolean;
  count: number;
}

async function checkIpRateLimit(ip: string): Promise<RateLimitResult> {
  const redis = await getRedisClient();
  const key = rk(`otp:ip:${ip}`);
  const count = await atomicIncr(redis, key, 3600); // 1 hour
  return { exceeded: count > 10, count };
}

async function checkSendRateLimit(hash: string): Promise<RateLimitResult> {
  const redis = await getRedisClient();
  const rateLimitKey = rk(`otp:rate:${hash}`);
  const count = await atomicIncr(redis, rateLimitKey, 600); // 10 min
  return { exceeded: count > 3, count };
}

async function checkBruteForce(hash: string): Promise<boolean> {
  const redis = await getRedisClient();
  const failKey = rk(`otp:fail:${hash}`);
  const currentFails = await redis.get(failKey);
  return Boolean(currentFails && Number.parseInt(currentFails, 10) >= 5);
}

async function recordVerifyFailure(hash: string): Promise<number> {
  const redis = await getRedisClient();
  const failKey = rk(`otp:fail:${hash}`);
  const failCount = await atomicIncr(redis, failKey, 3600); // 1h
  return failCount;
}

async function clearVerifyFailures(hash: string): Promise<void> {
  const redis = await getRedisClient();
  const failKey = rk(`otp:fail:${hash}`);
  await redis.del(failKey);
}

// ── Twilio OTP helpers ────────────────────────────────────────────────────────

async function sendTwilioOtp(phone: string): Promise<void> {
  await twilioClient().verify.v2
    .services(verifySid())
    .verifications.create({ to: phone, channel: otpChannel() });
}

interface VerifyOtpResult {
  status: string;
  twilioError?: { code?: number; status?: number; message?: string };
}

async function verifyTwilioOtp(phone: string, code: string): Promise<VerifyOtpResult> {
  try {
    const verification = await twilioClient().verify.v2
      .services(verifySid())
      .verificationChecks.create({ to: phone, code });
    return { status: verification.status };
  } catch (err: unknown) {
    return { status: "error", twilioError: err as { code?: number; status?: number; message?: string } };
  }
}

// Staff OTP — uses separate Twilio account when TWILIO_STAFF_* vars are set
async function sendStaffTwilioOtp(phone: string): Promise<void> {
  await staffTwilioClient().verify.v2
    .services(staffVerifySid())
    .verifications.create({ to: phone, channel: staffOtpChannel() });
}

async function verifyStaffTwilioOtp(phone: string, code: string): Promise<VerifyOtpResult> {
  try {
    const verification = await staffTwilioClient().verify.v2
      .services(staffVerifySid())
      .verificationChecks.create({ to: phone, code });
    return { status: verification.status };
  } catch (err: unknown) {
    return { status: "error", twilioError: err as { code?: number; status?: number; message?: string } };
  }
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

function issueJwtToken(
  server: FastifyInstance,
  customerId: string,
): string {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error("JWT_SECRET not set");

  return (server as unknown as { jwt: { sign: (payload: object, options?: { expiresIn: string }) => string } }).jwt.sign({
    sub: customerId,
    userType: "customer",
    jti: randomUUID(),
  }, { expiresIn: '4h' });
}

/** DOM-001: Issue a staff JWT with role claim. */
function issueStaffJwtToken(
  server: FastifyInstance,
  staffId: string,
  role: string,
): string {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error("JWT_SECRET not set");

  return (server as unknown as { jwt: { sign: (payload: object, options?: { expiresIn: string }) => string } }).jwt.sign({
    sub: staffId,
    userType: "staff",
    role,
    jti: randomUUID(),
  }, { expiresIn: '8h' });
}

// ── Refresh token helpers ───────────────────────────────────────────────────

const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface RefreshPayload {
  customerId: string;
  issuedAt: number;
}

async function issueRefreshToken(customerId: string): Promise<string> {
  const token = randomUUID();
  const redis = await getRedisClient();
  const payload: RefreshPayload = { customerId, issuedAt: Date.now() };
  await redis.set(rk(`refresh:${token}`), JSON.stringify(payload), { EX: REFRESH_TTL_SECONDS });
  return token;
}

async function consumeRefreshToken(token: string): Promise<RefreshPayload | null> {
  const redis = await getRedisClient();
  const key = rk(`refresh:${token}`);
  const raw = await redis.get(key);
  if (!raw) return null;
  // Delete immediately — single-use token (rotation)
  await redis.del(key);
  return JSON.parse(raw) as RefreshPayload;
}

async function deleteRefreshToken(token: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.del(rk(`refresh:${token}`));
}

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

      // IP-level rate limit — cheaper check first
      const ipLimit = await checkIpRateLimit(ip);
      if (ipLimit.exceeded) {
        server.log.warn({ ip, action: "send_otp_ip_rate_limited", count: ipLimit.count }, "OTP IP rate limited");
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Muitas tentativas deste endereço. Aguarde 1 hora.",
        });
      }

      const rateLimit = await checkSendRateLimit(hash);
      if (rateLimit.exceeded) {
        server.log.warn({ phone_hash: hash, ip, action: "send_otp_rate_limited" }, "OTP send rate limited");
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Muitas tentativas. Aguarde 10 minutos.",
        });
      }

      try {
        await sendTwilioOtp(phone);
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

      try {
        // IP rate limit on verify-otp to prevent phone-spray attacks
        const ipLimit = await checkIpRateLimit(ip);
        if (ipLimit.exceeded) {
          server.log.warn({ ip, action: "verify_otp_ip_rate_limited", count: ipLimit.count }, "OTP verify IP rate limited");
          return reply.code(429).send({
            statusCode: 429,
            error: "Too Many Requests",
            message: "Muitas tentativas deste endereço. Aguarde 1 hora.",
          });
        }

        // Block brute-force: reject after 5 failed attempts per phone per hour
        const blocked = await checkBruteForce(hash);
        if (blocked) {
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

        const verification = await verifyTwilioOtp(phone, code);

        if (verification.twilioError) {
          server.log.error({ phone_hash: hash, ip, action: "verify_otp_error", err: verification.twilioError });

          // 20404 = no pending verification for this phone (expired or never sent)
          if (verification.twilioError.code === 20404) {
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
          const failCount = await recordVerifyFailure(hash);
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
        await clearVerifyFailures(hash);

        // Upsert customer via domain service
        const customerSvc = createCustomerService();
        const customer = await customerSvc.upsertFromPhone(phone, name ?? undefined);

        server.log.info(
          { phone_hash: hash, ip, action: "verify_otp", success: true, customer_id: customer.id },
          "OTP verified — customer authenticated",
        );

        // Issue JWT + refresh token
        const token = issueJwtToken(server, customer.id);
        const refreshToken = await issueRefreshToken(customer.id);
        return reply
          .setCookie("token", token, {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
            maxAge: 4 * 60 * 60, // 4h — matches JWT expiry
          })
          .setCookie("refresh_token", refreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/api/auth/refresh",
            maxAge: REFRESH_TTL_SECONDS,
          })
          .code(200)
          .send({
            id: customer.id,
            phone: customer.phone,
            name: customer.name,
            email: customer.email,
          });
      } catch (err) {
        server.log.error({ phone_hash: hash, ip, action: "verify_otp", err }, "Unexpected error during OTP verification");
        return reply.code(500).send({
          statusCode: 500,
          error: "Internal Server Error",
          message: "Erro interno ao verificar código. Tente novamente.",
        });
      }
    },
  );

  // ── POST /api/auth/logout ───────────────────────────────────────────────────

  app.post(
    "/api/auth/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Logout — limpar cookie de sessão e revogar JWT",
      },
      preHandler: optionalAuth,
    },
    async (request, reply) => {
      // SEC-004: Revoke the JWT so it cannot be reused after logout
      try {
        const token = request.cookies?.["token"];
        if (token) {
          const jwt = server as unknown as { jwt: { decode: (t: string) => { jti?: string; exp?: number } | null } };
          const payload = jwt.jwt.decode(token);
          if (payload?.jti && payload.exp) {
            const nowSec = Math.floor(Date.now() / 1000);
            const remainingTtl = payload.exp - nowSec;
            if (remainingTtl > 0) {
              const redis = await getRedisClient();
              await redis.set(rk(`jwt:revoked:${payload.jti}`), "1", { EX: remainingTtl });
            }
          }
        }
      } catch {
        // Best-effort revocation — logout must always succeed
      }

      // AUTH-001: Delete refresh token from Redis
      try {
        const refreshToken = request.cookies?.["refresh_token"];
        if (refreshToken) {
          await deleteRefreshToken(refreshToken);
        }
      } catch {
        // Best-effort — logout must always succeed
      }

      return reply
        .clearCookie("token", { path: "/" })
        .clearCookie("refresh_token", { path: "/api/auth/refresh" })
        .code(200)
        .send({ ok: true });
    },
  );

  // ── POST /api/auth/refresh ──────────────────────────────────────────────────

  app.post(
    "/api/auth/refresh",
    {
      schema: {
        tags: ["auth"],
        summary: "Renovar sessão via refresh token (rotação automática)",
      },
    },
    async (request, reply) => {
      const refreshToken = request.cookies?.["refresh_token"];
      if (!refreshToken) {
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Refresh token ausente.",
        });
      }

      const payload = await consumeRefreshToken(refreshToken);
      if (!payload) {
        // Token expired, already used (rotation), or never existed
        return reply
          .clearCookie("token", { path: "/" })
          .clearCookie("refresh_token", { path: "/api/auth/refresh" })
          .code(401)
          .send({
            statusCode: 401,
            error: "Unauthorized",
            message: "Refresh token inválido ou expirado. Faça login novamente.",
          });
      }

      // Issue new JWT + rotated refresh token
      const newJwt = issueJwtToken(server, payload.customerId);
      const newRefreshToken = await issueRefreshToken(payload.customerId);

      server.log.info(
        { customer_id: payload.customerId, action: "token_refresh" },
        "Token refreshed",
      );

      return reply
        .setCookie("token", newJwt, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: 4 * 60 * 60,
        })
        .setCookie("refresh_token", newRefreshToken, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/api/auth/refresh",
          maxAge: REFRESH_TTL_SECONDS,
        })
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
      const customerSvc = createCustomerService();
      const customer = await customerSvc.getById(request.customerId!);
      return reply.send({
        id: customer.id,
        phone: customer.phone,
        name: customer.name,
        email: customer.email,
        medusaId: customer.medusaId,
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════════
  // DOM-001: Staff OTP Authentication
  // ══════════════════════════════════════════════════════════════════════════════

  // ── POST /api/auth/staff/send-otp ─────────────────────────────────────────

  app.post(
    "/api/auth/staff/send-otp",
    {
      schema: {
        tags: ["auth"],
        summary: "Enviar OTP para funcionário via WhatsApp",
        body: SendOtpBody,
      },
    },
    async (request, reply) => {
      const { phone } = request.body;
      const hash = phoneHash(phone);
      const ip = request.ip;

      server.log.info({ phone_hash: hash, ip, action: "staff_send_otp" }, "Staff OTP send requested");

      // IP-level rate limit
      const ipLimit = await checkIpRateLimit(ip);
      if (ipLimit.exceeded) {
        server.log.warn({ ip, action: "staff_send_otp_ip_rate_limited", count: ipLimit.count }, "Staff OTP IP rate limited");
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Muitas tentativas deste endereço. Aguarde 1 hora.",
        });
      }

      // Phone rate limit
      const rateLimit = await checkSendRateLimit(hash);
      if (rateLimit.exceeded) {
        server.log.warn({ phone_hash: hash, ip, action: "staff_send_otp_rate_limited" }, "Staff OTP send rate limited");
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Muitas tentativas. Aguarde 10 minutos.",
        });
      }

      // Verify this phone belongs to an active staff member
      const staffSvc = createStaffService();
      const staff = await staffSvc.findByPhone(phone);

      if (!staff) {
        server.log.warn({ phone_hash: hash, ip, action: "staff_send_otp_unknown" }, "Staff OTP — phone not found");
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Telefone não cadastrado como funcionário.",
        });
      }

      if (!staff.active) {
        server.log.warn({ phone_hash: hash, ip, action: "staff_send_otp_inactive" }, "Staff OTP — inactive staff");
        return reply.code(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Conta de funcionário desativada.",
        });
      }

      try {
        await sendStaffTwilioOtp(phone);
      } catch (err) {
        server.log.error({ phone_hash: hash, ip, action: "staff_send_otp_error", err }, "Twilio error");
        return reply.code(502).send({
          statusCode: 502,
          error: "Bad Gateway",
          message: "Não foi possível enviar o código. Tente novamente.",
        });
      }

      return reply.code(200).send({ ok: true });
    },
  );

  // ── POST /api/auth/staff/verify-otp ───────────────────────────────────────

  app.post(
    "/api/auth/staff/verify-otp",
    {
      schema: {
        tags: ["auth"],
        summary: "Verificar OTP de funcionário e autenticar",
        body: VerifyOtpBody,
      },
    },
    async (request, reply) => {
      const { phone, code } = request.body;
      const hash = phoneHash(phone);
      const ip = request.ip;

      // IP rate limit
      const ipLimit = await checkIpRateLimit(ip);
      if (ipLimit.exceeded) {
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Muitas tentativas deste endereço. Aguarde 1 hora.",
        });
      }

      // Brute-force protection
      const blocked = await checkBruteForce(hash);
      if (blocked) {
        server.log.warn(
          { action: "staff_otp_brute_force_blocked", phone_hash: hash, ip },
          "Staff OTP verify blocked — too many failures",
        );
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Muitas tentativas. Aguarde 1 hora.",
        });
      }

      // Verify staff exists and is active
      const staffSvc = createStaffService();
      const staff = await staffSvc.findByPhone(phone);

      if (!staff) {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Telefone não cadastrado como funcionário.",
        });
      }

      if (!staff.active) {
        return reply.code(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Conta de funcionário desativada.",
        });
      }

      const verification = await verifyStaffTwilioOtp(phone, code);

      if (verification.twilioError) {
        server.log.error({ phone_hash: hash, ip, action: "staff_verify_otp_error", err: verification.twilioError });

        if (verification.twilioError.code === 20404) {
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
        const failCount = await recordVerifyFailure(hash);
        server.log.info(
          { phone_hash: hash, ip, action: "staff_verify_otp", success: false, attempt_count: failCount },
          "Staff OTP verification failed",
        );
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "Código inválido ou expirado.",
        });
      }

      // Clear failure counter on success
      await clearVerifyFailures(hash);

      server.log.info(
        { phone_hash: hash, ip, action: "staff_verify_otp", success: true, staff_id: staff.id, role: staff.role },
        "Staff OTP verified — staff authenticated",
      );

      // Issue staff JWT (no refresh token for staff — shorter-lived sessions)
      const token = issueStaffJwtToken(server, staff.id, staff.role);
      return reply
        .setCookie("token", token, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: 8 * 60 * 60, // 8h — matches staff JWT expiry
        })
        .code(200)
        .send({
          id: staff.id,
          name: staff.name,
          role: staff.role,
        });
    },
  );
}
