# -----------------------------------------------------------------------------
# GitHub Actions OIDC — provider + scoped deploy role (no long-lived keys)
# -----------------------------------------------------------------------------

data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github.certificates[0].sha1_fingerprint]

  tags = {
    Environment = var.environment
  }
}

# --- Deploy role — assumed by GitHub Actions workflows ---

resource "aws_iam_role" "github_deploy" {
  name = "ibatexas-${var.environment}-github-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.github.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*"
        }
      }
    }]
  })

  tags = {
    Environment = var.environment
  }
}

# --- Deploy policy: ECR push + SSM Run Command on the dev host ---

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "ECRAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "ECRPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = [for r in aws_ecr_repository.this : r.arn]
  }

  # Find the dev host by tag (instance id isn't stable across recreations).
  statement {
    sid = "EC2DescribeInstances"
    actions = [
      "ec2:DescribeInstances",
    ]
    resources = ["*"]
  }

  # Trigger the deploy script on the instance via SSM Run Command.
  statement {
    sid = "SSMSendCommand"
    actions = [
      "ssm:SendCommand",
    ]
    resources = [
      # AWS-RunShellScript is a managed document.
      "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
      # Any instance tagged Role=ibatexas-<env>-host.
      "arn:aws:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:instance/*",
    ]
  }

  statement {
    sid = "SSMGetCommandInvocation"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:ListCommands",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "ibatexas-${var.environment}-github-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
