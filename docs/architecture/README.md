# Architecture

> Find anything in < 30 seconds.

---

## 1. Big Picture — System Context

Where the project ends and the world begins. Two paths into the same shared logic.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#1e3a5f', 'primaryTextColor': '#e0e0e0', 'primaryBorderColor': '#4a90d9', 'lineColor': '#6ba3d6', 'secondaryColor': '#2d4a22', 'tertiaryColor': '#4a3060', 'background': '#0d1117', 'mainBkg': '#161b22', 'nodeBorder': '#4a90d9', 'clusterBkg': '#161b22', 'clusterBorder': '#30363d', 'titleColor': '#e0e0e0', 'edgeLabelBackground': '#161b22'}}}%%
graph TD
  subgraph Clients
    WEB["Web :3000 + Admin :3002"]
    CHAT["Chat UI sidebar"]
    WA["WhatsApp via Twilio"]
  end

  subgraph "Fastify API :3001"
    ROUTES["API Routes<br/>cart, catalog, reservations, auth"]
    CHAT_RT["Chat Route<br/>POST /chat + SSE stream"]
  end

  AGENT["Claude Agent<br/>Anthropic tool-use API"]
  TOOL_REG["Tool Registry<br/>25 tools — Zod validated"]
  SHARED["packages/tools/<br/>shared logic"]
  MEDUSA["Medusa v2 :9000"]

  subgraph Data["Data Tier — Docker"]
    PG[("PostgreSQL :5433")]
    REDIS[("Redis :6379")]
    TS[("Typesense :8108")]
    NATS["NATS :4222"]
  end

  subgraph External["External — SaaS"]
    STRIPE["Stripe"]
    TWILIO["Twilio"]
    ANTHROPIC["Anthropic"]
    POSTHOG["PostHog"]
  end

  WEB ==>|"Path A: REST"| ROUTES
  ROUTES ==> SHARED
  CHAT -->|"Path B"| CHAT_RT
  WA -->|"Path B: webhook"| CHAT_RT
  CHAT_RT ==> AGENT
  AGENT <==>|tool_use| ANTHROPIC
  AGENT ==> TOOL_REG
  TOOL_REG ==> SHARED
  SHARED ==> MEDUSA & PG & REDIS & TS & NATS
  SHARED ==> STRIPE & TWILIO
  MEDUSA ==> PG
  WEB -.->|client JS| POSTHOG

  style WEB fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style CHAT fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style WA fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style ROUTES fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style CHAT_RT fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style AGENT fill:#4a1a6b,stroke:#ce93d8,color:#e1bee7
  style TOOL_REG fill:#4a1a6b,stroke:#ce93d8,color:#e1bee7
  style SHARED fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style MEDUSA fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style PG fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style REDIS fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style TS fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style NATS fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style STRIPE fill:#2a1a3a,stroke:#ce93d8,color:#e1bee7
  style TWILIO fill:#2a1a3a,stroke:#ce93d8,color:#e1bee7
  style ANTHROPIC fill:#2a1a3a,stroke:#ce93d8,color:#e1bee7
  style POSTHOG fill:#2a1a3a,stroke:#ce93d8,color:#e1bee7
