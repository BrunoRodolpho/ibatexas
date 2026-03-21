# Supabase Postgres — Setup Guide

> **Staging + production only.** Local dev uses Docker Postgres via `ibx dev`. See [ARCHITECTURE.md](../ARCHITECTURE.md#6-environments--dev-vs-staging-vs-production) for the full environment matrix.

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

Used by Prisma's query engine at runtime. Set as `DATABASE_URL`:

```
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?connection_limit=10&pool_timeout=30&pgbouncer=true
```

- `connection_limit=10` — max connections Prisma opens per instance
- `pool_timeout=30` — seconds to wait for a connection before erroring
- `pgbouncer=true` — tells Prisma to disable prepared statements (incompatible with PgBouncer transaction mode)

### Direct URL (port 5432)

Used by Prisma only for migrations (`ibx db migrate:domain`). Set as `DIRECT_DATABASE_URL`:

```
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
```

Migrations require DDL operations that are incompatible with PgBouncer's transaction mode.

## 3. Configure Environment Variables

Copy the connection strings into your `.env` (never commit this file):

```bash
DATABASE_URL=postgresql://postgres.abcdefghijklmnop:YOUR_PASSWORD@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?connection_limit=10&pool_timeout=30&pgbouncer=true
DIRECT_DATABASE_URL=postgresql://postgres.abcdefghijklmnop:YOUR_PASSWORD@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
```

## 4. Create the Domain Schema

Supabase's default database has `public` and `auth` schemas. IbateXas uses `ibx_domain`:

```sql
-- Run in Supabase SQL Editor (Dashboard → SQL Editor)
CREATE SCHEMA IF NOT EXISTS ibx_domain;
```

## 5. Run Migrations

```bash
ibx db migrate:domain
```

This uses `DIRECT_DATABASE_URL` to apply Prisma migrations against the `ibx_domain` schema.

## 6. Verify

```bash
ibx db status
```

Should show all migrations applied for the domain schema.

---

## Notes

- **Local dev** still uses docker-compose Postgres on port 5433 — no Supabase account needed.
- **RLS (Row-Level Security)** is disabled on `ibx_domain` tables — the API server is the only client and handles authorization in application code.
- Supabase free tier allows 500 MB storage and 2 GB bandwidth. Upgrade to Pro for production workloads.
