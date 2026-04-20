# -----------------------------------------------------------------------------
# Bootstrap — auto-populated secrets (Redis/NATS URLs, Redis password,
# Typesense API key) that don't come from .env.
# -----------------------------------------------------------------------------

resource "random_password" "redis" {
  length  = 32
  special = false
}

resource "random_password" "typesense" {
  length  = 32
  special = false
}

# Redis runs inside compose on the same host; URL always points at the
# compose service name.
resource "aws_ssm_parameter" "redis_url" {
  name  = "/ibatexas/${var.environment}/REDIS_URL"
  type  = "SecureString"
  value = "redis://:${random_password.redis.result}@redis:6379"

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "redis_password" {
  name  = "/ibatexas/${var.environment}/REDIS_PASSWORD"
  type  = "SecureString"
  value = random_password.redis.result

  tags = {
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "nats_url" {
  name  = "/ibatexas/${var.environment}/NATS_URL"
  type  = "SecureString"
  value = "nats://nats:4222"

  tags = {
    Environment = var.environment
  }
}

# TYPESENSE_API_KEY: the main secret goes through secrets.tf (set via
# `ibx infra secrets:push`) to stay compatible with local dev, but we also
# write it here so Typesense's own container reads a valid bootstrap key
# from SSM on boot. The refresh-secrets script prefers the pushed value.
resource "aws_ssm_parameter" "typesense_bootstrap_key" {
  name  = "/ibatexas/${var.environment}/TYPESENSE_BOOTSTRAP_KEY"
  type  = "SecureString"
  value = random_password.typesense.result

  tags = {
    Environment = var.environment
  }
}