```

### Path A vs Path B — Quick Reference

| Operation | Path A: Browser (REST) | Path B: Agent (tool_use) | Shared? |
|-----------|----------------------|--------------------------|:-------:|
| Search products | `GET /api/products` | `search_products` tool | Yes |
| Product details | `GET /api/products/:id` | `get_product_details` tool | Yes |
| Delivery estimate | `GET /api/cart/delivery-estimate` | `estimate_delivery` tool | Yes |
| Checkout | `POST /api/cart/checkout` | `create_checkout` tool | Yes |
| Reservations (all) | `GET/POST/PATCH/DELETE /api/reservations` | reservation tools | Yes |
| **Cart (add/update/remove)** | **Zustand store (client-side)** | **Medusa direct** | **No** |
| Order history | Not exposed yet | `get_order_history` tool | Agent only |
| Customer profile | Not exposed | `get_customer_profile` tool | Agent only |

**Why cart diverges:** Web uses client-side Zustand for instant UX. Agent calls Medusa backend directly. Both converge at checkout via `createCheckout()`.

---

## 2. Source of Truth — Module Map

If you need X, go to Y.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#1e3a5f', 'primaryTextColor': '#e0e0e0', 'primaryBorderColor': '#4a90d9', 'lineColor': '#6ba3d6', 'background': '#0d1117', 'mainBkg': '#161b22', 'clusterBkg': '#161b22', 'clusterBorder': '#30363d'}}}%%
graph LR
  subgraph apps["apps/"]
    direction TB
    WEB["web/ :3000<br/>domains: analytics, cart, chat,<br/>checkout, search, session, shipping<br/>components: atoms, molecules, organisms"]
    API_APP["api/ :3001<br/>routes: auth, cart, catalog, reservations,<br/>chat, stripe-webhook, whatsapp-webhook, admin/<br/>middleware, whatsapp/, jobs/, session/"]
    COMMERCE["commerce/ :9000<br/>Medusa subscribers"]
    ADMIN_APP["admin/ :3002<br/>dashboard + cardapio"]
  end

  subgraph packages["packages/"]
    direction TB
    TOOLS["tools/<br/>cart, search, reservation,<br/>redis, typesense, guards,<br/>intelligence, embeddings"]
    DOMAIN["domain/<br/>prisma schema + migrations<br/>services: reservation, customer, order"]
    LLM["llm-provider/<br/>agent.ts, tool-registry.ts,<br/>system-prompt.ts"]
    CLI_PKG["cli/<br/>19 commands"]
    OTHER["nats-client, types, ui"]
  end

  subgraph infra["infra + CI"]
    direction TB
    TF["terraform/<br/>ECS, ECR, ALB, IAM, DNS"]
    GH[".github/workflows/<br/>9 pipelines"]
  end

  style WEB fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style API_APP fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style COMMERCE fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style ADMIN_APP fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style TOOLS fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style DOMAIN fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style LLM fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style CLI_PKG fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style OTHER fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style TF fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style GH fill:#3e2723,stroke:#ffab91,color:#ffccbc
```

### CLI → Core Engine Interaction

Every `ibx` command goes through the same infrastructure the apps use.

| Command group | Touches | Why |
|---------------|---------|-----|
| `dev`, `svc`, `bootstrap` | Docker, Medusa, Postgres, Redis, Typesense, NATS | Start/stop/setup the full stack |
| `db` | Postgres (Prisma + Medusa), Typesense (reindex) | Schema + data lifecycle |
| `test`, `scenario`, `matrix`, `simulate` | All data stores + Medusa | Seed, verify, simulate |
| `api` (products, search, chat) | Medusa admin API, Typesense, API :3001 | Query catalog, test agent |
| `debug`, `inspect`, `intelligence` | Redis, Typesense, Postgres, Medusa | Infrastructure + business state |
| `tag` | Medusa → Typesense reindex → Redis cache flush | Product metadata |
| `deps`, `env`, `auth`, `git`, `doctor` | pnpm, dotenv, Redis, Git, all infra | Config + maintenance |
| `tunnel` | ngrok → API :3001 | Expose local API for WhatsApp webhooks |

---

## 3. Life of a Request

### 3a. Browser Purchase Flow (Path A)

