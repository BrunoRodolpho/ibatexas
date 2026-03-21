# Architecture

> Find anything in < 30 seconds.

---

## 1. Big Picture — System Context

Where the project ends and the world begins.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#1e3a5f', 'primaryTextColor': '#e0e0e0', 'primaryBorderColor': '#4a90d9', 'lineColor': '#6ba3d6', 'secondaryColor': '#2d4a22', 'tertiaryColor': '#4a3060', 'background': '#0d1117', 'mainBkg': '#161b22', 'nodeBorder': '#4a90d9', 'clusterBkg': '#161b22', 'clusterBorder': '#30363d', 'titleColor': '#e0e0e0', 'edgeLabelBackground': '#161b22'}}}%%
graph TD
  subgraph Clients
    CLI["ibx CLI"]
    WEB["Next.js Storefront :3000"]
    ADMIN["Admin Panel :3002"]
    WA["WhatsApp via Twilio"]
  end

  subgraph Core
    API["Fastify API :3001"]
    AGENT["Claude Agent — 25 tools"]
    MEDUSA["Medusa v2 :9000"]
  end

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
    SENTRY["Sentry"]
  end

  CLI --> API & MEDUSA & PG & REDIS & TS
  WEB --> API
  ADMIN --> API
  WA -->|webhook| API
  API --> AGENT
  API --> MEDUSA & PG & REDIS & NATS & TS
  API --> STRIPE & TWILIO & ANTHROPIC & SENTRY
  AGENT --> MEDUSA & REDIS & TS & PG
  MEDUSA --> PG
  WEB -.->|client JS| POSTHOG

  style CLI fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style WEB fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style ADMIN fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style WA fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style API fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style AGENT fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style MEDUSA fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style PG fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style REDIS fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style TS fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style NATS fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style STRIPE fill:#2a1a3a,stroke:#ce93d8,color:#e1bee7
  style TWILIO fill:#2a1a3a,stroke:#ce93d8,color:#e1bee7
  style ANTHROPIC fill:#2a1a3a,stroke:#ce93d8,color:#e1bee7
  style POSTHOG fill:#2a1a3a,stroke:#ce93d8,color:#e1bee7
  style SENTRY fill:#2a1a3a,stroke:#ce93d8,color:#e1bee7
```

### Two Ways In — Browser vs AI Agent

The same backend logic can be reached two ways. Understanding which path you're touching prevents bugs.

```
Browser (Web UI)                    Chat (AI Agent)
     │                                   │
     ▼                                   ▼
 API Routes                        Agent Tool Registry
 apps/api/src/routes/              packages/llm-provider/src/tool-registry.ts
     │                                   │
     └──────────┬────────────────────────┘
                ▼
        Shared Functions
        packages/tools/src/
