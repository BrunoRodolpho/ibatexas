# -----------------------------------------------------------------------------
# Secrets Manager — resource declarations only, values set manually via console/CLI
# -----------------------------------------------------------------------------

locals {
  secret_names = [
    "JWT_SECRET",
    "DATABASE_URL",
    "SENTRY_DSN",
    "ANTHROPIC_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_VERIFY_SID",
    "NATS_URL",
    "REDIS_URL",
    "MEDUSA_ADMIN_EMAIL",
    "MEDUSA_ADMIN_PASSWORD",
    "TYPESENSE_API_KEY",
    "CORS_ORIGIN",
    # T3-10 — NATS server-side auth (docs/security/NATS-AUTH-REQUIREMENTS.md).
    # One per-environment user nkey pair (mint with
    # scripts/nats/gen-nkey-user.mjs): the SEED is the client credential the
    # api task reads (@ibatexas/nats-client); the PUBLIC key is written into
    # the NATS server config by the nats task entrypoint (nats.tf). Set both
    # values BEFORE deploying — the nats server fails to start without its
    # public key, and the api fails-closed without auth in production.
    "NATS_NKEY_SEED",
    "NATS_APP_NKEY_PUBLIC",
  ]
}

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(local.secret_names)

  name        = "ibatexas/${var.environment}/${each.value}"
  description = "${each.value} for ibatexas ${var.environment}"

  tags = {
    Environment = var.environment
  }
}
