# -----------------------------------------------------------------------------
# Route53 — Hosted zone + A records pointing at the EC2 Elastic IP
#
# The zone was destroyed during the Fargate teardown. After `terraform apply`,
# the output `route53_nameservers` will show new NS records; update them at
# the domain registrar (Registro.br / wherever ibatexas.com.br is registered)
# before expecting DNS to resolve.
# -----------------------------------------------------------------------------

resource "aws_route53_zone" "this" {
  name = var.domain_name

  tags = {
    Environment = var.environment
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
