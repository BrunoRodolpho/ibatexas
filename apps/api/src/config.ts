// Centralized environment configuration for apps/api.
// Validates all required env vars at import time — if any are missing
// or malformed, the server crashes immediately with a clear error.

import { z } from "zod";

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

  // Payments — Stripe
  STRIPE_SECRET_KEY: z.string().min(1, "STRIPE_SECRET_KEY is required"),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, "STRIPE_WEBHOOK_SECRET is required"),

  // CORS
  WEB_URL: z.string().url().optional(),
  CORS_ORIGIN: z.string().optional(),

  // Restaurant
  RESTAURANT_TIMEZONE: z.string().default("America/Chicago"),
  NO_SHOW_GRACE_MINUTES: z.coerce.number().int().positive().default(15),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const missing = result.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`\n[config] Missing or invalid environment variables:\n${missing}\n`);
  // Don't crash in test environment — tests set env vars dynamically
  if (process.env.NODE_ENV !== "test") {
    process.exit(1);
  }
}

// Export with fallbacks for test environment where validation may fail
export const config = result.success ? result.data : (process.env as unknown as z.infer<typeof envSchema>);
