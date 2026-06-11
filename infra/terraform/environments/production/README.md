# production/ — staged, not yet applied

This directory holds the **future production** Terraform stack: the ECS
Fargate architecture (Fargate API/web/admin behind an ALB + EFS +
ElastiCache + NATS/Typesense Fargate services). It is a snapshot of the
**pre-migration** `../dev/` stack — see "Why it's here".

## Why it's here

`../dev/` has since been migrated to a cheap single-EC2 + Docker Compose
setup to cut dev costs (~$100/mo → ~$15/mo). The original Fargate
architecture is still the right shape for production (HA, rolling deploys,
managed infra), so it was forked here until production launch.

Because the migration diverged `../dev/` afterward, this directory is **not**
a copy of today's `dev/`. Today's `dev/` is single-EC2 with Elastic-IP
A-records, `force_delete = true` on ECR, an extra `ibatexas-commerce` ECR
repo, and a `prevent_destroy` guard on its Route53 zone — none of which are
here.

## What it's NOT

- **Not applied.** No resources exist in AWS for this stack yet.
- **Not edited for production yet.** Every file still carries the `dev`
  defaults it was forked from (`environment = "dev"`, backend
  `key = "dev/terraform.tfstate"`, unprefixed ECR repo names). The edits
  below are **pending** — do them before the first apply.

## Pending edits before `terraform apply`

These are NOT done yet. Make them, then re-review.

- [ ] **Backend state key** (`main.tf:18`): currently
      `key = "dev/terraform.tfstate"` — would collide with dev state.
      Change to `production/terraform.tfstate`.
- [ ] **Environment** (`terraform.tfvars:1`): currently
      `environment = "dev"`. Set to `"production"`. This alone re-templates
      most resource names, the Secrets Manager path
      (`ibatexas/${var.environment}/*`), the OIDC deploy role
      (`ibatexas-${var.environment}-github-deploy`), and the CloudWatch log
      group paths.
- [ ] **ECR** (`ecr.tf`): repo names are `ibatexas-api/web/admin` with no
      env prefix — shared with dev. Decide whether to prefix them
      (e.g. `ibatexas-prod-*`) or rely on a separate AWS account. Set
      `image_tag_mutability = "IMMUTABLE"` (currently `MUTABLE`) so prod
      tags can't be overwritten. `force_delete` is already `false`.
- [ ] **Destroy guards**: neither `alb.tf` (the ALB) nor `dns.tf` (the
      Route53 zone) has a `lifecycle { prevent_destroy = true }`. The
      Route53 zone in particular should get one — registrar NS updates are
      slow and manual (see the guard already on `dev/dns.tf`).

## Review checklist before `terraform apply`

- [ ] **Domain decision**: production on `ibatexas.com.br`, dev on a
      subdomain (`dev.ibatexas.com.br`)? Or a separate domain entirely?
      Today dev owns the apex zone; moving prod onto the apex means moving
      dev off first.
- [ ] **Task sizing**: bump `cpu`/`memory` in `ecs.tf` for production
      traffic (currently 512/1024 per service — review).
- [ ] **Desired count**: `ecs.tf` sets `desired_count = 1`; set `= 2` per
      service for HA + rolling deploys.
- [ ] **ElastiCache**: `elasticache.tf` is single-node `cache.t4g.micro`
      with no TLS/AUTH. Consider `cache.t4g.small` and a multi-AZ
      replication group.
- [ ] **ALB**: consider enabling cross-zone load balancing if not on by
      default.
- [ ] **Build image tags**: prod should tag with commit SHA (immutable),
      not `latest`. Update `.github/workflows/deploy.yml` accordingly, and
      add a GitHub Actions environment named `production` with
      `AWS_DEPLOY_ROLE_ARN` scoped to it.
- [ ] **DNS cutover plan**: update the registrar (Registro.br) to the new
      prod nameservers; lower DNS TTL the day before.

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
- ElastiCache Redis (`cache.t4g.micro`): $13/mo
- CloudWatch Logs: ~$10/mo (app services retain 30 days, Typesense 14)
- Data transfer, EFS, Route53, Secrets Manager: ~$5/mo
- Public IPs / data transfer: ~$10-20/mo

Multi-AZ + 2 replicas per service + `cache.t4g.small` could add $30-50/mo
on top.
