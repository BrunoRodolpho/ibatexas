# Local Development Setup

All infrastructure runs via Docker Compose: PostgreSQL (5433), Redis, Typesense, NATS.
The `ibx` CLI is the primary tool for all dev operations.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20 LTS | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| pnpm | 8+ | `npm install -g pnpm` |
| Docker Desktop | Latest | [docker.com](https://www.docker.com) |
| AWS CLI | 2+ | `brew install awscli` _(production only)_ |
| Terraform | 1.6+ | `brew install terraform` _(production only)_ |

---

## One-Time Setup

### 1. Install dependencies + build CLI

```bash
pnpm install
pnpm --filter @ibatexas/cli build
cd packages/cli && npm link && cd ../..
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in required keys (see table below)
```

**Phase 1 required keys:**

| Variable | Where to get it |
|----------|----------------|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `TWILIO_ACCOUNT_SID` | [console.twilio.com](https://console.twilio.com) |
| `TWILIO_AUTH_TOKEN` | [console.twilio.com](https://console.twilio.com) |
| `TWILIO_VERIFY_SID` | Twilio → Verify → create service → Service SID |
| `JWT_SECRET` | `openssl rand -base64 32` |
| `COOKIE_SECRET` | `openssl rand -base64 32` |

> `DATABASE_URL`, `REDIS_URL`, `TYPESENSE_API_KEY`, and `NATS_URL` are pre-filled in `.env.example` for local Docker. Do not change the port from 5433 — local macOS Postgres occupies 5432.

---

## Daily Dev Workflow

### Start everything

```bash
ibx dev
```

`ibx dev` handles all 4 steps automatically:
1. `docker compose up -d --wait` — starts and waits for all containers to be healthy
2. Runs infrastructure health checks — Postgres, Redis, Typesense, NATS
3. Starts `medusa develop` for `apps/commerce`
4. Polls `http://localhost:9000/health` until ready (≤90s)

If Docker is already running:
```bash
ibx dev --skip-docker
```

### Stop everything

```bash
# Ctrl+C to stop Medusa, then:
ibx stop   # stops Docker containers
```

---

## Local URLs

| Service | URL | Notes |
|---------|-----|-------|
| Medusa API | http://localhost:9000 | Commerce backend |
| Medusa Admin | http://localhost:9000/app | Login: see below |
| Web (Next.js) | http://localhost:3000 | Storefront |
| API (Fastify) | http://localhost:3001 | REST + SSE |
| Typesense | http://localhost:8108 | Search |
| NATS Monitor | http://localhost:8222 | Event bus |
| PostgreSQL | localhost:5433 | Port 5433 (not 5432!) |

**Medusa admin login:** `admin@ibatexas.com.br` / `IbateXas2024!`

---

## Database Operations

```bash
# Run migrations (Medusa must NOT be running)
pnpm --filter @ibatexas/commerce db:migrate

# Seed with Smoked House products (Medusa must be running)
ibx seed

# Full reset: drop → migrate → reseed (destructive)
ibx seed reset

# Direct DB access
psql postgresql://ibatexas:ibatexas@localhost:5433/ibatexas
```

---

## Health Check

```bash
ibx health
```

Checks all 4 services with latency:

```
  ✓  PostgreSQL      12ms
  ✓  Redis            3ms
  ✓  Typesense        8ms
  ✓  NATS             2ms
```

Exits with code 1 if any service is down.

---

## Tests

```bash
# All tests
pnpm test

# CLI seed validation (fast, no DB required)
pnpm --filter @ibatexas/cli test

# With coverage report
pnpm --filter @ibatexas/cli test --coverage
```

---

## Rebuilding the CLI

After editing `packages/cli/src/**`:

```bash
pnpm --filter @ibatexas/cli build
cd packages/cli && npm link && cd ../..
```

> The `npm link` step is only needed if you add new commands or change the `bin` entry.
> For most command logic changes, `build` alone is sufficient.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Port 9000 already in use` | `pkill -f "medusa develop"` then `ibx dev` |
| `Role ibatexas does not exist` | Using port 5432 — check `DATABASE_URL` uses 5433 |
| Medusa doesn't start | `ibx stop && ibx dev` (fresh start) |
| Seed fails | Ensure Medusa is running first: `ibx health` |
| CLI command not found | `cd packages/cli && npm link` |
| Docker containers unhealthy | `docker compose down -v && ibx dev` |
