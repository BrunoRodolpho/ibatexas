# -----------------------------------------------------------------------------
# Typesense — ECS Fargate service + EFS persistent storage + Cloud Map
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "typesense" {
  name              = "/ecs/ibatexas/${var.environment}/typesense"
  retention_in_days = 14

  tags = {
    Environment = var.environment
  }
}

resource "aws_ecs_task_definition" "typesense" {
  family                   = "ibatexas-${var.environment}-typesense"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  volume {
    name = "typesense-data"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.typesense.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.typesense.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([{
    name      = "typesense"
    image     = "typesense/typesense:27.1"
    essential = true

    environment = [
      { name = "TYPESENSE_DATA_DIR", value = "/data" }
    ]

    secrets = [
      {
        name      = "TYPESENSE_API_KEY"
        valueFrom = aws_secretsmanager_secret.this["TYPESENSE_API_KEY"].arn
      }
    ]

    portMappings = [{ containerPort = 8108, protocol = "tcp" }]

    mountPoints = [{
      sourceVolume  = "typesense-data"
      containerPath = "/data"
      readOnly      = false
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/ibatexas/${var.environment}/typesense"
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "typesense"
      }
    }
  }])

  tags = {
    Environment = var.environment
  }
}

resource "aws_ecs_service" "typesense" {
  name            = "ibatexas-${var.environment}-typesense"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.typesense.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Typesense holds an EFS LOCK file — a second instance can't mount the same
  # data dir. Force ECS to stop the old task before starting the new one
  # (accepts ~30-60s downtime during rollout).
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.typesense.id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn = aws_service_discovery_service.typesense.arn
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_service_discovery_service" "typesense" {
  name = "typesense"

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

# --- Typesense Security Group ---

resource "aws_security_group" "typesense" {
  name        = "ibatexas-${var.environment}-typesense"
  description = "Allow Typesense from ECS tasks"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name        = "ibatexas-${var.environment}-typesense"
    Environment = var.environment
  }
}

resource "aws_vpc_security_group_ingress_rule" "typesense_from_ecs" {
  security_group_id            = aws_security_group.typesense.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 8108
  to_port                      = 8108
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "typesense_all" {
  security_group_id = aws_security_group.typesense.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
