# -----------------------------------------------------------------------------
# ECR Repositories — one per service
# -----------------------------------------------------------------------------

locals {
  ecr_repos = ["ibatexas-api", "ibatexas-web", "ibatexas-admin", "ibatexas-commerce"]
}

resource "aws_ecr_repository" "this" {
  for_each = toset(local.ecr_repos)

  name                 = each.value
  image_tag_mutability = "MUTABLE"
  # Dev is ephemeral — force_delete lets `ibx destroy` wipe repos with images
  # still in them. Prod keeps this false (see environments/production/ecr.tf).
  force_delete = true

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
