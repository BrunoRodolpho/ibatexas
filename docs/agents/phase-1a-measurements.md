# Phase 1a measurements

Measured numbers that re-baseline plan-v2 budgets. Append new sections per
task; never rewrite recorded history.

## T1a-11b — test-stack boot + seed wall-clock (re-baselines §7)

Measured 2026-06-12 by `./scripts/test-stack-up.sh` (the canonical launcher;
prints an `IBX_TEST_STACK_TIMINGS` line) on a **fully cold stack**: fresh
containers + volumes (`docker compose -p ibx-test down -v` beforehand), empty
Postgres/Redis/Typesense/NATS, Docker images already pulled, node_modules
installed, `ibx` CLI prebuilt. Local dev machine (Apple Silicon, macOS 14.4,
Docker Desktop 29.5.3), process-compose v1.103.0.

```
IBX_TEST_STACK_TIMINGS infra=5s migrate=12s apps=18s seed=22s total=57s
```

| Step | What | Wall-clock |
|------|------|-----------:|
| 1/4 infra | `docker compose --env-file .env.test -f docker-compose.test.yml -p ibx-test up -d --wait` (postgres+redis+typesense+nats healthy) | 5 s |
| 2/4 migrate | `ibx db provision` (kernel audit-postgres 10 migrations + 5 intent_audit partitions; claustrum 5 migrations + 5 partitions) + `ibx bootstrap --skip-docker --skip-seed` (Medusa migrations, Prisma db push, kernel/claustrum no-op re-check, Medusa admin user) | 12 s |
| 3/4 apps | `process-compose up -f process-compose.test.yaml -e .env.test -D -p 28505` (build-packages one-shot, Medusa :9000 ready, api :3001 `/health` 200) | 18 s |
| 4/4 seed | `ibx db reindex` (creates the Typesense collection on virgin infra) + `ibx test seed` (9/9 pipeline steps: 30 products, reindex, domain, homepage, delivery, orders, reviews sync, co-purchase, global scores) | 22 s |
| **total** | **boot + seed** | **57 s** |

**Re-baseline vs plan §7:** the planning budget was ≤15 min in CI *including
pnpm install/build*. Measured boot+seed alone is **~1 min locally** — over an
order of magnitude inside budget. For CI, add pnpm install + turbo build +
docker image pulls on a GH-hosted runner (the dominant cost); the boot+seed
share is no longer the risk item. The parallelization tripwire input (per-run
stack cost) should use ~1–2 min, not 15.

Caveats:
- Local measurement; GH-hosted runners are slower (slower disk/CPU, cold
  Docker layer cache). Expect a small multiple, not parity — T1b-4's first
  nightly run should append its own number here.
- The run measured predates the T1a-9 oracle-role provisioning step appended
  to step 2/4 (`scripts/test-stack/provision-oracle-role.sh`, a single psql
  round-trip) — impact is negligible.
- Found-and-fixed during measurement (each was a fail-stop on virgin infra,
  invisible on the dev stack whose volumes persist): test postgres image
  needed pgvector (`pgvector/pgvector:pg17`); `ibx db provision` must run
  BEFORE `ibx bootstrap` (split kernel-migration ledgers); Medusa honors the
  `PORT` env (pinned to 9000 for the commerce process); the Typesense
  products collection must exist before the Medusa seed script runs.
