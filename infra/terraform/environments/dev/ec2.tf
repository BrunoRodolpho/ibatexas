# -----------------------------------------------------------------------------
# EC2 — single Spot t4g.small running the full app under Docker Compose
# -----------------------------------------------------------------------------

resource "aws_eip" "host" {
  domain = "vpc"

  tags = {
    Name        = "ibatexas-${var.environment}-host"
    Environment = var.environment
  }
}

locals {
  # Render compose.yml FIRST with region/account/domain substituted in.
  rendered_compose = templatefile("${path.module}/compose.yml.tpl", {
    region     = var.region
    account_id = data.aws_caller_identity.current.account_id
    domain     = var.domain_name
  })

  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    region       = var.region
    account_id   = data.aws_caller_identity.current.account_id
    environment  = var.environment
    domain       = var.domain_name
    ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
    compose_yml  = local.rendered_compose
    caddyfile    = file("${path.module}/caddyfile.tpl")
    secret_names = jsonencode(local.secret_names)
  })
}

resource "aws_instance" "host" {
  ami           = data.aws_ssm_parameter.al2023_arm64.value
  instance_type = var.instance_type

  # Spot pricing — ~70% cheaper. "stop" behavior preserves EBS on interruption;
  # instance resumes when capacity returns.
  instance_market_options {
    market_type = "spot"
    spot_options {
      instance_interruption_behavior = "stop"
      spot_instance_type             = "persistent"
    }
  }

  iam_instance_profile = aws_iam_instance_profile.host.name

  vpc_security_group_ids      = [aws_security_group.host.id]
  subnet_id                   = data.aws_subnets.default.ids[0]
  associate_public_ip_address = true

  user_data                   = local.user_data
  user_data_replace_on_change = false

  root_block_device {
    volume_size           = var.ebs_size_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tags = {
    Name        = "ibatexas-${var.environment}-host"
    Role        = "ibatexas-${var.environment}-host" # CI uses this to find the instance
    Environment = var.environment
  }

  lifecycle {
    # SSM-managed AMI updates would otherwise trigger a replace on every plan.
    # Bump this by deleting state or `taint` when a new AL2023 base is wanted.
    ignore_changes = [ami]
  }
}

resource "aws_eip_association" "host" {
  instance_id   = aws_instance.host.id
  allocation_id = aws_eip.host.id
}
