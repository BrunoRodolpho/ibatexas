# IbateXas

> Ordering, reservations, and customer intelligence — powered by a Claude-based AI agent.

IbateXas is a Brazilian restaurant. This monorepo is the platform that runs it: web ordering, table reservations, frozen dish delivery, and a WhatsApp-native experience — all driven by a single AI agent instead of a traditional UI flow.

---

## How It Works

A customer opens the web app or sends a WhatsApp message. From that point, a Claude-based agent handles everything — searching the menu, building a cart, checking table availability, placing the order, tracking delivery, and requesting a review afterward. The agent has the same tools and capabilities on both channels.

```
  Web Browser          WhatsApp
      │                    │
      └──────────┬─────────┘
                 │
         ┌───────▼────────┐
         │   Fastify API  │
         │  (SSE stream)  │
         └───────┬────────┘
                 │
         ┌───────▼────────┐       ┌─────────────────┐
         │  Claude Agent  │──────▶│  Agent Tools    │
         │  Orchestrator  │       │  (29 tools)     │
         └───────┬────────┘       └────────┬────────┘
                 │                         │
      ┌──────────┼──────────┬──────────────┤
      │          │          │              │
      ▼          ▼          ▼              ▼
   Medusa     Prisma      Redis       Typesense
  (catalog,  (reservas,  (sessions,  (product
  orders)    reviews)    profiles)    search)
      │
      └──── NATS JetStream ──▶ PostHog (analytics)
```

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, Tailwind CSS, shadcn/ui |
| API | Fastify, TypeScript 5+, Node.js 20+ |
| Agent | Claude Sonnet (Anthropic), tool-use API |
| Commerce | Medusa.js v2 — catalog, cart, orders, payments |
| Auth | Clerk — SMS OTP, no passwords |
| Database | PostgreSQL 15 (reservations, reviews, orders) |
| Cache | Redis — sessions, CustomerProfile (30d TTL) |
| Search | Typesense — full-text product search |
| Events | NATS JetStream — analytics, review triggers |
| Payments | Stripe (card) + Pagar.me (PIX) |
| WhatsApp | Twilio API |
| Address | ViaCEP |
| Tax | Focus NFe |
| Cloud | AWS sa-east-1 (ECS Fargate, RDS, CloudFront) |

---

## Repository

```
apps/
  web/        Next.js storefront + owner dashboard
  api/        Fastify API + SSE agent streaming
  agent/      Claude orchestrator + tool registry
  commerce/   Medusa.js v2 commerce engine
packages/
  types/        Shared TypeScript interfaces
  domain/       Reservation, Review, CustomerProfile — Prisma models
  llm-provider/ Claude adapter behind a model-agnostic interface
  tools/        29 agent tools across 5 bounded contexts
  nats-client/  NATS JetStream wrapper for business events
infra/
  terraform/  AWS infrastructure (ECS, RDS, VPC, CloudFront)
docs/
  design/     Bounded contexts, domain model, use cases, agent tools
  setup/      Local dev guide
```

---

## Quick Start

```bash
cp .env.example .env     # fill in required keys
docker compose up -d     # start PostgreSQL, Redis, Typesense, NATS
pnpm check               # verify all services healthy
pnpm install             # install dependencies
turbo dev                # start all apps
```

---

## Principles

- **Agent-first** — the AI agent is the UX, not a feature added on top
- **Channel parity** — identical capabilities on web and WhatsApp
- **Progressive auth** — browse and add to cart as guest; auth only at checkout (SMS OTP)
- **No hardcoded config** — all runtime values from `.env`; missing required vars crash fast at startup
- **LGPD compliant** — cookie consent, `/privacidade`, `/termos`, WhatsApp opt-in before launch

---

## Phases

| Phase | Scale | Est. Cost |
|---|---|---|
| 1 — Launch | < 1K orders/mo | ~$50–80/mo |
| 2 — Growth | 1K–5K orders/mo | ~$150–200/mo |
| 3 — Scale | 5K–20K orders/mo | ~$300–400/mo |
| 4 — Expansion | 20K+ orders/mo | ~$1K–3.5K/mo |

---

## Documentation

| | |
|---|---|
| [Bounded Contexts](docs/design/bounded-contexts.md) | The 6 contexts, entity ownership, business rules |
| [Domain Model](docs/design/domain-model.md) | Reservation, Review, CustomerProfile, NATS events |
| [Use Cases](docs/design/use-cases.md) | Web vs WhatsApp vs in-person capability matrix |
| [Agent Tools](docs/design/agent-tools.md) | All 29 tools — auth level, inputs, outputs |
| [Customer Intelligence](docs/design/customer-intelligence.md) | Recommendations, reviews, analytics |
| [Local Dev Setup](docs/setup/local-dev.md) | Prerequisites, env vars, running locally |
| [Next Steps](docs/next-steps.md) | Current state + 12-step Phase 1 build order |