Customer browses, adds to cart, and checks out via the web UI.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'actorBkg': '#1a3a2a', 'actorBorder': '#4caf50', 'actorTextColor': '#c8e6c9', 'signalColor': '#6ba3d6', 'signalTextColor': '#e0e0e0', 'labelBoxBkgColor': '#161b22', 'labelBoxBorderColor': '#30363d', 'labelTextColor': '#e0e0e0', 'loopTextColor': '#e0e0e0', 'noteBkgColor': '#1e3a5f', 'noteTextColor': '#bbdefb', 'noteBorderColor': '#4a90d9', 'activationBkgColor': '#1e3a5f', 'activationBorderColor': '#4a90d9', 'sequenceNumberColor': '#e0e0e0'}}}%%
sequenceDiagram
  actor C as Customer
  participant W as Web :3000
  participant A as API :3001
  participant M as Medusa :9000
  participant R as Redis
  participant T as Typesense
  participant S as Stripe
  participant N as NATS

  rect rgba(26, 58, 42, 0.3)
  Note over C,T: Search
  C->>W: Search "costela"
  W->>A: GET /api/products?q=costela
  A->>T: search(products, "costela")
  T-->>A: hits[]
  A-->>W: products[]
  W-->>C: Product listing
  end

  rect rgba(30, 58, 95, 0.3)
  Note over C,R: Cart
  C->>W: Add to cart
  W->>A: POST /api/cart/:id/line-items
  A->>M: POST /store/carts/:id/line-items
  M-->>A: updated cart
  A->>R: hSet(active:carts, cartId)
  A-->>W: cart with totals
  end

  rect rgba(62, 39, 35, 0.3)
  Note over C,N: Checkout + Payment
  C->>W: Checkout with card
  W->>A: POST /api/cart/checkout
  A->>M: POST /store/carts/:id/complete
  M->>S: Create PaymentIntent
  S-->>M: client_secret
  M-->>A: order pending
  A-->>W: clientSecret
  W->>S: confirmCardPayment
  S-->>W: success
  S->>A: POST /webhooks/stripe
  A->>A: verify signature + idempotency
  A->>N: publish order.placed
  A-->>S: 200 OK
  end
```

### 3b. Agent Conversation Flow (Path B — WhatsApp / Chat UI)

Customer orders via conversation. Agent autonomously decides which tools to call.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'actorBkg': '#1a3a2a', 'actorBorder': '#4caf50', 'actorTextColor': '#c8e6c9', 'signalColor': '#6ba3d6', 'signalTextColor': '#e0e0e0', 'labelBoxBkgColor': '#161b22', 'labelBoxBorderColor': '#30363d', 'labelTextColor': '#e0e0e0', 'loopTextColor': '#e0e0e0', 'noteBkgColor': '#1e3a5f', 'noteTextColor': '#bbdefb', 'noteBorderColor': '#4a90d9', 'activationBkgColor': '#1e3a5f', 'activationBorderColor': '#4a90d9', 'sequenceNumberColor': '#e0e0e0'}}}%%
sequenceDiagram
  actor C as Customer
  participant CH as WhatsApp / Chat UI
  participant A as API :3001
  participant AG as Claude Agent
  participant TL as packages/tools/
  participant M as Medusa :9000
  participant T as Typesense

  rect rgba(26, 58, 42, 0.3)
  Note over C,T: Turn 1 — Search
  C->>CH: "quero comprar costela"
  CH->>A: POST /chat/messages (or Twilio webhook)
  A->>A: Store in session history
  A-->>CH: messageId
  A->>AG: runAgent(message, history, context)
  AG->>AG: Decide: search_products
  AG->>TL: search_products("costela")
  TL->>T: Typesense search
  T-->>TL: hits[]
  TL-->>AG: products[]
  AG-->>A: Stream text chunks (SSE / Twilio)
  A-->>CH: "Encontrei costela! R$89. Quer adicionar?"
  CH-->>C: Response displayed
  end

  rect rgba(30, 58, 95, 0.3)
  Note over C,M: Turn 2 — Add to cart
  C->>CH: "sim, 2 unidades"
  CH->>A: POST /chat/messages
  A->>AG: runAgent(message, history, context)
  AG->>AG: Decide: add_to_cart
  AG->>TL: add_to_cart(costela, qty: 2)
  TL->>M: POST /store/carts/:id/line-items
  M-->>TL: updated cart
  TL-->>AG: cart summary
  AG-->>A: Stream response
  A-->>CH: "Adicionei 2x Costela. Total: R$178. Finalizar?"
  CH-->>C: Response displayed
  end
```

---

## 4. Safety Net — CI/CD + Testing Pipeline

