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

### Secrets

By default, `ibx infra secrets:*` writes to **SSM Parameter Store** for dev,
**Secrets Manager** for staging/production. Override with:

```bash
SECRETS_BACKEND=secretsmanager ibx infra secrets:push
```

The EC2 host's IAM role grants read on both stores, so existing Secrets
Manager entries keep working during the transition.

### Host architecture

```
Route53  ──►  Elastic IP  ──►  EC2 t4g.small (Spot, ARM)
                                    │
                                    ├─ Caddy (80/443, auto Let's Encrypt)
                                    ├─ web   :3000  (next.js storefront)
                                    ├─ api   :3001  (fastify)
                                    ├─ admin :3002  (next.js admin)
                                    ├─ redis :6379
                                    ├─ nats  :4222
                                    └─ typesense :8108
```

All containers read `/opt/ibatexas/.env`, which is regenerated from SSM
Parameter Store on each `ibatexas-deploy` run.

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
