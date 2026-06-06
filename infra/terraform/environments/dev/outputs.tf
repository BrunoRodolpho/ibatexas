# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "instance_id" {
  description = "EC2 instance ID — use for SSM Session Manager, stop/start"
  value       = aws_instance.host.id
}

output "instance_public_ip" {
  description = "Elastic IP attached to the host"
  value       = aws_eip.host.public_ip
}

output "service_urls" {
  description = "Public service URLs (HTTPS via Caddy + Let's Encrypt)"
  value = {
    web   = "https://${var.domain_name}"
    api   = "https://api.${var.domain_name}"
    admin = "https://admin.${var.domain_name}"
  }
}

output "route53_nameservers" {
  description = "Nameservers — UPDATE THESE AT YOUR DOMAIN REGISTRAR after apply"
  value       = aws_route53_zone.this.name_servers
}

output "ecr_repo_urls" {
  description = "ECR repository URLs"
  value = {
    for name, repo in aws_ecr_repository.this : name => repo.repository_url
  }
}

output "github_deploy_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC — set as AWS_DEPLOY_ROLE_ARN secret"
  value       = aws_iam_role.github_deploy.arn
}

output "ssm_connect_command" {
  description = "SSM Session Manager command to shell into the instance"
  value       = "aws ssm start-session --target ${aws_instance.host.id} --region ${var.region}"
}
