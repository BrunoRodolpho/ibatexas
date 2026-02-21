# Next Steps

## Current State

- ✅ Monorepo scaffold — Turborepo + pnpm workspace, all apps and packages created
- ✅ Docker infrastructure — PostgreSQL, Redis, Typesense, NATS via Docker Compose
- ✅ Health check script — `scripts/healthcheck.sh`, run with `pnpm check` (8/8 checks)
- ✅ Base documentation — README.md, docs/setup/local-dev.md
- ⬜ `.env` filled with real keys
- ⬜ First real feature built

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

### Step 1 — API Foundation (`apps/api`)

Set up Fastify with a proper plugin structure, error handling, and request validation. The `/health` route already exists — extend it into a full server with:
- Plugin registration (cors, helmet, clerk auth plugin)
- Zod schema validation
- Centralized error handler
- Graceful shutdown

### Step 2 — Medusa Connection (`apps/commerce`)

- Run the first Medusa migration against local Postgres: `pnpm db:migrate`
- Seed sample products: `pnpm db:seed`
- Verify the Medusa admin at http://localhost:9000/app

### Step 3 — First Agent Tool (`packages/tools`)

Implement `search_products` — the first Claude tool definition:
- Input schema: `{ query: string, limit?: number }`
- Logic: query Typesense `products` collection
- Output: array of `{ id, name, price, description, imageUrl }`

This is the tool Claude will call when a user asks "do you have X?"

### Step 4 — AgentOrchestrator (`apps/agent`)

Build the core agent loop in `packages/llm-provider`:
- Accept a user message + session history
- Call Claude with the tool definitions from `packages/tools`
- Handle tool calls (execute the tool, feed result back to Claude)
- Stream the final text response via SSE

### Step 5 — API Routes (`apps/api`)

Wire the agent into HTTP endpoints:
- `POST /api/chat/messages` — accepts `{ sessionId, message }`, triggers the agent
- `GET /api/chat/stream/:sessionId` — SSE endpoint, streams agent response tokens

### Step 6 — Web Storefront (`apps/web`)

Build the customer-facing UI:
- Home page with product grid (fetched from Medusa)
- Search page powered by Typesense
- Product detail page
- Embedded chat widget (connects to the SSE stream)

### Step 7 — Checkout

Add the purchase flow:
- Cart state (local or server-side via Medusa cart API)
- Stripe Payment Element for card capture
- Order creation via Medusa on payment success
- Order confirmation page

### Step 8 — Auth

Lock down the app with Clerk:
- Middleware on `apps/api` — require auth on `/api/chat/*` and `/api/orders/*`
- Middleware on `apps/web` — require auth on `/checkout` and `/account`
- Pass Clerk user ID into the agent for personalisation (order history, preferences)
