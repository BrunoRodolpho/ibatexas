# production/ — staged, not yet applied

This directory holds the **future production** Terraform stack. It is a
verbatim copy of the Fargate architecture that previously lived at
`../dev/` (ECS Fargate + ALB + EFS + ElastiCache + NATS/Typesense
Fargate services).

## Why it's here

We migrated `../dev/` to a cheap single-EC2 + Docker Compose setup to
cut dev costs from ~$100/mo to ~$15/mo. The original Fargate architecture
is still the right shape for production (HA, rolling deploys, managed
infra), so it lives here until production launch.

## What it's NOT

- **Not applied.** No resources exist in AWS for this stack yet.
- **Not production-ready as-is.** Review list below before first apply.

## Changes from the original dev/

1. `main.tf` — backend key `production/terraform.tfstate` (was `dev/...`)
2. `terraform.tfvars` — `environment = "production"`
3. `ecr.tf` — repo names prefixed with `ibatexas-prod-*` (doesn't collide
   with dev's shared ECR repos), `image_tag_mutability = "IMMUTABLE"`
4. `alb.tf` — `prevent_destroy = true` on the ALB
5. `dns.tf` — `prevent_destroy = true` on the Route53 zone

## Review checklist before `terraform apply`

- [ ] **Domain decision**: production on `ibatexas.com.br`, dev on a
      subdomain (`dev.ibatexas.com.br`)? Or separate domain entirely? Today
      dev owns the apex zone; moving prod onto the apex means moving dev
      off first.
- [ ] **Task sizing**: bump `cpu`/`memory` in `ecs.tf` for production
      traffic (currently 512/1024 per service — probably fine, but review).
- [ ] **Desired count**: set `desired_count = 2` per service in `ecs.tf`
      for HA + rolling deploys.
- [ ] **ElastiCache**: consider `cache.t4g.small` and multi-AZ replication
      group instead of single-node `cache.t4g.micro`.
- [ ] **ALB**: `idle_timeout` defaults are fine, but consider enabling
      cross-zone load balancing if not on by default.
- [ ] **Secrets Manager**: same secret names, different env prefix
      (`ibatexas/production/*` — path is already templated on `var.environment`).
- [ ] **GitHub OIDC role**: rename to `ibatexas-production-github-deploy`
      (automatic since name is templated). Add a GitHub Actions environment
      called `production` with `AWS_DEPLOY_ROLE_ARN` scoped to it.
- [ ] **Build image tags**: prod should tag with commit SHA (immutable),
      not `latest`. Update `.github/workflows/deploy.yml` accordingly.
- [ ] **Domain/DNS cutover plan** — update registrar to new prod
      nameservers; plan DNS TTL lowering the day before.

## Bootstrap command (when ready)

```bash
cd infra/terraform/environments/production
terraform init
terraform plan -out=tfplan
# Review very carefully
terraform apply tfplan
```

## Cost estimate (at apply time)

~$100-120/mo baseline:
- ALB: $16/mo
- Fargate (3 app services × 0.5vCPU/1GB 24/7): $36/mo
- Fargate (NATS 0.25/0.5, Typesense 0.5/1): $23/mo
- ElastiCache Redis: $13/mo
- CloudWatch Logs: $10/mo (with 7-day retention)
- Data transfer, EFS, Route53, Secrets Manager: ~$5/mo
- NAT/ENI public IPs: ~$10-20/mo

Multi-AZ + 2 replicas per service + `cache.t4g.small` could add $30-50/mo
on top.
