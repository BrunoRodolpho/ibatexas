# Deployment Guide

From fresh AWS account to running dev + (future) production.

The repo has two deploy targets:

| Environment | Shape | Cost | Status |
|---|---|---|---|
| **dev** | Single EC2 (Spot `t4g.small`) + Docker Compose behind Caddy | ~$15/mo | **active** |
| **production** | ECS Fargate + ALB + ElastiCache + EFS | ~$100/mo+ | **staged** (not applied) |

The heavy Fargate stack lives at `infra/terraform/environments/production/`
but is not applied yet — see [production/README.md](../../infra/terraform/environments/production/README.md)
for the review checklist before first apply.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| AWS CLI | v2+ | `brew install awscli` → `aws configure` |
| Terraform | >= 1.6 | `brew install tfenv && tfenv install 1.9.8 && tfenv use 1.9.8` |
| gh CLI | latest | `brew install gh` → `gh auth login` |
| Supabase | — | Create project at [supabase.com](https://supabase.com) (South America - São Paulo region) |
| Domain | — | `ibatexas.com.br` registered at a domain registrar (Registro.br, Namecheap, etc.) |

---

## Dev (single-EC2) — initial deploy

```bash
# 1. Bootstrap terraform state (S3 bucket + DynamoDB lock table).
#    Idempotent; skip if already done.
ibx infra init

# 2. Provision dev (EC2, EIP, Route53 zone, SSM params, IAM).
cd infra/terraform/environments/dev
terraform init
terraform apply

# 3. IMPORTANT — update domain registrar nameservers.
#    `terraform apply` prints `route53_nameservers`. Set these 4 NS records
#    at the domain registrar where ibatexas.com.br is registered. Propagation
#    takes 15min-48h depending on the registrar.
terraform output route53_nameservers

# 4. Populate secrets into SSM Parameter Store (dev default).
#    Export from .env, then push.
ibx infra secrets:export
ibx infra secrets:push

# 5. Register the GitHub OIDC role ARN with the repo.
ibx infra github

# 6. Push to dev to trigger first deploy via GitHub Actions.
git push origin dev
```

### Daily flow

```bash
ibx infra status                    # EC2 state + HTTPS probes
ibx infra logs api                  # tail api logs via SSM
ibx infra idle                      # stop EC2 when not testing (~$6/mo floor)
ibx infra resume                    # start EC2 (~3-5 min warm-up)
ibx infra deploy --watch            # push + wait for health
```

### Patching the live host without replacing EC2

Terraform bakes `compose.yml.tpl` and `user_data.sh.tpl` into EC2 user-data —
changing them normally requires replacing the instance. For small fixes
(env var, deploy-script tweak) push directly to the live host:

```bash
ibx infra host:sync --env dev          # re-render templates, upload via SSM
ibx infra host:redeploy --env dev      # run /usr/local/bin/ibatexas-deploy (ECR pull + compose up)
```

The next `terraform apply` that replaces the instance will re-bake from the
templates, so keep the templates and the live files in sync by always editing
the template first and then running `host:sync`.

### Medusa ops (on the dev host)

Medusa's `db:migrate` hangs on GitHub-hosted runners (see
[deploy-staging.yml](../../.github/workflows/deploy-staging.yml) comment
around line 94). Until that's resolved, schema changes are a manual step:

```bash
ibx infra medusa:migrate --env dev          # medusa db:migrate inside the container
ibx infra medusa:seed --env dev             # seed categories + products
ibx infra medusa:create-admin --env dev     # idempotent — uses MEDUSA_ADMIN_* from .env
```

Admin login: `https://commerce.ibatexas.com.br/app` with the
`MEDUSA_ADMIN_EMAIL` / `MEDUSA_ADMIN_PASSWORD` stored in SSM
(`/ibatexas/dev/*`). After first login, create a Publishable API Key under
**Settings → Publishable API Keys** and attach it to the default Sales
Channel — the `medusaStore` client auto-resolves one on first call, so it
usually just works.

### Secrets

By default, `ibx infra secrets:*` writes to **SSM Parameter Store** for dev,
**Secrets Manager** for staging/production. Override with:

```bash
SECRETS_BACKEND=secretsmanager ibx infra secrets:push
```

