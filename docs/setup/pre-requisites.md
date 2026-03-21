# Pre-requisites — Bootstrap from Scratch

One command to go from empty database to fully working local environment.

---

## Quick Start

```bash
ibx bootstrap
```

That's it. The command handles Docker, migrations, admin user, and seed data automatically.

---

## What It Does

| Step | Command | Description |
|------|---------|-------------|
| 1 | `docker compose up -d --wait` | Start PostgreSQL, Redis, Typesense, NATS |
| 2 | `pnpm --filter @ibatexas/commerce db:migrate` | Create Medusa tables (orders, products, payments, etc.) |
| 3 | `pnpm --filter @ibatexas/domain db:push` | Create domain tables (reservations, customers, delivery zones, etc.) |
| 4 | `npx medusa user --email ... --password ...` | Create Medusa admin user (from `.env`) |
| 5 | `db:seed:tables` + `db:seed:delivery` | Seed domain data |
| 6 | `ibx svc health` | Verify all infrastructure services are healthy |

---

## When to Use

Run `ibx bootstrap` when:

- **First clone** — fresh checkout, never ran the project before
- **After `docker compose down -v`** — volumes were wiped, database is empty
- **After a PostgreSQL version upgrade** — data directory incompatible, volume deleted
- **After `ibx db reset`** — database was dropped and recreated

---

## Options

```bash
ibx bootstrap --skip-docker    # Docker containers already running
ibx bootstrap --skip-seed      # Only run migrations, skip seeds
```

---

## After Bootstrap

Bootstrap sets up the database but does **not** start Medusa or the app services. Run:

```bash
ibx dev start                  # Start Medusa + apps
ibx db seed                    # Seed Medusa products (requires Medusa running)
ibx db seed:homepage           # Seed customers + reviews (requires Medusa running)
ibx db reindex                 # Index products into Typesense
```

---

## Manual Steps

If you need to run steps individually (e.g., for debugging):

```bash
# 1. Start infrastructure
docker compose up -d --wait

# 2. Medusa migrations
cd apps/commerce && npx medusa db:migrate && cd ../..

# 3. Domain (Prisma) migrations
ibx db migrate:domain
# or: pnpm --filter @ibatexas/domain db:push

# 4. Create Medusa admin user
cd apps/commerce && npx medusa user --email $MEDUSA_ADMIN_EMAIL --password $MEDUSA_ADMIN_PASSWORD && cd ../..

# 5. Seed domain data
ibx db seed:domain
ibx db seed:homepage       # optional: customers + reviews
ibx db seed:delivery       # optional: delivery zones

# 6. Verify
ibx svc health
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Docker daemon is not running` | Open Docker Desktop, wait for it to start, then retry |
| `initialized by PostgreSQL 15, not compatible with 17` | `docker compose down -v && ibx bootstrap` (destroys local data) |
| `relation "X" does not exist` on startup | Migrations haven't run — run `ibx bootstrap` or step 2+3 manually |
| `MEDUSA_ADMIN_EMAIL not set` | Add `MEDUSA_ADMIN_EMAIL` and `MEDUSA_ADMIN_PASSWORD` to your `.env` |
| Port conflicts | `ibx dev stop -f` to force-kill, then retry |
| Seed fails | Non-fatal — review the error and run the specific seed command manually |

---

See also: [local-dev.md](local-dev.md) for daily dev workflow, environment variables, and local URLs.
