# IbateXas

AI-native commerce platform for Brazil.
Customers shop through a full web storefront and WhatsApp — both powered by the same Claude-based agent that searches products, manages carts, and drives checkout.

---

**Target market:** Brazilian food & goods e-commerce
**Primary language:** Portuguese (pt-BR)
**Core differentiator:** One agent, two channels — same cart, same tools, same experience on desktop, mobile browser, and WhatsApp

---

## Architecture

```
Customer (Web / WhatsApp)
        │
        ▼
   API Gateway (Fastify)
        │
   ┌────┴────┐
   │         │
   ▼         ▼
 Agent    Commerce
(Claude)  (Medusa)
   │         │
   └────┬────┘
        │
   PostgreSQL + Redis + Typesense
```

### Four Applications

| App | Role |
|---|---|
| `apps/web` | Next.js storefront (desktop + mobile) |
| `apps/api` | Fastify API + SSE streaming |
| `apps/agent` | Claude orchestrator + tool registry |
| `apps/commerce` | Medusa.js v2 commerce engine |

### Five Shared Packages

| Package | Role |
|---|---|
| `@ibatexas/types` | Shared TypeScript types |
| `@ibatexas/domain` | Domain models (conversations, events) |
| `@ibatexas/llm-provider` | Claude adapter + provider interface |
| `@ibatexas/tools` | Agent tool definitions + registry |
| `@ibatexas/nats-client` | NATS event bus wrapper |

---

## Technology Stack

### Frontend
- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript 5+
- **Styling:** Tailwind CSS + shadcn/ui
- **Auth:** Clerk
- **Analytics:** PostHog

### Backend
- **API:** Fastify
- **Language:** TypeScript 5+ / Node.js 20+
- **ORM:** Prisma
- **Commerce:** Medusa.js v2
- **Validation:** Zod

### AI
- **Primary LLM:** Claude Sonnet 4 (Anthropic)
- **Fallback LLM:** GPT-4o (OpenAI)
- **Embeddings:** Voyage AI
- **Vector store:** Pinecone
- **Abstraction:** Custom `LLMProvider` interface (swap models without code changes)

### Data
- **Primary DB:** PostgreSQL 15+ (AWS RDS)
- **Cache + Sessions:** Redis (Upstash)
- **Search:** Typesense
- **Event streaming:** NATS JetStream
- **Analytics DB:** ClickHouse (Phase 2+)

### Infrastructure
- **Cloud:** AWS (sa-east-1 — São Paulo)
- **Compute:** ECS Fargate
- **IaC:** Terraform
- **CI/CD:** GitHub Actions
- **CDN:** CloudFront
- **DNS:** Route 53
- **Secrets:** AWS Secrets Manager

### Observability
- **Errors:** Sentry
- **Product analytics:** PostHog
- **Uptime:** BetterStack
- **Metrics/Logs/Traces:** Prometheus + Grafana Loki + Grafana Tempo (Phase 2+)

### External Services (Brazil)
- **WhatsApp:** Twilio API
- **Payments:** Stripe + Pagar.me (PIX, boleto, credit card)
- **Shipping:** Correios + EasyPost
- **Address lookup:** ViaCEP
- **Tax invoices:** Focus NFe

---

## Agent Tools

The agent interacts with commerce exclusively through typed, authorized tools. It cannot hallucinate prices or inventory — all facts come from tool responses.

| Tool | What it does |
|---|---|
| `search_products` | Full-text product search via Typesense |
| `get_product_details` | Product info, price, nutritional data |
| `check_inventory` | Real-time stock check (FEFO-aware) |
| `add_to_cart` | Add item, validates stock first |
| `update_cart` | Change quantity of existing cart item |
| `remove_from_cart` | Remove item from cart |
| `create_checkout` | Generate checkout session (PIX/boleto/card) |
| `estimate_delivery` | Delivery time + cost via CEP |
| `check_order_status` | Order tracking for authenticated customer |
| `get_nutritional_info` | ANVISA nutritional data per product |
| `handoff_to_human` | Escalate to human support agent |

