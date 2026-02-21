# Local Development Setup

### Local Development
All infrastructure runs via Docker Compose: PostgreSQL, NATS, Typesense, Redis.
Apps run with `turbo dev` against local services.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 20 LTS | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| pnpm | 8+ | `npm install -g pnpm` |
| Docker Desktop | Latest | [docker.com](https://www.docker.com) |
| AWS CLI | 2+ | `brew install awscli` |
| Terraform | 1.6+ | `brew install terraform` |

---

## Environment Variables

Copy `.env.example` to `.env` at the repo root and fill in the required values before starting any service.

Required for Phase 1:

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `CLERK_SECRET_KEY` | dashboard.clerk.com |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | dashboard.clerk.com |
| `STRIPE_SECRET_KEY` | dashboard.stripe.com |
| `DATABASE_URL` | Local Docker (see below) |
| `TYPESENSE_API_KEY` | Local Docker (see below) |
| `REDIS_URL` | Local Docker (see below) |

---

## Start Local Infrastructure

All backing services run in Docker. From the repo root:

```bash
docker compose up -d
```

This starts: PostgreSQL, NATS, Typesense, Redis.

---

## Health Check

Before starting apps, verify all infrastructure services are healthy:

```bash
pnpm check
```

This runs `scripts/healthcheck.sh` and prints ✓/✗ for each service. All 8 checks must pass before proceeding.

---

## Start Applications

```bash
pnpm install
turbo dev
```

All four apps start concurrently. Turborepo handles dependency order.

| App | Local URL |
|---|---|
| Web (storefront) | http://localhost:3000 |
| API | http://localhost:3001 |
| Agent | Internal (called by API) |
| Commerce (Medusa) | http://localhost:9000 |

---

## First-Time Database Setup

```bash
# Run Prisma migrations
turbo db:migrate

# Seed with sample products
turbo db:seed
```

---

## Verify Everything Works

1. Open http://localhost:3000
2. Sign in with Clerk
3. Type a product search in the chat
4. The agent should respond with results from Typesense

If the agent responds but returns no products, the seed data may not have loaded — re-run `turbo db:seed`.
