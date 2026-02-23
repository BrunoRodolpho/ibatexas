# IbateXas

AI-powered platform for a Brazilian Smoked House restaurant — food ordering, reservations, and a branded shop.

IbateXas is a Brazilian restaurant specializing in smoked meats. This monorepo is the full platform: web storefront, WhatsApp channel, AI ordering agent, and owner admin panel.

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

See [docs/IBX-CLI.md](docs/IBX-CLI.md) for the full CLI reference.

---

## How It Works

```
  Customer (Web)    Customer (WhatsApp)    Admin (/admin)
       │                    │                     │
       └─────────┬──────────┘                     │
                 │                                 │
     ┌───────────▼─────────────────────────────────▼──┐
     │                   Fastify API                   │
     │          (REST + SSE streaming + auth)          │
     └───────────┬─────────────────────┬──────────────┘
                 │                     │
         ┌───────▼────────┐    ┌───────▼────────┐
         │  Claude Agent  │───▶│  Agent Tools   │
         │  Orchestrator  │    │  (29 tools)    │
         └───────┬────────┘    └───────┬────────┘
                 │                     │
      ┌──────────┼──────────┬──────────┤
      │          │          │          │
      ▼          ▼          ▼          ▼
   Medusa     Prisma      Redis    Typesense
 (catalog,  (reservas,  (sessions, (product
  shop,      reviews)   profiles)   search)
  orders)
      │
      └──── NATS JetStream ──▶ PostHog (analytics)
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, Tailwind CSS, shadcn/ui |
| API | Fastify, TypeScript 5+, Node.js 20+ |
| Agent | Claude Sonnet (Anthropic), tool-use API |
| Commerce | Medusa.js v2 — catalog, cart, orders, payments |
| Auth | Twilio Verify — WhatsApp OTP (no passwords, no Clerk) |
| Database | PostgreSQL 15 (Medusa + Prisma) |
| Cache | Redis — sessions, CustomerProfile (30d TTL) |
| Search | Typesense — full-text product search |
| Events | NATS JetStream — analytics, review triggers |
| Payments | Stripe (card) + Pagar.me (PIX) |
| Cloud | AWS sa-east-1 (ECS Fargate, RDS, CloudFront) |

---

## Docs

| Doc | Contents |
|-----|---------|
| [CLAUDE.md](CLAUDE.md) | AI agent guide — hard rules, naming conventions |
| [docs/IBX-CLI.md](docs/IBX-CLI.md) | Full `ibx` command reference |
| [docs/setup/local-dev.md](docs/setup/local-dev.md) | Prerequisites, env vars, setup |
| [docs/design/bounded-contexts.md](docs/design/bounded-contexts.md) | 8 contexts, entity ownership |
| [docs/design/domain-model.md](docs/design/domain-model.md) | Reservation, Review, CustomerProfile |
| [docs/design/agent-tools.md](docs/design/agent-tools.md) | 29 tools — auth level, inputs, outputs |
| [docs/design/use-cases.md](docs/design/use-cases.md) | Web vs WhatsApp vs in-person matrix |
| [docs/design/customer-intelligence.md](docs/design/customer-intelligence.md) | Recommendations, reviews |
| [docs/next-steps.md](docs/next-steps.md) | Roadmap — current step + upcoming build order |
