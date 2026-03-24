# -----------------------------------------------------------------------------
# Secrets Manager — resource declarations only, values set manually via console/CLI
# -----------------------------------------------------------------------------

locals {
  secret_names = [
    "JWT_SECRET",
    "DATABASE_URL",
    "DIRECT_DATABASE_URL",
    "SENTRY_DSN",
    "ANTHROPIC_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_VERIFY_SID",
    "NATS_URL",
    "REDIS_URL",
    "MEDUSA_ADMIN_API_KEY",
    "MEDUSA_API_KEY",
    "MEDUSA_PUBLISHABLE_KEY",
    "TYPESENSE_API_KEY",
    "OPENAI_API_KEY",
    "COOKIE_SECRET",
    "CORS_ORIGIN",
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
