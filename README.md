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

