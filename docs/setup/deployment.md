# Deployment Guide

From fresh AWS account to running in production.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| AWS CLI | v2+ | `brew install awscli` → `aws configure` |
| Terraform | >= 1.6 | `brew install terraform` |
| gh CLI | latest | `brew install gh` → `gh auth login` |
| Supabase | — | Create project at [supabase.com](https://supabase.com) (South America - São Paulo region) |
| Domain | — | `ibatexas.com.br` registered at a domain registrar |

---

## Quick Start

```bash
ibx infra init                     # S3 bucket + DynamoDB lock table
# Uncomment S3 backend in infra/terraform/environments/dev/main.tf
terraform init -migrate-state \
  -chdir=infra/terraform/environments/dev
ibx infra apply                    # Provision all AWS resources (~25 resources)
ibx infra secrets                  # Populate 17 Secrets Manager entries (interactive)
ibx infra github                   # Set GitHub repo secrets (OIDC role, DB URLs)
git push origin dev                # Trigger first staging deploy
```

---

## Architecture Overview

```
                   ┌─────────────────────────────┐
                   │         Route53              │
                   │  ibatexas.com.br (+ subs)    │
                   └──────────┬──────────────────┘
                              │
                   ┌──────────▼──────────────────┐
                   │     ALB (HTTPS :443)         │
                   │  *.ibatexas.com.br ACM cert  │
                   └──┬────────┬────────┬────────┘
                      │        │        │
              ┌───────▼──┐ ┌──▼─────┐ ┌▼────────┐
              │ api:3001  │ │web:3000│ │admin:3002│
              │  Fargate  │ │Fargate │ │ Fargate  │
              └──┬──┬──┬──┘ └────────┘ └──────────┘
                 │  │  │
     ┌───────────┘  │  └───────────┐
     ▼              ▼              ▼
 ElastiCache    Cloud Map      Cloud Map
  Redis 7.1    nats:4222    typesense:8108
              (ECS Fargate)  (ECS + EFS)
```

- **3 app services**: api, web, admin — all ECS Fargate behind ALB with host-based routing
- **Redis**: ElastiCache `cache.t4g.micro` — BullMQ queues, caching, sessions
- **NATS**: ECS Fargate with JetStream — event bus (`cart.abandoned`, `order.placed`, etc.)
- **Typesense**: ECS Fargate with EFS — search index with persistent storage
- **Deploys**: GitHub Actions with OIDC (no long-lived AWS keys)

---

## How CD Works

### Staging — push to `dev`

Workflow: `.github/workflows/deploy-staging.yml`

```
push to dev → build 3 Docker images → push to ECR → run Prisma migrations → deploy ECS → wait stable
```

- **Auto-deploys** on every push to `dev`
- **Concurrency**: cancel-in-progress (latest push wins)
- Images tagged: `sha-<commit>` + `dev-latest`

### Production — push to `main`

Workflow: `.github/workflows/deploy.yml`

```
push to main → build → push ECR → migrate → deploy ECS → wait stable → health check
```

- **Auto-deploys** on every push to `main`
- **No cancel-in-progress** — each deploy completes fully
- Images tagged: `sha-<commit>` + `latest`
- **Health checks** after deploy: verifies `api /health`, `web /`, `admin /`

### Pipeline steps (both workflows)

1. **Build**: Multi-stage Docker builds (Node 22, pnpm 10.32.1)
2. **Push**: ECR with commit SHA tags
3. **Migrate**: Prisma migrations via `DIRECT_DATABASE_URL` (direct Supabase connection, port 5432)
4. **Deploy**: Sequential ECS service updates (api → web → admin)
5. **Wait**: ECS deployment controller waits for stability (10 min timeout)
6. **Health** (production only): HTTP checks on all 3 public endpoints

---

## Step-by-Step Setup

### 1. AWS Bootstrap

```bash
aws configure              # Access Key, Secret, region: sa-east-1
ibx infra init             # Creates S3 bucket + DynamoDB lock table
```

### 2. Enable Terraform State Backend

Uncomment the S3 backend block in `infra/terraform/environments/dev/main.tf` (lines 17-23), then:

```bash
cd infra/terraform/environments/dev
terraform init -migrate-state
```

### 3. Supabase Project

Create project at [supabase.com](https://supabase.com) in **South America (São Paulo)** region. Grab:

- `DATABASE_URL` — pooler connection (port 6543, for app runtime)
- `DIRECT_DATABASE_URL` — direct connection (port 5432, for Prisma migrations)

### 4. Terraform Apply

```bash
ibx infra apply
```

This provisions ~25 AWS resources: ECS cluster, ALB, ECR repos, Route53 zone, ACM certs, ElastiCache, NATS/Typesense services, security groups, IAM roles, Secrets Manager entries.

### 5. Domain Nameservers

After apply, copy the 4 Route53 NS records (shown in output) and set them at your domain registrar.

### 6. ACM Certificate Validation

The wildcard cert (`*.ibatexas.com.br`) uses DNS validation. Once nameservers propagate (5 min – 24 hours), it auto-validates.

Check: `ibx infra status` (look at ACM Certificate line)

### 7. Populate Secrets

```bash
ibx infra secrets          # Interactive prompts for all 17 secrets
# OR for CI:
ibx infra secrets --from-env   # Reads from environment variables
```

**REDIS_URL** and **NATS_URL** are auto-populated by Terraform — you don't need to set these.

### 8. GitHub Secrets

```bash
ibx infra github           # Sets AWS_DEPLOY_ROLE_ARN + prompts for DB URLs
```

### 9. First Deploy

```bash
git push origin dev        # Triggers staging deploy
ibx infra deploy --watch   # Or push + monitor in one command
```

---

## External Services

| Service | Secret(s) | Where to get it |
|---------|-----------|----------------|
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | [stripe.com/dashboard](https://stripe.com/dashboard) |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID` | [twilio.com/console](https://twilio.com/console) |
| Anthropic | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| OpenAI | `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) |
| Sentry | `SENTRY_DSN` | [sentry.io](https://sentry.io) — create 3 projects (api, web, admin) |
| PostHog | (set in app config) | [posthog.com](https://posthog.com) |

---

## Checking Status

```bash
ibx infra status           # Dashboard with confidence summary
ibx infra status --json    # Machine-readable for CI
ibx infra checklist        # Numbered deployment checklist
ibx infra explain          # Root cause analysis for failures
ibx infra doctor           # Deep diagnostics (ECR, CloudWatch, Cloud Map)
```

---

## Rollback

### Automatic

ECS has `deployment_circuit_breaker` enabled with `rollback = true`. If new tasks fail health checks, ECS automatically rolls back to the previous task definition.

### Manual

```bash
# Find previous task definition
aws ecs describe-services --cluster ibatexas-dev --services ibatexas-dev-api \
  --query "services[0].taskDefinition" --output text

# Roll back to a specific revision
aws ecs update-service --cluster ibatexas-dev --service ibatexas-dev-api \
  --task-definition ibatexas-dev-api:<previous-revision>
```

ECR keeps the last 25 images (lifecycle policy), so previous images are always available.

---

## Common Failure Modes

### First deploy gets stuck in health check loop

**Cause**: Redis, NATS, or Typesense not ready when API starts. The `/health` endpoint checks all three — returns 503 if any fails.

**Fix**: `ibx infra status` → verify ECS services for nats and typesense are running.

### ECS deploy succeeds but app crashes

**Cause**: Missing or invalid secrets in Secrets Manager. The API validates all env vars at startup (Zod schema) and crashes if required ones are missing.

**Fix**: `ibx infra secrets` → populate missing values. Then trigger a new deploy.

### GitHub Actions deploy fails

**Cause**: OIDC role not configured or `AWS_DEPLOY_ROLE_ARN` GitHub secret not set.

**Fix**: `ibx infra github` → re-set the deploy role ARN.

### ACM certificate stuck on PENDING_VALIDATION

**Cause**: Domain nameservers not pointing to Route53 yet. DNS propagation can take up to 24 hours.

**Fix**: Verify NS records at your domain registrar match Route53 output. Wait for propagation.

### Terraform state lock

**Cause**: Concurrent `terraform apply` runs, or a previous run crashed without releasing the lock.

**Fix**: `terraform force-unlock <LOCK_ID>` (the lock ID is shown in the error message).

### Deploy shows green but app serves 500s

**Cause**: Running image is outdated (old task definition) or secrets were rotated but not redeployed.

**Fix**: `ibx infra explain` → identifies image freshness and secret staleness issues.

### Secrets rotated but old values still running

**Cause**: ECS tasks cache secrets at startup. Rotating a secret in Secrets Manager doesn't restart running tasks.

**Fix**: Force a new deployment: `aws ecs update-service --cluster ibatexas-dev --service ibatexas-dev-api --force-new-deployment`

---

## Troubleshooting

### Terraform version mismatch

The project requires Terraform >= 1.6. Check: `terraform version`

### ECS capacity provider issues

Default VPC subnets need `assign_public_ip = true` for Fargate tasks (no NAT gateway). This is already configured.

### Supabase connection timeouts

Ensure ECS security groups allow outbound to `0.0.0.0/0` on ports 5432 (direct) and 6543 (pooler). Supabase is external — no VPC peering.

### Cold-start deploy timeouts

First deploys can take longer (cold ECR, image pull, capacity provisioning). Use `ibx infra deploy --watch --timeout 20m` for the initial deploy.
