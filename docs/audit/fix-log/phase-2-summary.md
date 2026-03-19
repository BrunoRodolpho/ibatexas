# Phase 2 Summary — Infrastructure Hardening

**Date:** 2026-03-18
**Status:** Complete
**Test Results:** 1,494 tests passing across 109 test files

---

## Agent 2A — Redis & State Management (10 findings)

| ID | Severity | Status | Description |
|---|---|---|---|
| REDIS-C01 | C | Fixed | TTLs on 6 unbounded key patterns (copurchase 30d, global:score 30d, active:carts 48h, cache:stats 30d, review:prompt 1d) |
| REDIS-C02 | C | Fixed | 7-day TTL on customer:recentlyViewed |
| REDIS-H01 | H | Fixed | Singleton TOCTOU → promise-based mutex |
| REDIS-H02 | H | Fixed | Error handler no longer nullifies client |
| REDIS-H03/WA-H01 | H | Fixed | Agent lock keyed by phoneHash |
| WA-H02 | H | Fixed | Post-lock re-check for unprocessed messages |
| REDIS-M01 | M | Fixed | Fail-fast on missing APP_ENV in production |
| REDIS-M03 | M | Fixed | EXPIRE unconditional on all 4 rate limiters |
| REDIS-M04 | M | Fixed | Abandoned cart uses actual lastActivity |
| REDIS-M02 | M | Fixed | redis-memory.md regenerated |

## Agent 2B — Timeouts & Graceful Shutdown (11 findings)

| ID | Severity | Status | Description |
|---|---|---|---|
| INFRA-01 | C | Fixed | Deep health check (Redis, Postgres, NATS, Typesense) |
| INFRA-02 | C | Fixed | Anthropic timeout: 60s |
| INFRA-03 | C | Fixed | OpenAI embeddings timeout: 10s |
| INFRA-05 | H | Fixed | Shutdown closes Redis + Prisma |
| INFRA-06 | H | Fixed | NATS drain() instead of close() |
| INFRA-07 | H | Fixed | Removed NATS finally block race |
| INFRA-08 | H | Fixed | Reservation reminder job started |
| INFRA-09 | H | Fixed | Twilio timeout: 10s |
| EVT-F02 | H | Fixed | isRunning guard on all jobs |
| AI-F04 | H | Fixed | SSE streams capped at 1000 |
| INFRA-14 | M | Fixed | Fastify request/connection timeouts |

## Agent 2C — NATS Events & Config (7 findings)

| ID | Severity | Status | Description |
|---|---|---|---|
| EVT-F01 | C | Fixed | Redis-backed outbox for order.placed + reservation.created |
| EVT-F04 | H | Fixed | Dead events audited — 33+ removed, 5 kept with review tags |
| EVT-F07 | M | Fixed | Subscribers registered before jobs |
| EVT-F08 | M | Fixed | Cash checkout order.placed includes items |
| EVT-F10 | M | Fixed | Batch search.results_viewed replaces O(n) events |
| AI-F03 | H | Fixed | Per-session 100K token daily budget |
| INFRA-10 | M | Fixed | Config validation for critical env vars |

---

## Totals

- **Findings fixed:** 28 (5 Critical, 13 High, 10 Medium)
- **Tests:** 1,494 passing / 0 failing
