# Project State

> Last updated: 2026-03-31

---

## What Works End-to-End

| Feature | Status | Evidence |
|---------|--------|----------|
| Auth (Twilio OTP + JWT + refresh) | WORKS | `apps/api/src/routes/auth.ts` — real Twilio calls, rate limiting, JWT revocation via Redis |
| Browse catalog + Typesense search | WORKS | `apps/api/src/routes/catalog.ts` + `packages/tools/src/search/search-products.ts` |
| Add to cart (Medusa) | WORKS | `apps/api/src/routes/cart.ts` + Redis active cart tracking |
| Card checkout (Stripe) | WORKS | `apps/api/src/routes/stripe-webhook.ts` — signature verify, idempotency, 4 event handlers. Frontend: `CardPaymentForm.tsx` — embedded Stripe PaymentElement + 3DS redirect handling |
| Cash checkout | WORKS | `packages/tools/src/cart/create-checkout.ts` — completes order, publishes `order.placed` |
| Order tracking (IDOR-safe) | WORKS | `apps/api/src/routes/cart.ts` — ownership check on order retrieval |
| Reservations (customer) | WORKS | `apps/api/src/routes/reservations.ts` — availability, create, modify, cancel, waitlist |
| WhatsApp agent chat | WORKS | `apps/api/src/routes/whatsapp-webhook.ts` — state machine, debounce, rate limit, LGPD opt-in |
| Staff authentication | WORKS | `apps/api/src/routes/auth.ts` — role-based (OWNER/MANAGER/ATTENDANT) |
| Admin dashboard | WORKS | `apps/admin/src/app/admin/page.tsx` — loads metrics + recent orders |
| Admin menu management | WORKS | `apps/admin/src/app/admin/cardapio/page.tsx` — list, search, toggle product status |
| Admin orders page | WORKS | `apps/admin/src/app/admin/pedidos/page.tsx` — DataTable, status filters, pagination |
| Admin reservations page | WORKS | `apps/admin/src/app/admin/reservas/page.tsx` — date/status filters, check-in/complete actions |
| Admin analytics page | WORKS | `apps/admin/src/app/admin/analises/page.tsx` — 4 stat cards (orders, revenue, AOV, active carts) |
| Admin ratings page | WORKS | `apps/admin/src/app/admin/avaliacoes/page.tsx` — star filter, low-rating highlighting |
| Abandoned cart detection | WORKS | `apps/api/src/jobs/abandoned-cart-checker.ts` |
| PIX timeout/expiry | WORKS | `apps/api/src/jobs/pix-expiry-checker.ts` — auto-cancel after configurable expiry |
| Analytics event tracking | WORKS | PostHog client-side (consent-gated) + NATS server-side |
| Delivery fee estimation | WORKS | `packages/tools/src/catalog/estimate-delivery.ts` + delivery zone lookup by CEP |
| Cookie consent (LGPD) | WORKS | Zustand store + banner, gates PostHog initialization |
| Privacy policy page | WORKS | `apps/web/src/app/[locale]/privacidade/page.tsx` — 6 LGPD sections |
| Terms of use page | WORKS | `apps/web/src/app/[locale]/termos/page.tsx` — 4 sections, checkout terms checkbox |
| WhatsApp LGPD opt-in | WORKS | First-message disclosure, Redis-backed one-time flag |
| LGPD data export/delete | WORKS | `GET /api/me/data` + `DELETE /api/me/data` with customer anonymization |
| Wishlist | WORKS | Store, ProductCard button, PDP button, `/lista-desejos` page, Header badge |
| Web login UI wiring | WORKS | Header "Entrar" link, MobileBottomNav auth-aware, checkout/account redirects |
| Structured logging | WORKS | Pino throughout `apps/api`, zero `console.*` calls |
| Sentry error tracking | WORKS | Instrumented in apps/api, apps/web, apps/admin |
| Agent: check_inventory | WORKS | `packages/tools/src/catalog/check-inventory.ts` — real-time Medusa stock check |
| Agent: get_nutritional_info | WORKS | `packages/tools/src/catalog/get-nutritional-info.ts` — ANVISA-format from product metadata |
| Agent: handoff_to_human | WORKS | `packages/tools/src/support/handoff-to-human.ts` — NATS event + staff WhatsApp notification |
| Agent: intelligence tools | WORKS | 5 tools activated in system prompt (recommendations, ordered-together, also-added, profile, preferences) |
| Swagger/OpenAPI docs | WORKS | `@fastify/swagger` + `@fastify/swagger-ui` at `/docs` |
| Order refund/dispute handling | WORKS | Cart-intelligence subscribers handle `order.refunded` and `order.disputed` events |
| Conversation persistence (CDC) | WORKS | `appendMessages()` → NATS → `conversation-archiver` → Postgres. Redis is hot path, Postgres is durable archive |
| `ibx chat` CLI commands | WORKS | `ibx chat list/dump/clean/scenarios` — conversation management and E2E test runner |
| Zero-Trust LLM architecture | WORKS | Tool classification (READ_ONLY vs MUTATING), intent bridge, state-gate, ownership-based locks |
| Post-order sub-states | WORKS | `post_order.cancelling`, `post_order.amending`, `post_order.regenerating_pix` — kernel-controlled |
| Admin auth middleware | WORKS | `apps/admin/src/middleware.ts` — staff_token cookie check, proxy path allowlist |
| Cart ownership (IDOR prevention) | WORKS | `apps/api/src/routes/cart.ts` — Redis `cart:owner:{cartId}` mapping |
| Guest session secrets | WORKS | `apps/api/src/routes/chat.ts` — UUID session secret on first POST, required on subsequent |
| Fail-closed security | WORKS | JWT revocation + SSE ownership return 503 when Redis is unreachable (not fail-open) |