The EC2 host's IAM role grants read on both stores, so existing Secrets
Manager entries keep working during the transition.

### GitHub Actions secrets & variables

`ibx infra github` pushes everything the CI workflows need. Two distinct
categories:

**Runtime (SSM/Secrets Manager)** — read by containers at start. Managed by
`ibx infra secrets:push`.

**Build-time (GitHub Secrets/Variables)** — read by `docker build` on the
runner to inline `NEXT_PUBLIC_*` values into the web client bundle. Managed
by `ibx infra github`.

| Kind | Name | Where from | Required? |
|------|------|------------|-----------|
| Secret | `AWS_DEPLOY_ROLE_ARN` | Terraform output | ✅ required |
| Secret | `DIRECT_DATABASE_URL` | Supabase direct URL (prod) | ✅ required |
| Secret | `STAGING_DIRECT_DATABASE_URL` | Supabase direct URL (dev) | ✅ required |
| Secret | `SONAR_TOKEN` | sonarcloud.io | optional |
| Secret | `NEXT_PUBLIC_POSTHOG_KEY` | `.env` (auto-detected) | optional — analytics disabled if unset |
| Secret | `NEXT_PUBLIC_SENTRY_DSN` | `.env` (auto-detected) | optional — client error reporting disabled if unset |
| Secret | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `.env` (auto-detected) | optional — Stripe checkout UI won't init if unset |
| Variable | `NEXT_PUBLIC_POSTHOG_HOST` | `.env` or default `https://us.posthog.com` | ✅ required (default applied) |

> **Why build-time?** Next.js inlines `NEXT_PUBLIC_*` env vars into the
> client bundle during `next build`. They also end up baked into the CSP
> header via [next.config.mjs](../../apps/web/next.config.mjs). If they're
> missing at build time, the client falls back to localhost and CSP blocks
> the real API origin.

Manual alternatives if `ibx infra github` is unavailable:

```bash
# Secrets — stdin keeps the value out of shell history
grep -E '^NEXT_PUBLIC_POSTHOG_KEY=' .env | sed 's/^[^=]*=//' | gh secret set NEXT_PUBLIC_POSTHOG_KEY

# Variables — plaintext is fine
gh variable set NEXT_PUBLIC_POSTHOG_HOST --body "https://us.posthog.com"

# Verify
gh secret list
gh variable list
```

### Host architecture

```
Route53  ──►  Elastic IP  ──►  EC2 t4g.small (Spot, ARM)
                                    │
                                    ├─ Caddy    (80/443, auto Let's Encrypt)
                                    ├─ web      :3000  (next.js storefront)
                                    ├─ api      :3001  (fastify)
                                    ├─ admin    :3002  (next.js admin)
                                    ├─ commerce :9000  (Medusa v2)
                                    ├─ redis    :6379
                                    ├─ nats     :4222
                                    └─ typesense :8108
```

All containers read `/opt/ibatexas/.env`, which is regenerated from SSM
Parameter Store on each `ibatexas-deploy` run.

> **Next.js and `HOSTNAME`:** `web` and `admin` must set `HOSTNAME=0.0.0.0`
> in compose. Docker otherwise sets `HOSTNAME` to the container ID, which
> makes the Next.js standalone server bind to the eth0 interface only —
> Caddy-to-container traffic works, but the in-container healthcheck
> (`wget localhost:3000/`) gets `ECONNREFUSED` and the container stays
> unhealthy forever.

### CI/CD flow

1. Push to `dev` → `.github/workflows/deploy-staging.yml` fires.
2. Builds + pushes 3 Docker images to ECR (tagged with commit SHA + `latest`).
3. Runs Prisma migrations against `STAGING_DIRECT_DATABASE_URL`.
4. Calls SSM Run Command on the dev host: `/usr/local/bin/ibatexas-deploy`
   (ECR login + `docker compose pull` + `docker compose up -d`).
5. Polls HTTPS health endpoints until 200/3xx on all 3 hosts.

---

## Production — future setup

See [infra/terraform/environments/production/README.md](../../infra/terraform/environments/production/README.md)
for the full checklist. TL;DR: review task sizes, ECR repo names (prefixed
`ibatexas-prod-*`), ALB deletion protection, domain cutover plan, then
`terraform apply`.

---

## Troubleshooting

