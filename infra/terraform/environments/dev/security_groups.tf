# -----------------------------------------------------------------------------
# Security Group — single SG for the EC2 host
# -----------------------------------------------------------------------------

resource "aws_security_group" "host" {
  name        = "ibatexas-${var.environment}-host"
  description = "Allow HTTP/HTTPS from internet; optional SSH for debugging"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name        = "ibatexas-${var.environment}-host"
    Environment = var.environment
  }
}

resource "aws_vpc_security_group_ingress_rule" "host_http" {
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP (redirected to HTTPS by Caddy + Let's Encrypt challenge)"
}

resource "aws_vpc_security_group_ingress_rule" "host_https" {
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS"
}

# Optional SSH ingress — only created if var.ssh_cidr is non-empty.
# Prefer SSM Session Manager: `aws ssm start-session --target <instance-id>`.
resource "aws_vpc_security_group_ingress_rule" "host_ssh" {
  count             = var.ssh_cidr == "" ? 0 : 1
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = var.ssh_cidr
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
  description       = "SSH (debug only)"
}

resource "aws_vpc_security_group_egress_rule" "host_all" {
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
