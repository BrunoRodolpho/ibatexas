# -----------------------------------------------------------------------------
# IAM — EC2 instance role for SSM, ECR pulls, and secrets access
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name               = "ibatexas-${var.environment}-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json

  tags = {
    Environment = var.environment
  }
}

# Managed policies — SSM agent (session manager + run command) + ECR pull.
resource "aws_iam_role_policy_attachment" "host_ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "host_ecr_ro" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Inline policy — access to /ibatexas/<env>/* SSM parameters + Secrets Manager
# (both supported so the CLI can use either backend per environment).
data "aws_iam_policy_document" "host_secrets" {
  statement {
    sid = "SSMParameterStore"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/ibatexas/${var.environment}/*",
    ]
  }

  statement {
    sid = "SSMKmsDecrypt"
    actions = [
      "kms:Decrypt",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }

  statement {
    sid = "SecretsManager"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:ibatexas/${var.environment}/*",
    ]
  }
}

resource "aws_iam_role_policy" "host_secrets" {
  name   = "ibatexas-${var.environment}-host-secrets"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host_secrets.json
}

resource "aws_iam_instance_profile" "host" {
  name = "ibatexas-${var.environment}-host"
  role = aws_iam_role.host.name

  tags = {
    Environment = var.environment
  }
}
