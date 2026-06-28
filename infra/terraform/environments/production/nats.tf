# -----------------------------------------------------------------------------
# NATS — ECS Fargate service + Cloud Map service discovery
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "nats" {
  name              = "/ecs/ibatexas/${var.environment}/nats"
  retention_in_days = 14

  tags = {
    Environment = var.environment
  }
}

# T3-10 — NATS server-side authentication (docs/security/NATS-AUTH-REQUIREMENTS.md).
#
# MIRROR of infra/nats/nats-server.app.conf — KEEP IN SYNC. ECS Fargate cannot
# mount a repo file into the task, so the container entrypoint writes the
# config to /tmp before exec'ing nats-server. The single-quoted CONF heredoc
# keeps the shell from expanding $NATS_APP_NKEY_PUBLIC — the NATS server
# resolves it from the container environment at boot (injected from Secrets
# Manager below) and FAILS TO START when it is unset (fail-closed).
#
# Operator prerequisite before deploy: mint a user nkey pair
# (scripts/nats/gen-nkey-user.mjs) and set the two secrets —
#   ibatexas/<env>/NATS_APP_NKEY_PUBLIC  (this task)
#   ibatexas/<env>/NATS_NKEY_SEED        (app tasks — see ecs.tf service_secrets)
locals {
  nats_bootstrap_command = <<-EOT
    cat > /tmp/nats-server.conf <<'CONF'
    port: 4222
    http_port: 8222

    jetstream {
      store_dir: /data
    }

    accounts {
      IBX: {
        jetstream: enabled
        users: [
          { nkey: $NATS_APP_NKEY_PUBLIC }
        ]
      }
    }
    CONF
    exec nats-server -c /tmp/nats-server.conf
  EOT
}

resource "aws_ecs_task_definition" "nats" {
  family                   = "ibatexas-${var.environment}-nats"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  # Persist the JetStream store to EFS (mounted at /data, matching store_dir
  # above) so it survives Fargate task replacement.
  volume {
    name = "nats-data"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.nats.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.nats.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([{
    name       = "nats"
    image      = "nats:2.11-alpine"
    essential  = true
    entryPoint = ["/bin/sh", "-c"]
    command    = [local.nats_bootstrap_command]

    secrets = [
      {
        name      = "NATS_APP_NKEY_PUBLIC"
        valueFrom = aws_secretsmanager_secret.this["NATS_APP_NKEY_PUBLIC"].arn
      }
    ]

    portMappings = [
      { containerPort = 4222, protocol = "tcp" },
      { containerPort = 8222, protocol = "tcp" }
    ]

    mountPoints = [{
      sourceVolume  = "nats-data"
      containerPath = "/data"
      readOnly      = false
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/ibatexas/${var.environment}/nats"
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "nats"
      }
    }
  }])

  tags = {
    Environment = var.environment
  }
}

resource "aws_ecs_service" "nats" {
  name            = "ibatexas-${var.environment}-nats"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.nats.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.nats.id]
    assign_public_ip = true # Required for default VPC (no NAT gateway)
  }

  service_registries {
    registry_arn = aws_service_discovery_service.nats.arn
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_service_discovery_service" "nats" {
  name = "nats"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# Auto-populate NATS_URL secret with Cloud Map DNS
resource "aws_secretsmanager_secret_version" "nats_url" {
  secret_id     = aws_secretsmanager_secret.this["NATS_URL"].id
  secret_string = "nats://nats.ibatexas.local:4222"
}

# --- NATS Security Group ---

resource "aws_security_group" "nats" {
  name        = "ibatexas-${var.environment}-nats"
  description = "Allow NATS from ECS tasks"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name        = "ibatexas-${var.environment}-nats"
    Environment = var.environment
  }
}

resource "aws_vpc_security_group_ingress_rule" "nats_from_ecs" {
  security_group_id            = aws_security_group.nats.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 4222
  to_port                      = 4222
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "nats_all" {
  security_group_id = aws_security_group.nats.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
