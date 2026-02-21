# IbateXas

AI-native conversational commerce platform for Brazil.
Customers shop through natural language — web chat and WhatsApp — powered by a Claude-based agent that searches products, manages carts, and drives checkout.

---

**Target market:** Brazilian food & goods e-commerce
**Primary language:** Portuguese (pt-BR)
**Core differentiator:** The shopping experience is a conversation, not a UI

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
| `apps/web` | Next.js chat interface |
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

