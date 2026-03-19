# Phase 4 — Deployment & Infrastructure Fixes

**Date:** 2026-03-18
**Audit source:** `docs/audit/10-infrastructure-ops.md`

---

## Fixes Applied

### INFRA-04 [CRITICAL] — No Dockerfile, no container orchestration

**Files created:**
- `apps/api/Dockerfile` — Multi-stage build: Node 20 Alpine, pnpm workspace install, tsc build, non-root user, exposes 9000
- `apps/web/Dockerfile` — Multi-stage build: Node 20 Alpine, pnpm workspace install, `next build` with standalone output, non-root user, exposes 3000
- `apps/admin/Dockerfile` — Multi-stage build: Node 20 Alpine, pnpm workspace install, `next build` with standalone output, non-root user, exposes 3002
- `docker-compose.prod.yml` — References all 3 app Dockerfiles + infrastructure services (postgres, redis, nats, typesense) with health checks and resource limits

**Files modified:**
- `apps/web/next.config.mjs` — Added `output: "standalone"` for Docker compatibility
- `apps/admin/next.config.mjs` — Added `output: 'standalone'` for Docker compatibility

---

### INFRA-11 [MEDIUM] — Sentry DSN optional, errors silently dropped

**File:** `apps/api/src/index.ts`
**Fix:** Added startup warning when `NODE_ENV=production` and `SENTRY_DSN` is not set. Uses `console.warn` since Sentry init happens before the Fastify server is created.

---

### INFRA-12 [MEDIUM] — Docker Redis has no authentication

**File:** `docker-compose.yml`
**Fix:** Added `command: ["redis-server", "--requirepass", "${REDIS_PASSWORD:-localdev}"]` to Redis service. Updated healthcheck to pass the password. Also applied the same pattern to `docker-compose.prod.yml`.

**File:** `.env.example`
**Fix:** Added `REDIS_PASSWORD=localdev` variable and updated `REDIS_URL` to include the password (`redis://:localdev@localhost:6379`).

---

### INFRA-13 [MEDIUM] — Prisma connection pool not configured

**File:** `packages/domain/src/client.ts`
**Fix:** Added documentation comment explaining how to configure Prisma connection pool via `DATABASE_URL` query params (`connection_limit`, `pool_timeout`).

**File:** `.env.example`
**Fix:** Added comment above `DATABASE_URL` showing pool param syntax for production.

---

### INFRA-15 [LOW] — Docker Compose default password hardcoded

**File:** `.env.example`
**Fix:** Added top-of-file warning: `# WARNING: Change all default passwords for non-local environments`

---

### INFRA-17 [LOW] — Terraform remote state backend commented out

**File:** `infra/terraform/environments/dev/main.tf`
**Fix:** Added `# [AUDIT-REVIEW] Uncomment when S3 backend is provisioned for state persistence` above the commented-out S3 backend block.

---

### SEC-F10 [LOW] — Admin API key has no rotation mechanism

**File:** `apps/api/src/routes/admin/index.ts`
**Fix:** `ADMIN_API_KEY` is now parsed as a comma-separated list of valid keys. During rotation, set `ADMIN_API_KEY=newKey,oldKey` so both are valid. Each key is compared using timing-safe comparison.

---

### SEC-F13 [LOW] — trustProxy not configured in Fastify

**File:** `apps/api/src/server.ts`
**Fix:** Added `trustProxy: process.env.TRUST_PROXY === "true"` to Fastify constructor options.

**File:** `.env.example`
**Fix:** Added `TRUST_PROXY=true` with a comment explaining when to enable it.

---

## Remaining Items (not in scope for this phase)

- INFRA-01, INFRA-02, INFRA-03 — Fixed in prior phases (health check, Anthropic timeout, OpenAI timeout)
- INFRA-05, INFRA-06, INFRA-07, INFRA-08, INFRA-09 — Fixed in prior phases (graceful shutdown, NATS drain, reservation reminder, Twilio timeout)
- INFRA-10, INFRA-14 — Fixed in prior phases (env validation, request timeouts)
- INFRA-16 — Log rotation: deferred to infrastructure/ops tooling (container orchestrators handle log rotation)