What runs when. Helps decide what's priority vs noise.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#1e3a5f', 'primaryTextColor': '#e0e0e0', 'primaryBorderColor': '#4a90d9', 'lineColor': '#6ba3d6', 'background': '#0d1117', 'mainBkg': '#161b22', 'clusterBkg': '#161b22', 'clusterBorder': '#30363d'}}}%%
flowchart LR
  subgraph PR["On Every PR"]
    PUSH[Push / PR] --> LINT[pnpm lint]
    PUSH --> TEST[pnpm test + coverage]
    PUSH --> AUDIT[pnpm audit]
    PUSH --> CODEQL[CodeQL SAST]
    PUSH --> SECRETS[Gitleaks]
    PUSH --> BRANCH[Branch naming]
    TEST --> SONAR[SonarCloud gate]
    LINT & TEST & AUDIT --> BUILD[pnpm build]
  end

  subgraph DEPLOY["On Merge to main/dev"]
    direction LR
    MERGE["Merge"] --> D1[Docker build] --> D2[Push to ECR] --> D3[Prisma migrate] --> D4["Deploy ECS"] --> D5[Health check]
  end

  subgraph CRON["Scheduled"]
    W[Weekly Mon] --> U[upgrade-radar]
    W --> CQ[CodeQL scan]
  end

  style TEST fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style SONAR fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style CODEQL fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style SECRETS fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style D4 fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
