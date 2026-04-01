# IbateXas

AI-powered platform for a Brazilian Smoked House restaurant — food ordering, reservations, and a branded shop.

Monorepo: Next.js storefront, Fastify API, WhatsApp channel, Claude AI agent (25 tools), Medusa v2 commerce, owner admin panel. See [PROJECT_STATE.md](docs/PROJECT_STATE.md) for what works today.

---

## Quick Start

```bash
pnpm install
cp .env.example .env                                        # fill in required keys (see .env.example)
pnpm --filter @ibatexas/cli build && npm link packages/cli   # build + link CLI
brew install f1bonacc1/tap/process-compose                   # process orchestrator
ibx dev start                                                # starts everything in TUI
```

> First time or fresh database? Run `ibx bootstrap` — see [pre-requisites](docs/setup/pre-requisites.md) for details.

Explore commands:

```bash
ibx --help
ibx <command> --help
```

See [docs/cli/reference.md](docs/cli/reference.md) for the full CLI reference (19 commands).

---

## How It Works

See [docs/architecture/](docs/architecture/) for Mermaid diagrams (system context with dual-access paths, module map, browser + agent flows, CI/CD pipeline).

---

## Apps

| App | Path | What |
|-----|------|------|
| Web | `apps/web` | Next.js 14 storefront — PDP, search, cart, checkout, OTP login, order tracking, analytics |
| API | `apps/api` | Fastify REST API — 50 routes, SSE chat stream, Swagger docs |
| Commerce | `apps/commerce` | Medusa v2 — catalog, cart, orders, payments, admin UI |
| Admin | `apps/admin` | Next.js 14 owner admin panel (port 3002) — dashboard, menu, reservations, zones |

For a full list of services and their URLs, see the [Local URLs](docs/setup/local-dev.md#local-urls) section in the setup guide.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, Tailwind CSS, PostHog analytics |
| API | Fastify, TypeScript 5+, Swagger/OpenAPI, Node.js 20+ |
| Agent | Claude Sonnet (Anthropic), tool-use API — 25 tools |
| Commerce | Medusa.js v2 — catalog, cart, orders, payments |
| Auth | Twilio Verify — WhatsApp OTP (no passwords, no Clerk) |
| Database | PostgreSQL 17 (Medusa + Prisma `ibx_domain` schema) |
| Cache | Redis — sessions, CustomerProfile (30d TTL), co-purchase matrix |
| Search | Typesense — full-text + vector product search |
| Events | NATS Core — domain events, analytics pipeline |
| Analytics | PostHog (client-side) + sendBeacon → NATS (server-side) |
| Payments | Stripe (card + PIX) |
| Cloud | AWS sa-east-1 (ECS Fargate, RDS, CloudFront) |

---

## Docs

**Start here:**

| Doc | Contents |
|-----|---------|
| [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) | What works, what's broken, priorities, test strategy |
| [docs/architecture/](docs/architecture/) | System diagrams, module map, CI/CD, "where is X?" |
| [docs/backlog/TODO-BACKLOG.md](docs/backlog/TODO-BACKLOG.md) | Pre-launch backlog — 13 items (Steps 1-3) + post-launch |
| [CLAUDE.md](CLAUDE.md) | AI agent guide — hard rules, naming conventions |

**Setup:**

| Doc | Contents |
|-----|---------|
| [docs/cli/reference.md](docs/cli/reference.md) | Full `ibx` command reference (19 commands) |
| [docs/setup/local-dev.md](docs/setup/local-dev.md) | Prerequisites, env vars, setup |
| [docs/setup/pre-requisites.md](docs/setup/pre-requisites.md) | Bootstrap guide: `ibx bootstrap`, migrations, seeds |
| [docs/setup/supabase.md](docs/setup/supabase.md) | Supabase Postgres setup for staging + production |

**Architecture & Design:**

| Doc | Contents |
|-----|---------|
| [docs/architecture/decisions.md](docs/architecture/decisions.md) | ADRs, cross-cutting patterns |
| [docs/architecture/design/bounded-contexts.md](docs/architecture/design/bounded-contexts.md) | 8 contexts, entity ownership |
| [docs/architecture/design/domain-model.md](docs/architecture/design/domain-model.md) | Prisma schema, entities, NATS events |
| [docs/architecture/design/agent-tools.md](docs/architecture/design/agent-tools.md) | 25 tools — auth level, inputs, outputs |
| [docs/architecture/design/use-cases.md](docs/architecture/design/use-cases.md) | Web vs WhatsApp vs in-person matrix |
| [docs/architecture/design/customer-intelligence.md](docs/architecture/design/customer-intelligence.md) | Recommendations, reviews, co-purchase |

**Ops:**

| Doc | Contents |
|-----|---------|
| [docs/ops/analytics-dashboards.md](docs/ops/analytics-dashboards.md) | Event taxonomy, PostHog dashboards, KPIs |
| [docs/ops/redis-memory.md](docs/ops/redis-memory.md) | Redis key patterns, TTLs, ops commands |
| [docs/features/wishlist.md](docs/features/wishlist.md) | Wishlist feature — client-only, localStorage, MVP scope |