### DNS not resolving after apply

The Route53 zone is recreated when dev/ is first applied. You **must** update
the NS records at your domain registrar with the four nameservers from
`terraform output route53_nameservers`. Until you do that, `ibatexas.com.br`
won't resolve anywhere.

### Caddy TLS certs not provisioning

Caddy uses HTTP-01 for Let's Encrypt challenges — this requires port 80 to
be reachable from the internet **and** DNS to point at the host. If DNS is
still propagating, HTTPS will 503 for a few minutes.

Check from inside the host:
```bash
aws ssm start-session --target $(terraform output -raw instance_id)
docker logs ibatexas-caddy --tail 100
```

### Container failing to start

```bash
ibx infra logs <service>           # tail 200 lines via SSM
ibx infra status                   # EC2 + HTTPS checks
```

### API logs flood with `[Redis] Client error: WRONGPASS`

Cause: Redis was booted with a password that doesn't match what the API
sees in `REDIS_URL`. Usually one of two things:

1. `REDIS_PASSWORD` in SSM got rotated but `REDIS_URL` in SSM wasn't updated,
   and/or the Redis volume still has a process that was started with an
   older password.
2. The old compose didn't substitute `${REDIS_PASSWORD}`, so Redis's
   requirepass was the literal string `${REDIS_PASSWORD}`.

Fix: `ibatexas-refresh-secrets` now derives `REDIS_URL` from `REDIS_PASSWORD`
on every deploy, so the two can't drift. After a password rotation, reset
the Redis volume so the new value takes effect on boot:

```bash
ibx infra host:sync --env dev          # updates refresh-secrets on the host
aws ssm start-session --target <id>
docker compose -f /opt/ibatexas/docker-compose.yml stop redis
docker compose -f /opt/ibatexas/docker-compose.yml rm -fsv redis
docker volume rm ibatexas_redis_data
/usr/local/bin/ibatexas-deploy
```

### Deploy fails with "container name already in use"

Symptom: `ibatexas-deploy` exits non-zero, GH Actions shows
`The container name "/ibatexas-api" is already in use by container "<id>_ibatexas-api"`.

Cause: a previous compose recreate was interrupted (OOM, SSM timeout, manual
cancel). Compose's rename-then-recreate left a `<oldid>_<service>` leftover
which now blocks the next `up`.

Fix (automated — the hardened deploy script on the host already does this):

```bash
ibx infra host:redeploy --env dev   # sweeps leftovers, force-recreates, pulls always
```

If that's somehow not enough:

```bash
# SSM session into the host
aws ssm start-session --target $(aws ec2 describe-instances \
  --filters "Name=tag:Role,Values=ibatexas-dev-host" \
  "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
# then:
docker rm -f ibatexas-api ibatexas-web ibatexas-admin ibatexas-commerce
/usr/local/bin/ibatexas-deploy
```

### CD build fails with `node:22-alpine` Docker Hub 520

The base image is pinned to `public.ecr.aws/docker/library/node:22-alpine`
(AWS ECR Public mirror) to avoid Docker Hub rate limits / transient 520s.
If you see the error, it's either a workflow that forgot to propagate the
fix or a genuine ECR Public outage — re-run the workflow after 5 minutes
before digging deeper.

### Spot interruption

t4g.small on Spot typically has very low interruption rates (<5%). If it
happens:
- Instance stops with 2-min warning.
- EBS is preserved (`spot_options.instance_interruption_behavior = "stop"`).
- Instance resumes when capacity returns.
- Containers restart automatically via systemd.

To switch to on-demand permanently, edit `ec2.tf` — remove
`instance_market_options {}`. Cost: ~$12.26/mo (vs ~$3.65/mo on Spot).

---

## Cost breakdown

Dev environment running 24/7:

| Line item | $/mo |
|---|---|
| EC2 t4g.small (Spot) | 3.65 |
| EBS 30 GB gp3 | 2.40 |
| Elastic IP | 3.65 |
| ECR storage | 3.75 |
| Route53 zone + queries | 0.90 |
| SSM Parameter Store | 0.00 |
| Data transfer (low volume) | ~1.00 |
| **Total** | **~15-16** |

With `ibx infra idle` used evenings/weekends (~50% uptime): **~$11-13/mo**.
