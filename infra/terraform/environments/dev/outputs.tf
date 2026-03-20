# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "alb_dns_name" {
  description = "ALB DNS name"
  value       = aws_lb.this.dns_name
}

output "ecr_repo_urls" {
  description = "ECR repository URLs"
  value = {
    for name, repo in aws_ecr_repository.this : name => repo.repository_url
  }
}

output "ecs_service_names" {
  description = "ECS service names"
  value = {
    for name, svc in aws_ecs_service.this : name => svc.name
  }
}

output "route53_nameservers" {
  description = "Route53 nameservers — set these at your domain registrar"
  value       = aws_route53_zone.this.name_servers
}

output "service_urls" {
  description = "Public service URLs"
  value = {
    web   = "https://${var.domain_name}"
    api   = "https://api.${var.domain_name}"
    admin = "https://admin.${var.domain_name}"
  }
}