---

## What's Partial

| Feature | Status | What's missing |
|---------|--------|----------------|
| Admin store settings | STUB | Returns `<AdminComingSoonPage />` — lowest priority admin page |

---

## What's Broken / Missing

Nothing blocking launch.

---

## Recent Architecture Changes (2026-03-31)

### Red Team Audit → Blue Team Remediation → Final Alignment

**P0 fixes applied:**
- Tool dispatch state-gate: LLM cannot call tools outside allowed set for current state
- Post-LLM event injection whitelist: only `PIX_DETAILS_COLLECTED` and `SET_NAME` allowed
- Admin proxy auth: middleware + path allowlist (was unauthenticated)
- Welcome credit atomic GETDEL (was non-atomic GET + DEL race)
- Cart creation lock (was TOCTOU double-create race)

**P1 fixes applied:**
- Ownership-based Redis locks with Lua conditional release (WhatsApp + Web)
- Web chat lock heartbeat (was missing — 30s fixed TTL)
- SSE stream + JWT revocation fail closed on Redis failure
- Machine snapshot persistence retry (was swallow-all-errors)
- Module-level schedule race condition eliminated (threaded through params)
- Session rotation atomic Lua script (was TOCTOU race)
- Cash payment now goes through confirmation step
- Metrics counters use atomicIncr() (was non-atomic INCR + EXPIRE)

**Final Alignment (Zero-Trust LLM):**
- Tool classification: 15 READ_ONLY + 19 MUTATING
- Intent bridge: `executeTool()` returns intent for mutating tools
- post_order refactored to compound state with cancelling/amending/regenerating_pix sub-states
- Prompts rewritten: no executive "CHAME" language, zero-authority preamble
- STATE_TOOLS updated: LLM only gets read-only tools in all states

---

## Pre-Launch Checklist

All 13 pre-launch items from [TODO-BACKLOG.md](backlog/TODO-BACKLOG.md) Steps 1-3 are **COMPLETE**:

- ✅ LGPD Compliance (5/5 items)
- ✅ Observability (4/4 items)
- ✅ Agent Tools + API Docs (4/4 items)

---

## Test Coverage Reality

