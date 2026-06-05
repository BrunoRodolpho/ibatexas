# Database lifecycle — provisioning & cleaning the four table layers

The IbateXas runtime stores everything in **one Postgres database** (`DATABASE_URL`,
Postgres 17), but the tables come from **four independent sources**. The `ibx db`
commands manage all of them from a single registry
([`packages/cli/src/lib/db-tables.ts`](../../packages/cli/src/lib/db-tables.ts)) so
clean / provision / status can never silently miss a table again.

## The four layers

| Layer | Tables | Source | Provisioned by | `db clean` default |
|---|---|---|---|---|
| **domain** | 20 business/observability Prisma models (`reservations`, `customers`, `order_projections`, `order_event_log`, `payments`, `conversations`, …) | `@ibatexas/domain` Prisma schema | `db migrate:domain` / `db push` | ✅ wiped |
| **reference** | `staff`, `weekly_schedules`, `holidays`, `schedule_overrides` | same Prisma schema | same | ⛔ preserved (use `--reference`/`--all`) |
| **kernel** | `intent_audit` (partitioned), `governance_events`, `audit_guard_stats`, `audit_outcomes` | `@adjudicate/audit-postgres` SQL migrations | `ibx kernel migrate` | ⛔ preserved (use `--kernel`/`--all`) |
| **memory** | `claustrum_memory_{episodic(partitioned),semantic,procedural,relational}`, `claustrum_grounding_docs` (pgvector) | `@claustrum/*` SQL migrations | `ibx claustrum migrate` | ⛔ preserved (use `--memory`/`--all`) |

Two bookkeeping tables — `adjudicate_audit_migrations` and `claustrum_migrations` —
track which SQL migration files have been applied. They record *schema*, not data,
so **`db clean` never truncates them** (truncating would make provisioning re-run
migrations).

> Not in Postgres: structured **logs** live in VictoriaLogs (`:9428`, a Docker
> container), queried via `ibx logs` / `ibx obs`. They are not a table layer and are
> out of scope for `db clean`.

## Provisioning

```bash
ibx db provision     # idempotent: ensure Medusa + domain + kernel + claustrum schemas exist
ibx bootstrap        # full setup: Docker → migrations (all 4 layers) → admin → seed → verify
ibx db reset --force # ⚠️ DROP DATABASE, then recreate ALL four layers + reseed
```

`db provision` is non-destructive and safe to re-run — it's the building block
`bootstrap` and `reset` call. The kernel and memory layers can also be applied on
their own:

```bash
ibx kernel migrate      # intent_audit + companions + monthly partitions
ibx claustrum migrate   # claustrum memory + grounding + episodic partitions + pgvector
```

Both runners (a) apply each SQL file exactly once via a tracking table, and (b)
pre-create the monthly partitions the RANGE-partitioned parents (`intent_audit`,
`claustrum_memory_episodic`) need before any row can be written. Ongoing
month-rollover is operational (pg_partman or a monthly re-run).

**pgvector:** the claustrum grounding migration runs `CREATE EXTENSION IF NOT EXISTS
vector`. This requires (a) the extension to be **available in the Postgres image**
— dev uses `pgvector/pgvector:pg17` in [docker-compose.yml](../../docker-compose.yml),
not stock `postgres` (which would fail with `extension "vector" is not available`) —
and (b) a superuser role to create it (the dev role is one; on managed Postgres a DBA
enables pgvector once). Claustrum's memory tables (001–004) have no such dependency;
only `claustrum_grounding_docs` does, so a missing extension fails just that one
migration — re-run `ibx claustrum migrate` after fixing the image to finish.

## Cleaning

`db clean` defaults to **domain business data only**, so the audit trail and memory
are preserved unless you ask for them. Raw-SQL layers are emptied with `TRUNCATE …
RESTART IDENTITY` (partitioned parents cascade to their partitions automatically;
the schema is kept).

```bash
ibx db clean                  # domain business data (+ Redis cache)
ibx db clean --dry-run        # per-table row counts that WOULD be deleted; deletes nothing
ibx db clean --kernel         # + kernel audit trail
ibx db clean --memory         # + claustrum memory
ibx db clean --reference      # + staff/schedules config
ibx db clean --all            # + Medusa products + Typesense index
```

| command | domain | reference | kernel | memory | Medusa/TS | Redis |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `db clean` | ✓ | | | | | ✓ |
| `db clean --kernel` | ✓ | | ✓ | | | ✓ |
| `db clean --memory` | ✓ | | | ✓ | | ✓ |
| `db clean --reference` | ✓ | ✓ | | | | ✓ |
| `db clean --all` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

`db clean` is a **manual dev reset** (blocked when `NODE_ENV=production`). It is
distinct from the scheduled, time-windowed production purge in
[`retention-cleaner`](../../apps/api/src/jobs/retention-cleaner.ts), which trims
`order_event_log` + `conversation_messages` older than `RETENTION_DAYS` and leaves
the order ledger intact. The two never overlap in purpose.

## Status

```bash
ibx db status   # migration status + per-table row counts for ALL four layers,
                # plus partition counts and whether the pgvector extension is installed
```

## Adding a new table — don't let the registry drift

When you add a table (a Prisma `model`, or a `CREATE TABLE` in an adjudicate/claustrum
migration), add it to the matching list in
[`db-tables.ts`](../../packages/cli/src/lib/db-tables.ts). The drift-guard test
[`__tests__/db-tables.drift.test.ts`](../../packages/cli/src/__tests__/db-tables.drift.test.ts)
diffs the registry against the Prisma schema and the migration files and **fails CI**
if anything is unregistered — so clean/provision/status stay complete by construction.

### Overrides (CI / non-standard layouts)

The SQL migration dirs are auto-located in sibling checkouts (`../adjudicate`,
`../claustrum`) and `node_modules`. To point elsewhere:

```bash
ADJUDICATE_AUDIT_MIGRATIONS_DIR=/path/to/audit-postgres/migrations
CLAUSTRUM_MIGRATIONS_DIR=/path/to/memory-postgres/migrations,/path/to/grounding-pgvector/migrations  # comma-separated
```
