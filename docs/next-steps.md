# Next Steps

## Current State

- ✅ Monorepo scaffold — Turborepo + pnpm workspace, all apps and packages created
- ✅ Docker infrastructure — PostgreSQL, Redis, Typesense, NATS via Docker Compose
- ✅ Health check script — `scripts/local/healthcheck.sh`, run with `pnpm check`
- ✅ API foundation — Fastify plugin architecture, error handler, graceful shutdown
- ✅ System design — bounded contexts, domain model, use cases, agent tools, customer intelligence
- ⬜ `.env` filled with real keys
- ⬜ Medusa connected and first migration run

---

## Immediate (before writing any code)

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

2. Fill in the required Phase 1 keys:
   - `ANTHROPIC_API_KEY` — console.anthropic.com
   - `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — dashboard.clerk.com
   - `STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — dashboard.stripe.com

   The `DATABASE_URL`, `REDIS_URL`, `TYPESENSE_API_KEY`, and `NATS_URL` are pre-filled for local Docker in `.env.example`.

---

## Phase 1 Build Order

### Step 1 — Medusa Connection (`apps/commerce`)

- Complete `medusa-config.ts` (CORS, JWT/cookie secrets from env — no hardcoded values)
- Create `apps/commerce/src/seed.ts` with realistic Brazilian restaurant products (food + frozen dishes, pt-BR names, BRL prices, images, tags, nutritional info)
- Run first migration: `pnpm --filter @ibatexas/commerce db:migrate`
- Seed products: `pnpm --filter @ibatexas/commerce db:seed`
- Verify Medusa admin at http://localhost:9000/app

### Step 2 — First Agent Tool (`packages/tools`)

Implement `search_products` — the first Claude tool definition:
- Input: `{ query, tags?, availableNow?, excludeAllergens?, limit? }`
- Logic: query Typesense `products` collection
- Output: ranked list with image, price, rating, availability
- Publishes `product.viewed` NATS event

### Step 3 — AgentOrchestrator (`apps/agent`)

Build the core agent loop in `packages/llm-provider`:
- Accept message + session history + `AgentContext` (channel, sessionId, customerId?)
- Call Claude with tool definitions from `packages/tools`
- Handle tool calls → execute → feed result back to Claude
- Stream final text response via SSE

### Step 4 — API Chat Routes (`apps/api`)

Wire the agent into HTTP endpoints:
- `POST /api/chat/messages` — accepts `{ sessionId, message, channel }`
- `GET /api/chat/stream/:sessionId` — SSE endpoint, streams agent response tokens

### Step 5 — Restaurant Storefront (`apps/web`)

Build the restaurant customer-facing UI (all copy in pt-BR, mobile-first at 375px):
- Home page — product grid from Medusa, categories, featured items
- Search page — Typesense powered, large touch targets, filter by tag
- Product detail page — image gallery, variants, nutritional info, reviews, sticky add-to-cart
- Cart page — items, special instructions, subtotal, delivery type selection
- Chat widget — floating button on mobile (full-screen overlay), side panel on desktop (agent for restaurant ordering only)

### Step 6 — Shop (`/loja`)

Branded merchandise section — standard e-commerce, no agent:
- Merchandise product grid with category navigation (camisetas, accessories, kits)
- Product detail page — images, size variants, stock, standard add-to-cart (no special instructions)
- Shared cart and checkout with restaurant orders — or separate cart (TBD at implementation)
- Checkout supports PIX + Stripe card + **Boleto** (boleto available for merchandise, unlike food)
- Order tracking for shipped merchandise (Correios/EasyPost)
- NF-e generation via Focus NFe (same as restaurant orders)

### Step 7 — Admin Panel (`/admin`)

Custom owner control panel in `apps/web` — Clerk `manager` role required:
- Auth guard on all `/admin` routes — 401 for non-staff
- **Dashboard:** today's orders (restaurant + shop), revenue, active reservations, pending escalations
- **Menu management:** create/edit/archive food products — name, description, images, variants, prices, tags, availability windows, nutritional info, allergens
- **Shop management:** create/edit merchandise — images, variants (size/color), prices, stock
- **Orders:** view all orders (restaurant + shop), filter by status, update status
- **Reservations:** calendar view, check in guests (reservation → seated), manage table layout, configure time slots
- **Delivery zones:** define zones by neighbourhood, set fees and estimated transit times
- **Reviews & escalations:** view all reviews, resolve low-rating escalations (≤ 2 stars), view unanswered agent questions
- **Analytics:** PostHog embed — sales trends, top products, reservation occupancy, agent performance

### Step 8 — Reservations

- Prisma schema: `Table`, `TimeSlot`, `Reservation`, `Waitlist`
- Tools: `check_table_availability`, `create_reservation`, `modify_reservation`, `cancel_reservation`, `get_my_reservations`, `join_waitlist`
- `/reservas` page (pt-BR, mobile-first): date picker, party size, special requests, confirmation
- Post-reservation WhatsApp confirmation message

### Step 9 — Customer Intelligence

- `CustomerProfile` in Redis — populated from Medusa order history on first login
- Tools: `get_recommendations`, `update_preferences`, `submit_review`, `get_customer_profile`
- NATS event publishing for all significant actions (full event catalogue in [customer-intelligence.md](design/customer-intelligence.md))
- Post-delivery review prompt — 30min delay via NATS scheduled message → WhatsApp
- Review display on product detail pages (rolling average rating)

### Step 10 — Checkout

Add the full purchase flow:
- Cart state via Medusa cart API (guest + authenticated)
- Delivery type selection: delivery / pickup / dine-in
- CEP validation via ViaCEP + delivery zone + fee estimate
- PIX (QR code) + Stripe card (Payment Element) + cash + boleto (merchandise only)
- Tip (gorjeta) option (restaurant orders only)
- Order confirmation page with status + estimated time
- NF-e generation via Focus NFe API

### Step 11 — Auth

Lock down the app with Clerk (SMS OTP):
- API middleware: require auth on `/api/chat/*`, `/api/orders/*`, and `/api/admin/*`
- Web middleware: require auth on `/checkout`, `/conta`, `/reservas` (creation), `/admin` (staff role)
- Guest session → Customer promotion at checkout (cart migration)
- Pass Clerk user ID into agent for personalisation

### Step 12 — WhatsApp Channel

Connect the same agent to WhatsApp via Twilio:
- Incoming webhook → parse message → build `AgentContext { channel: 'whatsapp' }` → run agent
- Outgoing: text, image (product photos), list messages (menus), button messages (confirmations), payment links
- Phone number → customerId mapping in Redis
- Same tools, same cart, same Medusa backend as web

### Step 13 — LGPD Compliance (pre-launch)

Required before any real users see the platform:
- Cookie consent banner — blocks PostHog until accepted
- `/privacidade` — what data is collected, how it's used, retention period
- `/termos` — purchase terms, returns, delivery policy
- WhatsApp first-message opt-in — inform users their number is stored and how it's used
- Data retention policy in Medusa customer settings

### Step 14 — Observability

Production-grade visibility:
- Structured pino logs → CloudWatch in production
- PostHog dashboards: sales, products, reservations, agent performance, customer cohorts
- Sentry for error tracking
- BetterStack for uptime monitoring
- `pnpm check` extended to cover all running services
