# -----------------------------------------------------------------------------
# ECS — Fargate cluster, task definitions, services
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

# --- Cluster ---

resource "aws_ecs_cluster" "this" {
  name = "ibatexas-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Environment = var.environment
  }
}

# --- CloudWatch Log Groups ---

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/ibatexas/api"
  retention_in_days = 30

  tags = {
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/ibatexas/web"
  retention_in_days = 30

  tags = {
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "admin" {
  name              = "/ecs/ibatexas/admin"
  retention_in_days = 30

  tags = {
    Environment = var.environment
  }
}

# --- Locals for service definitions ---

locals {
  account_id = data.aws_caller_identity.current.account_id

  services = {
    api = {
      port             = 3001
      image_tag        = var.api_image_tag
      health           = "/health"
      log_group        = aws_cloudwatch_log_group.api.name
      target_group_arn = aws_lb_target_group.api.arn
    }
    web = {
      port             = 3000
      image_tag        = var.web_image_tag
      health           = "/"
      log_group        = aws_cloudwatch_log_group.web.name
      target_group_arn = aws_lb_target_group.web.arn
    }
    admin = {
      port             = 3002
      image_tag        = var.admin_image_tag
      health           = "/"
      log_group        = aws_cloudwatch_log_group.admin.name
      target_group_arn = aws_lb_target_group.admin.arn
    }
  }
}

# --- Task Definitions ---

resource "aws_ecs_task_definition" "this" {
  for_each = local.services

  family                   = "ibatexas-${var.environment}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com/ibatexas-${each.key}:${each.value.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = each.value.port
          hostPort      = each.value.port
          protocol      = "tcp"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = each.value.log_group
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = each.key
        }
      }

      secrets = [
        for secret_name in local.secret_names : {
          name      = secret_name
          valueFrom = aws_secretsmanager_secret.this[secret_name].arn
        }
      ]

      environment = concat([
        {
          name  = "NODE_ENV"
          value = var.environment == "production" ? "production" : "development"
        },
        {
          name  = "PORT"
          value = tostring(each.value.port)
        },
        {
          name  = "APP_ENV"
          value = var.environment
        },
        {
          name  = "TRUST_PROXY"
          value = "true"
        }
      ], each.key == "api" ? [
        {
          name  = "RESTAURANT_TIMEZONE"
          value = "America/Sao_Paulo"
        }
      ] : [])
    }
  ])

  tags = {
    Environment = var.environment
  }
}

# --- ECS Services ---

resource "aws_ecs_service" "this" {
  for_each = local.services

  name            = "ibatexas-${var.environment}-${each.key}"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = each.value.target_group_arn
    container_name   = each.key
    container_port   = each.value.port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]

  tags = {
    Environment = var.environment
  }
}
