# Local Development Setup

All infrastructure runs via Docker Compose: PostgreSQL (5433), Redis, Typesense, NATS.
The `ibx` CLI is the primary tool for all dev operations.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22+ | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| pnpm | 10+ | `npm install -g pnpm@10` (repo pins `pnpm@10.32.1`) |
| Docker Desktop | Latest | [docker.com](https://www.docker.com) |
| process-compose | Latest | `brew install f1bonacc1/tap/process-compose` |
| AWS CLI | 2+ | `brew install awscli` _(production only)_ |
| Terraform | 1.6+ | `brew install tfenv && tfenv install 1.9.8 && tfenv use 1.9.8` _(production only)_ |

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
| `ADMIN_API_KEY` | `openssl rand -base64 32` — must match in API and admin app |
| `SESSION_HMAC_SECRET` | `openssl rand -base64 32` — signs session tokens (fails closed; placeholders rejected) |
| `WEB_GATEWAY_SIGNING_KEY` | `openssl rand -base64 32` — HMAC the conductor trusts for web-gateway messages |
| `SYSTEM_GATEWAY_SIGNING_KEY` | `openssl rand -base64 32` — HMAC for the system agent-host channel |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` (required at boot; no in-code fallback) |
| `EMBEDDING_MODEL_ID` | `text-embedding-3-small` (required at boot) |
| `APP_ENV` | `development` (default, no action needed) |

> The four `*_SECRET` / `*_SIGNING_KEY` vars and both `*_MODEL*` vars are
> **fail-closed**: the API throws at boot (or on first login, for
> `SESSION_HMAC_SECRET`) when they're missing. Provision NATS auth separately with
> `./scripts/nats/gen-dev-nats-auth.sh` (writes `NATS_NKEY_SEED` +
> `NATS_APP_NKEY_PUBLIC`). Run `ibx env check` to confirm everything required is set.

**Behavior flags (dev):** Several env vars change how the stack behaves rather than
whether it boots. Run `ibx env flags` to see them and their effective values, and
`ibx env toggle <KEY>` to flip one (it rewrites `.env` in place — restart the
affected process afterward). The same summary prints at the top of `ibx dev`, with
a `⚠` next to anything risky. The two you'll most likely want on for local work:

```bash
ibx env toggle IBX_DEV_OTP_BYPASS   # log in without Twilio…
ibx env toggle IBX_DEV_OTP_CODE     # …using this fixed code (default 424242)
```

Without an `OPENAI_API_KEY`, embeddings silently fall back to a hash and semantic
search returns garbage — `ibx env flags` flags this.

**Optional (Stripe card payments):**

| Variable | Where to get it |
|----------|----------------|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | [Stripe Dashboard](https://dashboard.stripe.com) → API keys → Publishable key (`pk_test_...` or `pk_live_...`) |

**Optional (PostHog analytics):**

| Variable | Where to get it |
|----------|----------------|
| `NEXT_PUBLIC_POSTHOG_KEY` | [PostHog](https://posthog.com) ��� Project Settings → Project API Key |
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
ibx dev start --no-observability           # skip the obs stack (drops funnel records)
```

`ibx dev start` launches [process-compose](https://github.com/F1bonacc1/process-compose), which orchestrates:
1. Docker infrastructure (Postgres, Redis, Typesense, NATS)
2. Observability (VictoriaLogs, VictoriaMetrics, Grafana) — a **default** service
3. Commerce (Medusa) — waits for Docker healthy
4. API — waits for Commerce healthy
5. Web + Admin — wait for Docker healthy
6. (optional) ngrok tunnel + Stripe listener — wait for API healthy

> Observability is a default service on purpose: VictoriaLogs is the **only**
> record of a zero-call funnel turn (L0/L1/L2-fallback/ALIAS write no `turn_trace`
> row), so an outage loses those permanently rather than delaying them. Skipping
> it — with `--no-observability` or `--skip-docker` — prints a yellow
> `Observability OFF` line, and the API prints one `[funnel-sink]` boot warning
> when the sink is unset or unreachable. See
> [docs/cli/reference.md](../cli/reference.md#why-observability-is-a-default-service).

The supervisor's own log — readiness-probe results, restart decisions, exit
codes; the record that diagnoses a process being killed by its own probe — is
written to **`$TMPDIR/ibx-dev-supervisor.log`** (echoed in the `-L` argument
`ibx dev start` prints). It is deliberately *not* process-compose's shared
`$TMPDIR/process-compose-$USER.log` default: process-compose truncates that file
on every startup, including `--dry-run` and `version`, so the CI profile gate and
the test stack used to wipe the running dev stack's log (BKL-288). Per-process
output is separate — reach it with `process-compose process logs <process>`.

### Stop everything

```bash
ibx dev stop          # stop all processes + Docker
ibx dev stop web      # stop only web (keeps others running)
ibx dev stop -f       # force-kill by port (skips process-compose entirely)
ibx dev stop tunnel   # stop only the ngrok tunnel
```

> `-f` bypasses `process-compose down`, so each process's own graceful shutdown
> never runs — prefer plain `ibx dev stop` and keep `-f` for a hung supervisor.
> The force path sweeps the service ports plus process-compose (:8080) and
> ngrok's inspector (:4040), and also kills any ngrok agent pointed at the API
> port by argv — an ngrok started with `--inspect=false` holds no port at all.

### Restart a service

```bash
ibx dev restart web   # restart web without touching others
ibx dev restart       # restart all app services
```

### After pulling / merging (dependency refresh) — BKL-151

Any merge that touches a `package.json` or `pnpm-lock.yaml` changes the dependency
tree. Running the stack against a stale `node_modules` surfaces as an opaque
downstream ghost (e.g. a claims-validate `TypeError` on a shape a newer dep
added), not an obvious "deps are stale" message. **Always refresh in this order
after pulling:**

```bash
git pull
pnpm install          # re-sync node_modules to the updated lockfile
ibx dev stop          # tear the running stack down
ibx dev start         # bring it back up on the fresh deps
```

Guard rail: `ibx dev build` (the build-packages path) **fails closed** when the
installed tree does not match the lockfile, printing
`pnpm-lock.yaml differs from the lockfile pnpm last installed — … Run: pnpm install`
instead of proceeding with a stale build. If you see that error, run
`pnpm install` and retry.

The guard compares **content**, not timestamps: pnpm keeps the lockfile it
actually installed at `node_modules/.pnpm/lock.yaml`, so you can ask the same
question by hand at any time:

```bash
diff -q pnpm-lock.yaml node_modules/.pnpm/lock.yaml   # DIFFERS ⇒ run pnpm install
```

> Until 2026-07-26 the guard compared `pnpm-lock.yaml`'s mtime against
> `node_modules`' mtime. That was wrong in both directions and produced a
> recurring false alarm: a directory's mtime only advances when an entry is
> created or removed inside it, and `pnpm install` rewrites `.modules.yaml`,
> `.pnpm/` and `.bin/` **in place** — so a correct install did not clear the
> error, while an unrelated tool writing a new top-level entry (vite's
> `.vite-temp`) silently did. If you remember "run `pnpm install` twice and it
> goes away", that was why.

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
For local dev without Twilio, enable the OTP bypass (`ibx env toggle IBX_DEV_OTP_BYPASS`) and log in
with `IBX_DEV_OTP_CODE` instead of a real code.

---

## Database Operations

```bash
# Run Medusa migrations (Medusa must NOT be running)
ibx db migrate

# Run Prisma domain migrations
ibx db migrate:domain

# Run the Medusa seed file (Medusa must be running)
ibx db seed

# Seed restaurant Tables + TimeSlots via Prisma
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

## Rebuilding Shared Packages

After editing `packages/types/`, `packages/tools/`, or `packages/domain/`:

```bash
# Rebuild all shared packages (respects dependency order)
npx turbo build --filter=@ibatexas/types --filter=@ibatexas/tools --filter=@ibatexas/domain --filter=@ibatexas/cli --force
```

The build order is: `types` → `tools` → `domain` → `cli` (each depends on the previous). Turbo handles this automatically.

> **When to rebuild:** Any time you change types, add a Prisma model, or modify shared utilities. The API and admin app import from the compiled `dist/` of these packages — stale `dist/` causes `ERR_MODULE_NOT_FOUND` or type errors at runtime.

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
| Docker containers unhealthy | `ibx dev stop && ibx dev` — recreates the containers, keeps your data. Still unhealthy? `ibx svc logs <svc>`, then [destructive last resort](#destructive-last-resort) |
| PG version mismatch (`initialized by PostgreSQL 15, not compatible with 17`) | Point the postgres image back at the old major in `docker-compose.yml`, `docker compose up -d postgres`, then `pg_dump` and restore into the new major. Only if you don't need the data: [destructive last resort](#destructive-last-resort) |
| `relation "X" does not exist` on startup | Run `ibx bootstrap` or manually: `ibx db migrate` then `ibx db migrate:domain` |
| `process-compose: command not found` | `brew install f1bonacc1/tap/process-compose` |
| TUI not rendering | Try `ibx dev start --no-tui` for plain output |
| `Port XXXX already in use` | Ghost process — run `ibx dev stop -f` to force-kill, then retry |
| Admin panel returns 503 on all pages | Server-side `ADMIN_API_KEY` is empty (the API returns 503 when no admin keys are configured). Generate with `openssl rand -base64 32` and set the **same** value for `ADMIN_API_KEY` in both the API and admin app envs — the admin proxy forwards it as the `x-admin-key` header. (There is no `NEXT_PUBLIC_ADMIN_API_KEY`; the key is server-side only.) |

### Destructive last resort

> **`docker compose down -v` PERMANENTLY DELETES ALL LOCAL DATA.** The `-v`
> removes the named volumes for **all four** core services — postgres, redis,
> typesense *and* nats — not just the one you are debugging. Every local order,
> customer, seeded product and stored conversation is gone and is **not
> recoverable**. There is no undo and no backup.

Try `ibx dev stop && ibx dev` first: it recreates the containers while leaving
the volumes intact, which resolves most "unhealthy" states on its own.

Reach for the destructive path only when the data is genuinely disposable:

```bash
docker compose down -v    # removes containers AND all four data volumes
ibx bootstrap             # fresh setup — re-migrates and re-seeds from scratch
```

Two related notes:

- **`docker system prune -f` also removes containers.** It deletes every
  *stopped* container, so running it after `ibx dev stop` (which stops the core
  four rather than removing them) deletes them outright. Named volumes survive;
  recreate with `ibx dev`. Prefer `docker image prune -f` / `docker builder
  prune -f`, which touch no containers.
- **Never add `--remove-orphans`** to a `docker compose` command here. The core
  and observability stacks share the compose project name `ibatexas`, so that
  flag applied to *either* compose file removes the *other* file's running
  containers — restart policy and all.
