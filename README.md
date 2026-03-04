# IbateXas

AI-powered platform for a Brazilian Smoked House restaurant — food ordering, reservations, and a branded shop.

Monorepo: Next.js storefront, Fastify API, WhatsApp channel (planned), Claude AI agent with 25 tools, Medusa v2 commerce, owner admin panel.

---

## Quick Start

```bash
pnpm install
cp .env.example .env  # fill in required keys (see .env.example for comments)
ibx dev               # starts everything
```

Explore commands:

```bash
ibx --help
ibx <command> --help
```

See [docs/ibx-cli.md](docs/ibx-cli.md) for the full CLI reference.

---

## How It Works

```
  Customer (Web)    Customer (WhatsApp)    Admin (/admin)
       │                    │                     │
       └─────────┬──────────┘                     │
                 │                                 │
  ┌──────────────▼──────────────────────────────────▼──┐
  │              Fastify API (apps/api)                 │
  │       REST + SSE streaming + OTP auth               │
  │       Swagger UI → /docs                            │
  └──────────┬──────────────────────┬──────────────────┘
             │                      │
     ┌───────▼────────┐     ┌───────▼────────┐
     │  Claude Agent  │────▶│  Agent Tools   │
     │  Orchestrator  │     │  (25 tools)    │
     └───────┬────────┘     └───────┬────────┘
             │                      │
  ┌──────────┼──────────┬───────────┤
  │          │          │           │
  ▼          ▼          ▼           ▼
Medusa     Prisma      Redis     Typesense
(catalog,  (reservas,  (sessions, (product
 shop,      reviews,   profiles,   search)
 orders)    customers)  co-purchase)
  │
  └──── NATS JetStream ──▶ PostHog (analytics)

  ┌──────────────────────────────────────────────────┐
  │           Next.js Storefront (apps/web)           │
  │  PDP · Search · Cart · Checkout · Login · Orders  │
  │  PostHog analytics · sendBeacon → NATS            │
  └──────────────────────────────────────────────────┘
```

---

## Apps

| App | Path | What |
|-----|------|------|
| Web | `apps/web` | Next.js 14 storefront — PDP, search, cart, checkout, OTP login, order tracking, analytics |
| API | `apps/api` | Fastify REST API — 44 routes, SSE chat stream, Swagger docs |
| Commerce | `apps/commerce` | Medusa v2 — catalog, cart, orders, payments, admin UI |
| Agent | `apps/agent` | Claude agent orchestrator (library, runs inside API) |

For a full list of services and their URLs, see the [Local URLs](docs/setup/local-dev.md#local-urls) section in the setup guide.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, Tailwind CSS, PostHog analytics |
| API | Fastify, TypeScript 5+, Swagger/OpenAPI, Node.js 20+ |
| Agent | Claude Sonnet (Anthropic), tool-use API — 25 tools |
| Commerce | Medusa.js v2 — catalog, cart, orders, payments |
| Auth | Twilio Verify — WhatsApp OTP (no passwords, no Clerk) |
| Database | PostgreSQL 15 (Medusa + Prisma `ibx_domain` schema) |
| Cache | Redis — sessions, CustomerProfile (30d TTL), co-purchase matrix |
| Search | Typesense — full-text + vector product search |
| Events | NATS JetStream — domain events, analytics pipeline |
| Analytics | PostHog (client-side) + sendBeacon → NATS (server-side) |
| Payments | Stripe (card + PIX) |
| Cloud | AWS sa-east-1 (ECS Fargate, RDS, CloudFront) |

---

## Docs

| Doc | Contents |
|-----|---------|
| [CLAUDE.md](CLAUDE.md) | AI agent guide — hard rules, naming conventions |
| [docs/ibx-cli.md](docs/ibx-cli.md) | Full `ibx` command reference |
| [docs/setup/local-dev.md](docs/setup/local-dev.md) | Prerequisites, env vars, setup |
| [docs/design/bounded-contexts.md](docs/design/bounded-contexts.md) | 8 contexts, entity ownership |
| [docs/design/domain-model.md](docs/design/domain-model.md) | Prisma schema, entities, NATS events |
| [docs/design/agent-tools.md](docs/design/agent-tools.md) | 25 tools — auth level, inputs, outputs |
| [docs/design/use-cases.md](docs/design/use-cases.md) | Web vs WhatsApp vs in-person matrix |
| [docs/design/customer-intelligence.md](docs/design/customer-intelligence.md) | Recommendations, reviews, co-purchase |
| [docs/analytics-dashboards.md](docs/analytics-dashboards.md) | Event taxonomy, PostHog dashboards, KPIs |
| [docs/ops/redis-memory.md](docs/ops/redis-memory.md) | Redis key patterns, TTLs, ops commands |
| [docs/next-steps.md](docs/next-steps.md) | Roadmap — remaining build steps |