```

---

## 5. Environments — Dev vs Staging vs Production

| | Local Dev | Staging | Production |
|---|---|---|---|
| **Database** | Docker Postgres `:5433` | Supabase (sa-east-1) | Supabase (sa-east-1) |
| **Redis** | Docker Redis `:6379` | AWS ElastiCache | AWS ElastiCache |
| **Typesense** | Docker Typesense `:8108` | AWS hosted | AWS hosted |
| **NATS** | Docker NATS `:4222` | AWS hosted | AWS hosted |
| **Compute** | Local processes | ECS Fargate (`ibatexas-dev`) | ECS Fargate (`ibatexas-prod`) |
| **Start with** | `ibx dev` | Push to `dev` branch | Push to `main` branch |
| **APP_ENV** | `development` | `dev` | `production` |
| **NODE_ENV** | `development` | `development` | `production` |
| **Config** | `.env` + `docker-compose.yml` | Terraform + Secrets Manager | Terraform + Secrets Manager |
| **DB setup** | `ibx bootstrap` | [supabase.md](../setup/supabase.md) | [supabase.md](../setup/supabase.md) |

**Supabase is staging + production only.** Local dev uses Docker Postgres. Never Supabase locally.

**`APP_ENV` vs `NODE_ENV`:**
- `NODE_ENV` = Node.js runtime behavior (optimizations, source maps)
- `APP_ENV` = Redis key namespace prefix — prevents cross-environment data bleed
- `rk("customer:123")` → `development:customer:123` / `dev:customer:123` / `production:customer:123`
- Missing `APP_ENV` in production **throws an error** (`packages/tools/src/redis/key.ts`)

**Terraform note:** `infra/terraform/environments/dev/` is the **staging** environment (targets `ibatexas-dev` ECS cluster).

---

## Where Is X?

| Concern | Go to | Start reading |
|---------|-------|---------------|
| Auth (middleware) | `apps/api/src/middleware/auth.ts` | `requireAuth()` |
| Auth (OTP + JWT) | `apps/api/src/routes/auth.ts` | `sendOtp`, `verifyOtp` |
| Payments (backend) | `apps/api/src/routes/stripe-webhook.ts` | webhook handler |
| Payments (frontend) | `apps/web/src/app/[locale]/checkout/_components/CardPaymentForm.tsx` | embedded Stripe PaymentElement |
| Cart operations | `packages/tools/src/cart/` | `add-to-cart.ts` |
| Checkout | `packages/tools/src/cart/create-checkout.ts` | `createCheckout()` |
| Product search | `packages/tools/src/search/search-products.ts` | `searchProducts()` |
| Reservations | `packages/tools/src/reservation/` | `check-availability.ts` |
| AI Agent loop | `packages/llm-provider/src/agent.ts` | `runAgent()` |
| Tool registry | `packages/llm-provider/src/tool-registry.ts` | tool definitions |
| WhatsApp | `apps/api/src/whatsapp/state-machine.ts` | state machine |
| Analytics events | `apps/web/src/domains/analytics/events.ts` | `AnalyticsEvent` union |
| Typesense indexing | `packages/tools/src/typesense/index-product.ts` | `indexProduct()` |
| Delivery/shipping | `packages/tools/src/catalog/estimate-delivery.ts` | fee calculation |
| Redis client + keys | `packages/tools/src/redis/client.ts` + `key.ts` | `rk()` |
| Circuit breaker | `packages/tools/src/redis/circuit-breaker.ts` | `RedisCircuitBreaker` |
| NATS events | `packages/nats-client/src/index.ts` | `publishNatsEvent()` |
| Prisma schema | `packages/domain/prisma/schema.prisma` | entities |
| Domain services | `packages/domain/src/services/` | `reservation.service.ts` etc |
| CLI (all 19 cmds) | `packages/cli/src/commands/` | one file per command |
| CLI (services def) | `packages/cli/src/services.ts` | port assignments, service registry |
| CLI (scenarios) | `packages/cli/src/scenarios/` | YAML-driven state testing |
| Shared UI | `packages/ui/src/` | `atoms/`, `molecules/` |
| Web components | `apps/web/src/components/` | app-specific UI |
| Env config | `apps/api/src/config.ts` | Zod schema |
| Docker services | `docker-compose.yml` | PG, Redis, Typesense, NATS |
| Terraform | `infra/terraform/environments/dev/` | `main.tf` |
| CI/CD | `.github/workflows/` | `ci.yml`, `deploy.yml` |
| Error handling | `apps/api/src/errors/handler.ts` | `registerErrorHandler()` |
| Sessions | `apps/api/src/session/store.ts` | Redis conversation store |

---

## How Do I Run X?

| Task | Command |
|------|---------|
| **Basics** | |
| Start everything | `ibx dev` |
| Stop everything | `ibx dev stop` |
| First-time setup | `ibx bootstrap` |
| Health check | `ibx doctor` |
| All commands | `ibx --help` |
| Command help | `ibx <command> --help` |
| **Build & Test** | |
| Build all | `ibx dev build` |
| Run all tests | `ibx test` |
| Run one test | `ibx test -- path/to/file.test.ts` |
| E2E tests | `npx playwright test` |
| Lint | `pnpm lint` |
| **Database** | |
| Apply domain migrations | `ibx db migrate:domain` |
| Seed products | `ibx db seed` |
| Seed domain tables | `ibx db seed:domain` |
| Full reseed | `ibx db reset` |
| Reindex Typesense | `ibx db reindex` |
| **Infrastructure** | |
| Docker services up | `ibx svc up` |
| Docker services down | `ibx svc down` |
| Service status | `ibx svc status` |
| Expose for WhatsApp | `ibx tunnel` |
| **Debugging** | |
| Inspect Redis keys | `ibx debug redis [pattern]` |
| Search Typesense | `ibx debug typesense [query]` |
| Customer profile | `ibx debug profile <customerId>` |
| OTP rate-limit flush | `ibx auth flush [phoneHash]` |
| **Data & Intelligence** | |
| Tag a product | `ibx tag add <handle> <tag>` |
| Rebuild co-purchase | `ibx intel copurchase-rebuild` |
| Run scenario | `ibx scenario run <name>` |
| Simulate orders | `ibx simulate full` |
| **Maintenance** | |
| Env check | `ibx env check` |
| Dependency audit | `ibx deps audit` |
| Dependency drift | `ibx deps drift` |
| Git status | `ibx git status` |

---

## CI/CD Workflows

All workflows in `.github/workflows/`.

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | PR + push main/dev | Lint, test, audit, build, SonarCloud |
| `deploy.yml` | Push to main | Docker -> ECR -> migrate -> ECS deploy -> health check |
| `deploy-staging.yml` | Push to dev | Same pipeline, `ibatexas-dev` cluster |
| `codeql.yml` | PR + push + weekly | CodeQL SAST (JS/TS) |
| `secret-scan.yml` | PR + push main/dev | Gitleaks secret detection |
| `branch-naming.yml` | PR open/reopen/sync | Enforces `type/description` naming |
| `cleanup-branches.yml` | PR merged | Deletes merged branches |
| `override-drift.yml` | PR changing package.json | `pnpm check:overrides` |
| `upgrade-radar.yml` | Weekly + manual | `pnpm upgrade:radar` |

## Infrastructure

Terraform in `infra/terraform/environments/dev/` manages:
ECS Fargate cluster, ECR repos (api/web/admin), ALB, ACM certs,
Route53 DNS, IAM roles, security groups, Secrets Manager.

State backend: S3 (defined, provisioning tracked in INFRA-17).