| Workspace | Coverage | Verdict |
|-----------|----------|---------|
| apps/api | 72%+ (45+ tests) | STRONG — auth, cart, webhooks, jobs, LGPD endpoints, opt-in |
| packages/tools | 83%+ (49+ tests) | STRONG — all tools including new check_inventory, get_nutritional_info, handoff_to_human |
| packages/llm-provider | 100% (4 + 11 scenario tests) | STRONG — agent + tool registry + 11 conversation scenario integration tests |
| packages/nats-client | 100% (2 tests) | STRONG |
| apps/web | ~12% (20+ tests) | IMPROVED — consent store, CookieConsentBanner, privacy/terms pages |
| packages/domain | 3% (1 test) | WEAK — Prisma services untested |
| apps/commerce | 11% (1 test) | WEAK — only indexing subscriber |
| apps/admin | 0% | NONE |
| packages/ui | 0% | NONE |
| E2E (Playwright) | 3 specs | MINIMAL — smoke + golden paths only |
| Conversation scenarios | 11 fixtures | STRONG — router → machine → synthesizer pipeline (happy path, variants, PIX, objections, cart recovery) |

---

## Testing Strategy

### Philosophy: Confidence, Not Completeness

Test what handles **money, auth, and user data** first. Everything else follows.

### Priority Tiers

**Tier 1 — Must have (handles money/auth/data)** — DONE
- Auth routes (OTP, JWT, refresh, revocation) — 1,026 lines of tests
- Cart routes (create, add, update, checkout) — 583 lines
- Stripe webhooks (payment success/failure/refund) — tested
- Reservation TOCTOU (transactional availability) — tested
- Agent tool ownership guards — tested
- LGPD data export/delete endpoints — tested

**Tier 2 — Should have (core UX)** — GAPS
- Web component tests (improving, consent + page tests added)
- Domain services (`packages/domain` — 1 test for 35 files)
- Admin API routes (analytics endpoint tested)
- E2E: expand beyond 3 specs to cover auth flow, payment error, reservation

**Tier 3 — Nice to have (polish)**
- CLI command tests (16 exist, adequate for now)
- Intelligence tools (mock-only tests exist, tools now active)
- UI package component tests
- Admin component tests

### What NOT to Test Right Now

- Medusa internals (tested by Medusa)
- Prisma generated client (tested by Prisma)
- Type definitions (`packages/types` — no runtime logic)
- Seed scripts (manual verification sufficient)

### Test Types

| Type | Tool | Where | Run |
|------|------|-------|-----|
| Unit | Vitest | `**/*.test.ts` co-located or `__tests__/` | `ibx test` |
| E2E | Playwright | `tests/e2e/*.spec.ts` | `npx playwright test` |
| Coverage | v8 + SonarCloud | Uploaded in CI | Automatic on PR |
| Security | CodeQL + Gitleaks | `.github/workflows/` | Automatic on PR |

---

## Dead Complexity — RESOLVED

| Code | Lines | Status | Action Taken |
|------|-------|--------|-------------|
| `packages/tools/src/embeddings/` | 180 | DELETED | Removed (DEAD-001) |
| `packages/tools/src/cache/embedding-cache.ts` | 100 | DELETED | Removed (DEAD-001) |
| `packages/tools/src/utils/vectors.ts` | 40 | DELETED | Removed (DEAD-001) |
| 5 intelligence tools | 540 | ACTIVATED | Added to agent system prompt (DEAD-003) |
| Wishlist (store + button) | 100 | SHIPPED | Wired into ProductCard, PDP, Header, /lista-desejos (DEAD-002) |

---

## New Ops Documentation

| Document | Purpose |
|----------|---------|
| `docs/ops/data-retention.md` | LGPD data retention policy + customer rights |
| `docs/ops/posthog-setup.md` | 3 PostHog dashboard definitions + event verification |
| `docs/ops/uptime-monitoring.md` | BetterStack monitors, alerts, status page setup |
| `docs/ops/logging.md` | Pino structured logging conventions |

---

## New Env Vars Required

| Variable | App | Purpose |
|----------|-----|---------|
| `SENTRY_DSN` | apps/api | Sentry error tracking (API) |
| `NEXT_PUBLIC_SENTRY_DSN` | apps/web, apps/admin | Sentry error tracking (frontend) |
| `PIX_EXPIRY_MINUTES` | apps/api | PIX payment timeout (default: 30) |
| `STAFF_NOTIFICATION_PHONE` | apps/api | Staff WhatsApp for handoff notifications |
| `LOG_LEVEL` | apps/api | Pino log level (default: "info") |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | apps/web | Stripe publishable key for embedded card payment form |
