// Centralized environment configuration for apps/api.
// Validates all required env vars at import time — if any are missing
// or malformed, the server crashes immediately with a clear error.

import { z } from "zod";
import logger from "./lib/logger.js";

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Medusa — admin auth is JWT-over-emailpass using MEDUSA_ADMIN_EMAIL/PASSWORD;
  // the publishable key is auto-resolved at runtime in packages/tools/src/medusa/client.ts.
  MEDUSA_URL: z.string().url().default("http://localhost:9000"),
  MEDUSA_ADMIN_EMAIL: z.string().min(1, "MEDUSA_ADMIN_EMAIL is required"),
  MEDUSA_ADMIN_PASSWORD: z.string().min(1, "MEDUSA_ADMIN_PASSWORD is required"),

  // Admin
  ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),

  // Auth — Twilio Verify + JWT
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  // JWTSPLIT (audit): dedicated staff signing key — MUST be distinct from JWT_SECRET so a
  // leak of one tier's secret cannot forge the other (the distinctness is enforced at
  // server bootstrap; see server.ts).
  STAFF_JWT_SECRET: z.string().min(16, "STAFF_JWT_SECRET must be at least 16 characters"),
  TWILIO_ACCOUNT_SID: z.string().min(1, "TWILIO_ACCOUNT_SID is required"),
  TWILIO_AUTH_TOKEN: z.string().min(1, "TWILIO_AUTH_TOKEN is required"),
  TWILIO_VERIFY_SID: z.string().min(1, "TWILIO_VERIFY_SID is required"),

  // WhatsApp channel (Step 12)
  TWILIO_WHATSAPP_NUMBER: z.string().startsWith("whatsapp:").optional(),
  // D-AUTHURL: TWILIO_WEBHOOK_URL must be the EXACT public URL Twilio posts to —
  // it is fed verbatim into Twilio's X-Twilio-Signature HMAC (over base URL +
  // sorted POST params). Any deviation breaks signature verification in
  // routes/whatsapp-webhook.ts. Assert the two foot-guns that silently fail:
  //   • no query string — Twilio signs the base URL; a "?foo=bar" suffix is fatal.
  //   • https in production — http:// vs https:// must match byte-for-byte; a
  //     proxy that terminates TLS but advertises http here will mis-sign.
  // (No proxy rewrite / path transformation either — see .env.example for the
  // full contract. This refine is the startup backstop for the documented rule.)
  TWILIO_WEBHOOK_URL: z
    .string()
    .url()
    .refine((u) => !new URL(u).search, {
      message:
        "TWILIO_WEBHOOK_URL must not include a query string — Twilio signs the base URL; a ?query suffix breaks X-Twilio-Signature verification",
    })
    .refine((u) => process.env.NODE_ENV !== "production" || new URL(u).protocol === "https:", {
      message:
        "TWILIO_WEBHOOK_URL must use https:// in production — the protocol is part of the signed URL and must match what Twilio posts byte-for-byte",
    })
    .optional(),

  // Payments — Stripe
  STRIPE_SECRET_KEY: z.string().min(1, "STRIPE_SECRET_KEY is required"),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, "STRIPE_WEBHOOK_SECRET is required"),

  // CORS
  WEB_URL: z.string().url().optional(),
  CORS_ORIGIN: z.string().optional(),

  // Restaurant
  RESTAURANT_TIMEZONE: z.string().default("America/Sao_Paulo"),
  NO_SHOW_GRACE_MINUTES: z.coerce.number().int().positive().default(15),

  // Critical infrastructure env vars — fail-fast if missing
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  NATS_URL: z.string().min(1, "NATS_URL is required"),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const missing = result.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  logger.error({ missing }, "[config] Missing or invalid environment variables");
  // Fail fast: a malformed config must HALT, never silently fall through to an
  // unvalidated `process.env` cast (whose values are all string|undefined and do
  // NOT satisfy the parsed/coerced schema). In non-test runtime exit the process;
  // the throw is a hard backstop so we never export a malformed config even if
  // process.exit is stubbed (and gives tests a clear failure if they import this
  // module without a complete env, instead of an object that lies about its types).
  if (process.env.NODE_ENV !== "test") {
    process.exit(1);
  }
  throw new Error(`[config] Invalid environment configuration:\n${missing}`);
}

// `result.success` is true here, so `result.data` is the fully-parsed, typed and
// defaulted config — no casting.
export const config: z.infer<typeof envSchema> = result.data;
