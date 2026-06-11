# Supabase Postgres — Setup Guide

> **Staging + production only.** Local dev uses Docker Postgres via `ibx dev`. See [architecture](../architecture/#5-environments--dev-vs-staging-vs-production) for the full environment matrix.

IbateXas uses **Supabase** managed Postgres in staging and production.

---

## 1. Create the Supabase Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and create a new project.
2. Region: **South America (São Paulo) — sa-east-1**.
3. Set a strong database password — you will need it for connection strings.
4. Note your **Project Reference** (e.g., `abcdefghijklmnop`).

## 2. Connection Strings

Supabase provides two connection endpoints. Both are required.

### Pooler URL (PgBouncer — port 6543)

The runtime query connection. Set as `DATABASE_URL`:

```
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?connection_limit=10&pool_timeout=30&pgbouncer=true
```

- `connection_limit=10` — max connections Prisma opens per instance
- `pool_timeout=30` — seconds to wait for a connection before erroring
- `pgbouncer=true` — tells Prisma to disable prepared statements (incompatible with PgBouncer transaction mode)

### Direct URL (port 5432)

The migration connection. Migrations need DDL that is incompatible with PgBouncer's transaction mode, so they must run against the direct (5432) host, not the pooler.

```
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
```

This URL is stored as a **GitHub secret** — `DIRECT_DATABASE_URL` for production, `STAGING_DIRECT_DATABASE_URL` for staging (separate secrets; see `packages/cli/src/commands/infra.ts`). The deploy workflows do **not** keep a `DIRECT_DATABASE_URL` env var — they pass the secret in as `DATABASE_URL` for the migration step (see §4).

## 3. Configure Environment Variables

Copy the connection strings into your `.env` (never commit this file):

```bash
DATABASE_URL=postgresql://postgres.abcdefghijklmnop:YOUR_PASSWORD@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?connection_limit=10&pool_timeout=30&pgbouncer=true
```

`DATABASE_URL` is the only var the `@ibatexas/domain` Prisma package reads (via `packages/domain/prisma.config.ts`). The direct (5432) URL is only needed when **running a migration** (§4) — point `DATABASE_URL` at it for that command, then switch back to the pooler URL for runtime.

## 4. Run Migrations

The `ibx_domain` schema is created by the baseline migration itself (`packages/domain/prisma/migrations/20260319000000_baseline/migration.sql` → `CREATE SCHEMA IF NOT EXISTS "ibx_domain"`). No manual `CREATE SCHEMA` step is required.

### In CI (automatic)

On deploy, `prisma migrate deploy` runs against the direct host. The workflows set `DATABASE_URL` from the direct secret:

- production — `.github/workflows/deploy.yml` (`DIRECT_DATABASE_URL`)
- staging — `.github/workflows/deploy-staging.yml` (`STAGING_DIRECT_DATABASE_URL`)

### Manually (authoring a new migration, or applying to a remote DB)

`ibx db migrate:domain` runs `prisma migrate dev` against whatever `DATABASE_URL` currently points at:

```bash
ibx db migrate:domain
```

To author or apply a migration against a Supabase environment from your workstation, set `DATABASE_URL` to the **direct (5432)** URL first — the pooler URL will fail on DDL.

## 5. Verify

```bash
ibx db status
```

Shows migration status for the domain (Prisma) and Medusa schemas.

---

## Notes

- **Local dev** uses docker-compose Postgres — no Supabase account needed.
- **ECS Fargate + IPv6**: The legacy direct host (`db.<ref>.supabase.co`) resolves to IPv6 only, and ECS Fargate has no IPv6 outbound by default, so the runtime `DATABASE_URL` **must** use the pooler host (`aws-0-sa-east-1.pooler.supabase.com:6543`). The direct host would cause `ENETUNREACH`. (The 5432 pooler endpoint above avoids this for migrations.)
- **RLS (Row-Level Security)** is disabled on `ibx_domain` tables — the API server is the only client and handles authorization in application code.
- Supabase free tier allows 500 MB storage and 2 GB bandwidth. Upgrade to Pro for production workloads.
