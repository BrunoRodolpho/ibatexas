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

## T1a-13 — JOURNEY-001 measured token/cost split (re-baselines §7)

Measured 2026-06-12: two consecutive `ibx journey run JOURNEY-001 --k 2
--json` acceptance runs (4 green attempts total, both exit 0, all
certifying — `ANTHROPIC_MODEL=claude-sonnet-4-6` on driver AND SUT) against
the live ephemeral test stack, after the T1a-13 live corrections (JOURNEY-001
v2: order assembly via the storefront HTTP API, chat confirm-gate leg, HTTP
cancel completion — see the journey header and `decisions.md`).

Dollar source: per-call `llm.call` events (driver captured in-process,
`source:"driver"`; SUT re-emitted from the api TelemetryPort to
IBX_EVENTS_FILE, `source:"sut"`, session-scoped) × the checked-in price table
(`packages/journeys/governance/price-table.json`: Sonnet 4.6 $3/MTok in,
$15/MTok out — plan §7).

| Run.attempt | Result | Turns | Wall-clock | Driver tokens (in/out) | SUT tokens (in/out) | Driver $ | SUT $ | Total $ |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1.1 | PASS | 3 | 37.1 s | 7 934 / 643 | 5 833 / 594 | $0.0334 | $0.0264 | $0.0599 |
| 1.2 | PASS | 3 | 30.5 s | 7 893 / 558 | 5 761 / 520 | $0.0320 | $0.0251 | $0.0571 |
| 2.1 | PASS | 3 | 31.5 s | 7 841 / 548 | 5 755 / 535 | $0.0317 | $0.0253 | $0.0570 |
| 2.2 | PASS | 3 | 39.7 s | 7 856 / 462 | 5 737 / 476 | $0.0305 | $0.0244 | $0.0548 |
| **mean** | — | 3 | **34.7 s** | **7 881 / 552** | **5 771 / 531** | **$0.0319** | **$0.0253** | **$0.0572** |

Cost lines (verbatim):
```
run 1: cost[total]: $0.1170 across 2 attempt(s) (driver $0.0655; sut $0.0515)  → exit 0
run 2: cost[total]: $0.1119 across 2 attempt(s) (driver $0.0622; sut $0.0496)  → exit 0
```

**§7 re-baseline.** The plan estimated **$0.08–0.15 SUT-side** for an 8-turn
journey and noted the driver "likely costs as much or more", with a
**$0.50/attempt combined planning ceiling**. Measured reality for the
corrected JOURNEY-001: **$0.057/attempt combined** (driver $0.032 / SUT
$0.025 — the driver side is ~1.26× the SUT side, confirming the plan's
direction). The attempt runs only **3 Conductor turns** (the corrected
journey assembles the order over HTTP, so chat turns are the cancel leg
plus driver framing), which is why the SUT side lands ~3× below the 8-turn
estimate band — per-turn SUT cost is ≈ $0.008 (≈1.9k in / ≈180 out per
turn), extrapolating to ≈ $0.07 for a true 8-turn journey, inside the
plan's band. The $0.50 ceiling is ~9× the measured combined cost — keep it
as the abort threshold (it leaves room for the chat-order-assembly journey
variant once that product gap closes and for richer responder synthesis,
both of which will raise per-turn input sizes). Nightly projection at
measured rates: 22 attempts ≈ **$1.3/night** for JOURNEY-001-class
journeys — an order of magnitude inside the $11 planning number and the
$50 hard abort.

Wall-clock: ~35 s/attempt (≈70 s per `--k 2` run) — well inside the 2–5 min
planning band and the 10-min per-attempt timeout.

Caveats:
- The driver input tokens are dominated by the act-goal/persona framing and
  tool-result accumulation (4 driver calls per attempt; ~7.9k in). A journey
  with more chat acts grows roughly linearly in driver calls.
- SUT-side events are TURN-level aggregates (planner + responder usage
  summed on the TurnRecord) — per-call split inside a turn lands when
  emitLLMTrace is implemented.
- Costs exclude the projector/subscriber plane (no LLM there) and Medusa.
