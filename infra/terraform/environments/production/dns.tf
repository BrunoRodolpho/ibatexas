# -----------------------------------------------------------------------------
# Route53 — Hosted zone + A records (alias to ALB)
# -----------------------------------------------------------------------------

resource "aws_route53_zone" "this" {
  name = var.domain_name

  # Prevent accidental destroy of the prod DNS zone (registrar NS would need resetting).
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Environment = var.environment
  }
}

# Root domain → ALB
resource "aws_route53_record" "root" {
  zone_id = aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

# api.ibatexas.com.br → ALB
resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

# admin.ibatexas.com.br → ALB
resource "aws_route53_record" "admin" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "admin.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
