# Next Steps

## Current State

- ✅ Monorepo scaffold — Turborepo + pnpm workspace, all apps and packages created
- ✅ Docker infrastructure — PostgreSQL, Redis, Typesense, NATS via Docker Compose
- ✅ Health check script — `scripts/local/healthcheck.sh`, run with `pnpm check` (8/8 checks)
- ✅ Base documentation — README.md, docs/setup/local-dev.md
- ✅ API foundation — Fastify plugin architecture (cors, helmet, sensible), error handler, graceful shutdown
- ⬜ `.env` filled with real keys
- ⬜ Medusa connected and first migration run

---

## Immediate (before writing any code)

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

2. Fill in the required Phase 1 keys:
   - `ANTHROPIC_API_KEY` — from console.anthropic.com
   - `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — from dashboard.clerk.com
   - `STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — from dashboard.stripe.com

   The `DATABASE_URL`, `REDIS_URL`, `TYPESENSE_API_KEY`, and `NATS_URL` are pre-filled for local Docker in `.env.example`.

---

## Phase 1 Build Order

### Step 1 — Medusa Connection (`apps/commerce`)

- Run the first Medusa migration against local Postgres: `pnpm db:migrate`
- Seed sample products: `pnpm db:seed`
- Verify the Medusa admin at http://localhost:9000/app

### Step 2 — First Agent Tool (`packages/tools`)

Implement `search_products` — the first Claude tool definition:
- Input schema: `{ query: string, limit?: number }`
- Logic: query Typesense `products` collection
- Output: array of `{ id, name, price, description, imageUrl }`

This is the tool Claude will call when a user asks "do you have X?"

### Step 3 — AgentOrchestrator (`apps/agent`)

Build the core agent loop in `packages/llm-provider`:
- Accept a user message + session history
- Call Claude with the tool definitions from `packages/tools`
- Handle tool calls (execute the tool, feed result back to Claude)
- Stream the final text response via SSE

### Step 4 — API Chat Routes (`apps/api`)

Wire the agent into HTTP endpoints:
- `POST /api/chat/messages` — accepts `{ sessionId, message }`, triggers the agent
- `GET /api/chat/stream/:sessionId` — SSE endpoint, streams agent response tokens

### Step 5 — Web Storefront (`apps/web`)

Build the customer-facing UI (all copy in pt-BR, mobile-first):
- Home page with product grid (fetched from Medusa) — design at 375px first
- Search page powered by Typesense — large touch targets, no hover-only interactions
- Product detail page — full-screen images, sticky add-to-cart button
- Chat widget — floating button on mobile that expands to full-screen overlay; side panel on desktop

### Step 6 — Checkout

Add the purchase flow:
- Cart state (local or server-side via Medusa cart API)
- Stripe Payment Element for card capture
- Order creation via Medusa on payment success
- Order confirmation page

### Step 7 — Auth

Lock down the app with Clerk:
- Middleware on `apps/api` — require auth on `/api/chat/*` and `/api/orders/*`
- Middleware on `apps/web` — require auth on `/checkout` and `/account`
- Pass Clerk user ID into the agent for personalisation (order history, preferences)

### Step 8 — WhatsApp Channel

Connect the same agent to WhatsApp via Twilio or Z-API:
- Incoming webhook → parse message → run agent → reply via WhatsApp API
- Same tools, same cart, same Medusa backend as the web storefront

### Step 9 — LGPD Compliance (pre-launch)

Required before any real users see the platform:
- Cookie consent banner — shown before PostHog or any analytics loads
- Privacy policy page (`/privacidade`) — what data is collected, how it's used, retention period
- Terms of service page (`/termos`) — purchase terms, returns, delivery
- WhatsApp opt-in message — inform users their phone number is stored and how it's used
- Medusa customer data retention policy — define how long order/personal data is kept

### Step 10 — Observability

Add production-grade visibility:
- Request ID tracing (already available via Fastify's built-in `requestId`)
- Structured pino logs piped to CloudWatch in production
- PostHog event tracking for key user actions: search, add to cart, checkout started, order placed
