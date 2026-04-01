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
| process-compose | Latest | `brew install f1bonacc1/tap/process-compose` |
| AWS CLI | 2+ | `brew install awscli` _(production only)_ |
| Terraform | 1.6+ | `brew install terraform` _(production only)_ |

---

## One-Time Setup

> Starting from a fresh database? Run `ibx bootstrap` — it handles Docker, migrations, admin user, and seeds automatically. See [pre-requisites.md](pre-requisites.md) for details.

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
| `APP_ENV` | `development` (default, no action needed) |

**Optional (PostHog analytics):**

| Variable | Where to get it |
|----------|----------------|
| `NEXT_PUBLIC_POSTHOG_KEY` | [PostHog](https://posthog.com) → Project Settings → Project API Key |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://app.posthog.com` (default) or your self-hosted URL |

> `DATABASE_URL`, `REDIS_URL`, `TYPESENSE_API_KEY`, and `NATS_URL` are pre-filled in `.env.example` for local Docker. Do not change the port from 5433 — local macOS Postgres occupies 5432.

---

## Daily Dev Workflow

### Start everything

```bash
ibx dev start                              # 4 core services in TUI
ibx dev start all                          # everything: 4 services + ngrok + Stripe webhooks
ibx dev start --with-tunnel --with-stripe  # same as 'all' (explicit flags)
ibx dev start commerce api                 # only specific services + their deps
ibx dev start --no-tui                     # plain log output (no TUI)
ibx dev start --skip-docker                # infra already running
```

`ibx dev start` launches [process-compose](https://github.com/F1bonacc1/process-compose), which orchestrates:
1. Docker infrastructure (Postgres, Redis, Typesense, NATS)
2. Commerce (Medusa) — waits for Docker healthy
3. API — waits for Commerce healthy
4. Web + Admin — wait for Docker healthy
5. (optional) ngrok tunnel + Stripe listener — wait for API healthy

### Stop everything

```bash
ibx dev stop          # stop all processes + Docker
ibx dev stop web      # stop only web (keeps others running)
ibx dev stop -f       # force-kill by port
```

### Restart a service

```bash
ibx dev restart web   # restart web without touching others
ibx dev restart       # restart all app services
```

---

## Local URLs

| Service         | URL                              | Notes                     |
|-----------------|----------------------------------|---------------------------|
| Medusa API      | http://localhost:9000           | Commerce backend          |
| Medusa Admin    | http://localhost:9000/app       | Login: see below          |
| Web (Next.js)   | http://localhost:3000           | Storefront                |
| API (Fastify)   | http://localhost:3001           | REST + SSE               |
| API Swagger UI  | http://localhost:3001/docs      | API documentation         |
| Typesense       | http://localhost:8108           | Search                    |
| NATS Monitor    | http://localhost:8222           | Event bus                 |
| PostHog         | https://app.posthog.com         | Analytics dashboard (cloud) |
| PostgreSQL      | localhost:5433                  | Port 5433 (not 5432!)     |

**Medusa admin login:** Set `MEDUSA_ADMIN_EMAIL` and `MEDUSA_ADMIN_PASSWORD` in your `.env`, then run:

```bash
ibx auth create-admin
```

This creates the admin user in the database. Login at http://localhost:9000/app with those credentials.
If the user already exists, the command warns safely. You can also pass `--email` and `--password` flags directly.

**Admin panel staff login:** Register your phone as staff to access the admin panel at http://localhost:3002/admin:

```bash
ibx auth create-staff --phone "+15125551234" --name "Your Name"
```

Supports BR (`+55`) and US (`+1`) phones. Roles: `OWNER` (default), `MANAGER`, `ATTENDANT`.
Login uses WhatsApp OTP — enter your phone on the admin login page to receive a verification code.

---

## Database Operations

```bash
# Run Medusa migrations (Medusa must NOT be running)
ibx db migrate

# Run Prisma domain migrations
ibx db migrate:domain

# Seed with Smoked House products (Medusa must be running)
ibx db seed

# Seed domain tables (DeliveryZone, Table, TimeSlot)
ibx db seed:domain

# Reindex Typesense from Medusa catalog
ibx db reindex

# Full reset: drop → migrate → reseed (destructive)
ibx db reset

# Direct DB access
psql postgresql://ibatexas:ibatexas@localhost:5433/ibatexas
```

---

## Health Check

```bash
ibx svc health
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

## Claude Code Plugins

This project uses several Claude Code plugins for development quality.
They are installed globally and persist across sessions.

```bash
# Install all project plugins (one-time)
claude plugin install frontend-design
claude plugin install security-guidance
claude plugin install code-review
claude plugin install feature-dev
```

See [plugins.md](plugins.md) for full documentation.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Port 9000 already in use` | `pkill -f "medusa develop"` then `ibx dev` |
| `Role ibatexas does not exist` | Using port 5432 — check `DATABASE_URL` uses 5433 |
| Medusa doesn't start | `ibx dev stop && ibx dev` (fresh start) |
| Seed fails | Ensure Medusa is running first: `ibx svc health` |
| CLI command not found | `cd packages/cli && npm link` |
| Docker containers unhealthy | `docker compose down -v && ibx dev` |
| PG version mismatch (`initialized by PostgreSQL 15, not compatible with 17`) | `docker compose down -v && ibx bootstrap` |
| `relation "X" does not exist` on startup | Run `ibx bootstrap` or manually: `ibx db migrate` then `ibx db migrate:domain` |
| `process-compose: command not found` | `brew install f1bonacc1/tap/process-compose` |
| TUI not rendering | Try `ibx dev start --no-tui` for plain output |
| `Port XXXX already in use` | Ghost process — run `ibx dev stop -f` to force-kill, then retry |
