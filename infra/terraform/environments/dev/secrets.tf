# -----------------------------------------------------------------------------
# SSM Parameter Store — env secrets
#
# For dev: SSM Parameter Store (free for standard SecureString params, up to
# 10k) instead of Secrets Manager ($0.40/secret/mo = $6/mo for 15 secrets).
#
# Values are NOT managed by terraform — they're pushed by `ibx infra
# secrets:push`. Terraform only owns the parameter NAMES (placeholders).
# -----------------------------------------------------------------------------

locals {
  # Names kept in sync with apps/api expectations. If you rename or add a
  # secret here, also update `ibx infra secrets:*` and the app config.
  secret_names = [
    "JWT_SECRET",
    "COOKIE_SECRET",
    "DATABASE_URL",
    "SENTRY_DSN",
    "ANTHROPIC_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_VERIFY_SID",
    "MEDUSA_ADMIN_EMAIL",
    "MEDUSA_ADMIN_PASSWORD",
    "TYPESENSE_API_KEY",
    "CORS_ORIGIN",
  ]
}

resource "aws_ssm_parameter" "secret" {
  for_each = toset(local.secret_names)

  name  = "/ibatexas/${var.environment}/${each.value}"
  type  = "SecureString"
  value = "__placeholder__"

  description = "${each.value} for ibatexas ${var.environment} — value set via `ibx infra secrets:push`"

  # Real values come from `ibx infra secrets:push`, not terraform.
  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Environment = var.environment
  }
}
