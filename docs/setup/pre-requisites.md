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

8 steps when seeding, 6 with `--skip-seed` (steps 7 and 8 are the seed and verify pass).

| Step | Command | Description |
|------|---------|-------------|
| 1 | `docker compose up -d --wait` | Start PostgreSQL, Redis, Typesense, NATS |
| 2 | `pnpm --filter @ibatexas/commerce db:migrate` | Create Medusa tables (orders, products, payments, etc.) |
| 3 | `pnpm --filter @ibatexas/domain db:push` | Create domain tables (reservations, customers, delivery zones, etc.) |
| 4 | `applyAuditPostgresMigrations(DATABASE_URL)` | Apply `@adjudicate/audit-postgres` kernel audit schema |
| 5 | `migrateClaustrumDatabase()` | Provision `@claustrum` memory + grounding (pgvector) schema + episodic partitions |
| 6 | `npx medusa user --email ... --password ...` | Create Medusa admin user (from `.env`) |
| 7 | `db:seed:tables` + `db:seed:delivery` | Seed domain data (only without `--skip-seed`) |
| 8 | `ibx svc health` | Verify all infrastructure services are healthy (only without `--skip-seed`) |

Steps that warn instead of failing the run:

- **4 and 5** are skipped (warn) when `DATABASE_URL` is not set in `.env` — the kernel and claustrum schemas are then **not** provisioned, and the conductor's audit / memory recall / grounding will fail at runtime.
- **6** warns (does not fail) if the admin user already exists, or is skipped when `MEDUSA_ADMIN_EMAIL` / `MEDUSA_ADMIN_PASSWORD` are unset.
- **7** seed failures are non-fatal.

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
ibx dev start                  # Start all services (TUI)
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

# 4. Kernel audit + claustrum memory/grounding schemas (needs DATABASE_URL)
ibx db provision           # both layers, idempotent
# or one layer each: ibx kernel migrate / ibx claustrum migrate

# 5. Create Medusa admin user (warns if it already exists)
cd apps/commerce && npx medusa user --email $MEDUSA_ADMIN_EMAIL --password $MEDUSA_ADMIN_PASSWORD && cd ../..

# 6. Seed domain data
ibx db seed:domain
ibx db seed:homepage       # optional: customers + reviews
ibx db seed:delivery       # optional: delivery zones

# 7. Verify
ibx svc health
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Docker daemon is not running` | Open Docker Desktop, wait for it to start, then retry |
| `initialized by PostgreSQL 15, not compatible with 17` | Postgres has no in-place major upgrade. **Keep your data:** point the postgres image back at the old major in `docker-compose.yml`, `docker compose up -d postgres`, then `pg_dump` and restore into the new major. **Only if the data is disposable:** [destructive last resort](#destructive-last-resort) |
| `relation "X" does not exist` on startup | Migrations haven't run — run `ibx bootstrap`, or steps 2-5 manually |
| Conductor boots but memory/grounding/audit fail | Kernel + claustrum schemas weren't provisioned (`DATABASE_URL` unset during bootstrap) — set it and run `ibx db provision` |
| `MEDUSA_ADMIN_EMAIL not set` | Add `MEDUSA_ADMIN_EMAIL` and `MEDUSA_ADMIN_PASSWORD` to your `.env` |
| Port conflicts | `ibx dev stop -f` to force-kill, then retry |
| Seed fails | Non-fatal — review the error and run the specific seed command manually |

### Destructive last resort

> **`docker compose down -v` PERMANENTLY DELETES ALL LOCAL DATA.** The `-v`
> removes the named volumes for **all four** core services — postgres, redis,
> typesense *and* nats — not just the one you are debugging. Every local order,
> customer, seeded product and stored conversation is gone and is **not
> recoverable**. There is no undo and no backup.

Try `ibx dev stop && ibx dev` first — it recreates the containers with the
volumes intact. Use the destructive path only when the data is disposable:

```bash
docker compose down -v    # removes containers AND all four data volumes
ibx bootstrap             # fresh setup — re-migrates and re-seeds from scratch
```

Note that `docker system prune -f` removes every *stopped* container, so running
it after `ibx dev stop` deletes the core four outright (named volumes survive —
recreate with `ibx dev`). And never add `--remove-orphans`: the core and
observability stacks share the compose project name `ibatexas`, so that flag on
*either* compose file removes the *other* file's running containers.

---

See also: [local-dev.md](local-dev.md) for daily dev workflow, environment variables, and local URLs.