Authorization is enforced per tool, not per route. A guest can browse but not checkout. A customer cannot access another customer's orders.

---

## Quick Start

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Verify everything is healthy
pnpm check

# 3. Install dependencies
pnpm install

# 4. Start all apps
turbo dev
```

Full setup guide: [docs/setup/local-dev.md](docs/setup/local-dev.md)

---

## Repository Structure

```
ibatexas/
├── apps/
│   ├── web/          Next.js 14 storefront (desktop + mobile)
│   ├── api/          Fastify API + SSE streaming
│   ├── agent/        Claude orchestrator + tool registry
│   └── commerce/     Medusa.js v2 commerce engine
├── packages/
│   ├── types/        Shared TypeScript types
│   ├── domain/       Domain models (conversations, events)
│   ├── llm-provider/ Claude adapter + LLMProvider interface
│   ├── tools/        Agent tool definitions + registry
│   └── nats-client/  NATS JetStream wrapper
├── infra/
│   └── terraform/    AWS infrastructure (ECS, RDS, VPC)
├── scripts/
│   └── local/        Dev tooling (healthcheck.sh)
├── docs/
│   ├── setup/        Local dev setup guide
│   └── next-steps.md Phase 1 build order + current state
├── docker-compose.yml Local infrastructure
└── .env.example      All required environment variables
```

---

## Rollout Phases

### Phase 1 — Launch (~$50–80/mo, under 1K users/month)
- Hosted on a single ECS Fargate task (1 vCPU, 2GB RAM)
- RDS PostgreSQL `db.t3.micro`, Upstash Redis free tier, Typesense Cloud starter
- Claude API costs ~$10–20/mo at low volume
- **Goal:** first paying customers, validate product-market fit

### Phase 2 — Growth (~$150–200/mo, 1K–5K users/month)
- Scale ECS tasks, upgrade RDS to `db.t3.small`
- Add WhatsApp channel (Twilio)
- Enable Pagar.me for PIX and boleto payments
- **Goal:** repeat customers, first revenue milestone

### Phase 3 — Scale (~$300–400/mo, 5K–20K users/month)
- Multi-AZ RDS, Redis cluster, Typesense cluster
- Add ClickHouse for analytics, Sentry for error tracking
- **Goal:** reliable operations, data-driven decisions

### Phase 4 — Expansion (~$1K–3.5K/mo, 20K+ users/month)
- CDN (CloudFront), auto-scaling, dedicated infrastructure per service
- Full observability stack (Grafana, Prometheus, Loki)
- **Goal:** regional expansion, multiple store support

---

## Design Principles

### Responsive-first
The web storefront is designed for 375px (mobile) first and scales to desktop. The majority of Brazilian users shop from their phones. Every UI decision — tap target sizes (min 44px), font sizes, layout — is validated at mobile width first.

### Channel parity
Every user action available on web is available on WhatsApp, and vice versa. The agent, tools, cart, and checkout are shared. There is no "mobile lite" or "WhatsApp-only" feature — both channels are first-class.

### Progressive auth
Browsing and searching require no account. Cart is maintained as an anonymous session. Authentication (Clerk, SMS OTP) is required only at checkout and for order history. No login wall before the user has seen value.

### LGPD compliance
Brazil's Lei Geral de Proteção de Dados (LGPD) applies from day one:
- Cookie consent banner before any tracking
- Privacy policy and terms pages (required before public launch)
- Personal data (phone numbers, addresses, order history) stored with explicit legal basis
- WhatsApp users informed how their number is used

### Payment methods (Brazil)
Stripe handles card payments. Pagar.me handles PIX and boleto — the two dominant payment methods for Brazilian consumers. Both are available on web and via agent-generated payment links on WhatsApp.

---

