# -----------------------------------------------------------------------------
# IAM — ECS execution role + task role
# -----------------------------------------------------------------------------

# --- Execution Role (Fargate agent: pull images, write logs, read secrets) ---

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "ibatexas-${var.environment}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json

  tags = {
    Environment = var.environment
  }
}

data "aws_iam_policy_document" "ecs_execution" {
  # ECR — pull images
  statement {
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = [for r in aws_ecr_repository.this : r.arn]
  }

  # CloudWatch Logs
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.region}:*:log-group:/ecs/ibatexas/*"]
  }

  # Secrets Manager
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
    ]
    resources = [for s in aws_secretsmanager_secret.this : s.arn]
  }
}

resource "aws_iam_role_policy" "ecs_execution" {
  name   = "ibatexas-${var.environment}-ecs-execution"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution.json
}

# --- Task Role (application code — EFS access for Typesense) ---

resource "aws_iam_role" "ecs_task" {
  name               = "ibatexas-${var.environment}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json

  tags = {
    Environment = var.environment
  }
}

data "aws_iam_policy_document" "ecs_task" {
  statement {
    sid = "EFSAccess"
    actions = [
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
    ]
    resources = [aws_efs_file_system.typesense.arn]
  }
}

resource "aws_iam_role_policy" "ecs_task" {
  name   = "ibatexas-${var.environment}-ecs-task"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task.json
}
