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

resource "aws_ecs_task_definition" "nats" {
  family                   = "ibatexas-${var.environment}-nats"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([{
    name      = "nats"
    image     = "nats:2.11-alpine"
    essential = true
    command   = ["--jetstream", "--store_dir", "/data", "-m", "8222"]

    portMappings = [
      { containerPort = 4222, protocol = "tcp" },
      { containerPort = 8222, protocol = "tcp" }
    ]

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