```

| Operation | Browser path | Agent path | Shared code? |
|-----------|-------------|------------|:------------:|
| Search products | `GET /api/products` | `search_products` tool | Yes |
| Product details | `GET /api/products/:id` | `get_product_details` tool | Yes |
| Delivery estimate | `GET /api/cart/delivery-estimate` | `estimate_delivery` tool | Yes |
| Checkout | `POST /api/cart/checkout` | `create_checkout` tool | Yes |
| Check availability | `GET /api/reservations/availability` | `check_table_availability` tool | Yes |
| Create reservation | `POST /api/reservations` | `create_reservation` tool | Yes |
| Modify reservation | `PATCH /api/reservations/:id` | `modify_reservation` tool | Yes |
| Cancel reservation | `DELETE /api/reservations/:id` | `cancel_reservation` tool | Yes |
| **Add to cart** | **Zustand store (client-side)** | `add_to_cart` tool (Medusa direct) | **No** |
| **Update cart** | **Zustand store (client-side)** | `update_cart` tool (Medusa direct) | **No** |
| **Remove from cart** | **Zustand store (client-side)** | `remove_from_cart` tool (Medusa direct) | **No** |
| Order history | Not exposed yet | `get_order_history` tool | Agent only |
| Customer profile | Not exposed | `get_customer_profile` tool | Agent only |
| Recommendations | Not exposed | `get_recommendations` tool | Agent only |

**Why cart is different:** The web app uses a client-side Zustand store for instant feedback. The agent calls Medusa backend directly. Both sync to Medusa at checkout via `createCheckout()`.

**Key rule:** The web app **never** calls the agent. Two independent paths:
- Browser UI → API routes → `packages/tools/` functions
- Chat sidebar → SSE stream → agent loop → tools → same `packages/tools/` functions

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

Every `ibx` command goes through the same infrastructure the apps use. No separate paths.

| Command group | Touches | Why |
|---------------|---------|-----|
| `dev`, `svc`, `bootstrap` | Docker, Medusa, Postgres, Redis, Typesense, NATS | Start/stop/setup the full stack |
| `db` | Postgres (Prisma + Medusa migrations), Typesense (reindex) | Schema + data lifecycle |
| `test`, `scenario`, `matrix`, `simulate` | All data stores + Medusa | Seed, verify, simulate customer behavior |
| `api` (products, search, chat) | Medusa admin API, Typesense, API :3001 | Query catalog, test agent |
| `debug` | Redis (raw keys), Typesense (raw docs), Postgres (profiles) | Infrastructure inspection |
| `inspect` | Typesense, Postgres, Redis, Medusa | Business-level state (what the UI sees) |
| `intelligence` | Redis (sorted sets), Postgres (order history) | Co-purchase matrix, global scores |
| `tag` | Medusa admin API → Typesense reindex → Redis cache flush | Product metadata |
| `deps` | pnpm workspace, Git | Dependency overrides audit + drift detection |
| `env`, `auth`, `doctor` | dotenv, Redis, all infra (doctor) | Config validation, OTP debugging, health check |
| `git` | Git | Branch status, recent commits |
| `tunnel` | ngrok → API :3001 | Expose local API for WhatsApp webhook testing |

---

## 3. Life of a Request — Purchase Flow

Trace a customer purchase from search to order confirmation.

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

  subgraph STAGING["On Merge to dev"]
    DEV[Merge to dev] --> S1[Docker build]
    S1 --> S2[Push to ECR]
    S2 --> S3[Prisma migrate]
    S3 --> S4["Deploy ibatexas-dev"]
    S4 --> S5[Health check]
  end

  subgraph PROD["On Merge to main"]
    MAIN[Merge to main] --> P1[Docker build]
    P1 --> P2[Push to ECR]
    P2 --> P3[Prisma migrate]
    P3 --> P4["Deploy ibatexas-prod"]
    P4 --> P5[Health check]
  end

  subgraph CRON["Scheduled"]
    W[Weekly Mon] --> U[upgrade-radar]
    W --> CQ[CodeQL scan]
  end

  style TEST fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style SONAR fill:#1a3a2a,stroke:#4caf50,color:#c8e6c9
  style CODEQL fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style SECRETS fill:#3e2723,stroke:#ffab91,color:#ffccbc
  style S4 fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
  style P4 fill:#1e3a5f,stroke:#64b5f6,color:#bbdefb
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
| **DB setup** | `ibx bootstrap` | [supabase.md](setup/supabase.md) | [supabase.md](setup/supabase.md) |

**Supabase is staging + production only.** Local dev uses Docker Postgres. Never Supabase locally.

**`APP_ENV` vs `NODE_ENV`:**
- `NODE_ENV` = Node.js runtime behavior (optimizations, source maps)
- `APP_ENV` = Redis key namespace prefix — prevents cross-environment data bleed
- `rk("customer:123")` → `development:customer:123` / `dev:customer:123` / `production:customer:123`
- Missing `APP_ENV` in production **throws an error** (`packages/tools/src/redis/key.ts`)

**Terraform note:** `infra/terraform/environments/dev/` is the **staging** environment (naming is confusing but intentional — it targets the `ibatexas-dev` ECS cluster).

---

## Where Is X?

| Concern | Go to | Start reading |
|---------|-------|---------------|
| Auth (middleware) | `apps/api/src/middleware/auth.ts` | `requireAuth()` |
| Auth (OTP + JWT) | `apps/api/src/routes/auth.ts` | `sendOtp`, `verifyOtp` |
| Payments | `apps/api/src/routes/stripe-webhook.ts` | webhook handler |
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
