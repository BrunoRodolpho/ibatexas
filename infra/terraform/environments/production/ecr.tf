# -----------------------------------------------------------------------------
# ECR Repositories — one per service
# -----------------------------------------------------------------------------

locals {
  # Prefix with env so prod repos don't collide with dev repos in the same account.
  ecr_repos = ["ibatexas-prod-api", "ibatexas-prod-web", "ibatexas-prod-admin"]
}

resource "aws_ecr_repository" "this" {
  for_each = toset(local.ecr_repos)

  name = each.value
  # Immutable tags in prod — never overwrite. Dev keeps MUTABLE so `dev-latest` works.
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 25 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 25
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
