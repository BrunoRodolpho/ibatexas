# IbateXas

AI-native platform for Brazilian restaurants — online ordering (food + frozen dishes), table reservations, and WhatsApp-native customer experience, all powered by the same Claude-based agent.

---

**Target market:** Brazilian restaurant — food, frozen dishes, dine-in
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
   PostgreSQL + Redis + Typesense + NATS
```

### Four Applications

| App | Role |
|---|---|
| `apps/web` | Next.js storefront (desktop + mobile) + owner dashboard |
| `apps/api` | Fastify API + SSE streaming |
| `apps/agent` | Claude orchestrator + tool registry |
| `apps/commerce` | Medusa.js v2 — catalog, cart, orders |

### Five Shared Packages

| Package | Role |
|---|---|
| `@ibatexas/types` | Shared TypeScript types and interfaces |
| `@ibatexas/domain` | Reservation, CustomerProfile, Review — custom domain models |
| `@ibatexas/llm-provider` | Claude adapter + model-agnostic LLMProvider interface |
| `@ibatexas/tools` | Agent tool definitions + registry (29 tools across 5 contexts) |
| `@ibatexas/nats-client` | NATS event bus — publishes business events for analytics and intelligence |

---

## Technology Stack

### Frontend
- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS + shadcn/ui
- **Auth:** Clerk (SMS OTP — no passwords)
- **Analytics:** PostHog

### Backend
- **API:** Fastify
- **Language:** TypeScript 5+ / Node.js 20+
- **Commerce:** Medusa.js v2
- **Validation:** Zod

### AI
- **Primary LLM:** Claude Sonnet 4 (Anthropic)
- **Fallback LLM:** GPT-4o (OpenAI)
- **Abstraction:** Custom `LLMProvider` interface — swap models without code changes

### Data
- **Primary DB:** PostgreSQL 15+ (AWS RDS)
- **Cache + Sessions:** Redis (Upstash)
- **Search:** Typesense
- **Event streaming:** NATS JetStream

### Infrastructure
- **Cloud:** AWS sa-east-1 (São Paulo)
- **Compute:** ECS Fargate
- **IaC:** Terraform
- **CDN:** CloudFront

### External Services (Brazil)
- **WhatsApp:** Twilio API
- **Payments:** Stripe (card) + Pagar.me (PIX, boleto)
- **Shipping:** Correios + EasyPost
- **Address:** ViaCEP
- **Tax invoices:** Focus NFe

---

## Quick Start

```bash
docker compose up -d   # start infrastructure
pnpm check             # verify all services healthy
pnpm install           # install dependencies
turbo dev              # start all apps
```

---

## Repository Structure

```
ibatexas/
├── apps/
│   ├── web/          Next.js storefront + owner dashboard
│   ├── api/          Fastify API + SSE streaming
│   ├── agent/        Claude orchestrator + tool registry
│   └── commerce/     Medusa.js v2 commerce engine
├── packages/
│   ├── types/        Shared TypeScript types
│   ├── domain/       Reservation, CustomerProfile, Review models
│   ├── llm-provider/ Claude adapter + LLMProvider interface
│   ├── tools/        Agent tool definitions + registry
│   └── nats-client/  NATS event bus wrapper
├── infra/
│   └── terraform/    AWS infrastructure (ECS, RDS, VPC)
├── scripts/
│   └── local/        Dev tooling (healthcheck.sh)
├── docs/
│   ├── design/       System design documents
│   └── setup/        Local dev setup guide
├── docker-compose.yml
└── .env.example
```

---

## Rollout Phases

| Phase | Scale | Est. Cost |
|---|---|---|
| 1 — Launch | < 1K users/mo | ~$50–80/mo |
| 2 — Growth | 1K–5K users/mo | ~$150–200/mo |
| 3 — Scale | 5K–20K users/mo | ~$300–400/mo |
| 4 — Expansion | 20K+ users/mo | ~$1K–3.5K/mo |

---

## Design Principles

**Responsive-first** — designed for 375px mobile, scales to desktop. **Channel parity** — every feature works on web and WhatsApp identically. **Progressive auth** — browse and search as guest, auth only at checkout. **LGPD compliant** — cookie consent, privacy policy, explicit data consent before launch.

---

## Documentation

| Document | Description |
|---|---|
| [Bounded Contexts](docs/design/bounded-contexts.md) | The 6 contexts, entity ownership, and rules |
| [Domain Model](docs/design/domain-model.md) | Custom entities (Reservation, Review, CustomerProfile, Events) |
| [Use Cases](docs/design/use-cases.md) | Full matrix: what's available on web, WhatsApp, and in-person |
| [Agent Tools](docs/design/agent-tools.md) | All 29 tools — inputs, outputs, auth level |
| [Customer Intelligence](docs/design/customer-intelligence.md) | Recommendations, reviews, NATS events, owner dashboard |
| [Local Dev Setup](docs/setup/local-dev.md) | Prerequisites, env vars, running locally |
| [Next Steps](docs/next-steps.md) | Current state + 12-step Phase 1 build order |
