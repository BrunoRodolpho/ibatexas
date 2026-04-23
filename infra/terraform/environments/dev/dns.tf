# -----------------------------------------------------------------------------
# Route53 — Hosted zone + A records pointing at the EC2 Elastic IP
#
# The zone's nameservers must match what's registered at the domain registrar
# (Registro.br). Every destroy/recreate cycle makes AWS assign a fresh NS set,
# so the lifecycle guard below exists to stop `ibx destroy` from wiping the
# zone and forcing a manual registrar update.
#
# To rotate NS intentionally: flip prevent_destroy to false, apply, destroy,
# then re-enter the new NS at Registro.br.
# -----------------------------------------------------------------------------

resource "aws_route53_zone" "this" {
  name = var.domain_name

  tags = {
    Environment = var.environment
  }

  # Registrar NS update is a manual, slow (1-24h propagation) step. Keeping
  # the zone alive across teardowns keeps the NS stable.
  lifecycle {
    prevent_destroy = true
  }
}

# Root: ibatexas.com.br → EC2 host
resource "aws_route53_record" "root" {
  zone_id = aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 60
  records = [aws_eip.host.public_ip]
}

# api.ibatexas.com.br → EC2 host
resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "api.${var.domain_name}"
  type    = "A"
  ttl     = 60
  records = [aws_eip.host.public_ip]
}

# admin.ibatexas.com.br → EC2 host
resource "aws_route53_record" "admin" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "admin.${var.domain_name}"
  type    = "A"
  ttl     = 60
  records = [aws_eip.host.public_ip]
}

# commerce.ibatexas.com.br → EC2 host (Medusa backend + /app admin UI)
resource "aws_route53_record" "commerce" {
  zone_id = aws_route53_zone.this.zone_id
  name    = "commerce.${var.domain_name}"
  type    = "A"
  ttl     = 60
  records = [aws_eip.host.public_ip]
}
