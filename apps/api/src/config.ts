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

  // Medusa
  MEDUSA_URL: z.string().url().default("http://localhost:9000"),
  MEDUSA_API_KEY: z.string().min(1, "MEDUSA_API_KEY is required"),
  MEDUSA_PUBLISHABLE_KEY: z.string().default(""),

  // Admin
  ADMIN_API_KEY: z.string().min(1, "ADMIN_API_KEY is required"),

  // Auth — Twilio Verify + JWT
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  TWILIO_ACCOUNT_SID: z.string().min(1, "TWILIO_ACCOUNT_SID is required"),
  TWILIO_AUTH_TOKEN: z.string().min(1, "TWILIO_AUTH_TOKEN is required"),
  TWILIO_VERIFY_SID: z.string().min(1, "TWILIO_VERIFY_SID is required"),

  // WhatsApp channel (Step 12)
  TWILIO_WHATSAPP_NUMBER: z.string().startsWith("whatsapp:").optional(),
  TWILIO_WEBHOOK_URL: z.string().url().optional(),

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
  // Don't crash in test environment — tests set env vars dynamically
  if (process.env.NODE_ENV !== "test") {
    process.exit(1);
  }
}

// Export with fallbacks for test environment where validation may fail
export const config = result.success ? result.data : (process.env as unknown as z.infer<typeof envSchema>);
