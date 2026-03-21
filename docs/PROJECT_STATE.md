# Project State

> Last updated: 2026-03-20

---

## What Works End-to-End

| Feature | Status | Evidence |
|---------|--------|----------|
| Auth (Twilio OTP + JWT + refresh) | WORKS | `apps/api/src/routes/auth.ts` — real Twilio calls, rate limiting, JWT revocation via Redis |
| Browse catalog + Typesense search | WORKS | `apps/api/src/routes/catalog.ts` + `packages/tools/src/search/search-products.ts` |
| Add to cart (Medusa) | WORKS | `apps/api/src/routes/cart.ts` + Redis active cart tracking |
| Card checkout (Stripe) | WORKS | `apps/api/src/routes/stripe-webhook.ts` — signature verify, idempotency, 4 event handlers |
| Cash checkout | WORKS | `packages/tools/src/cart/create-checkout.ts` — completes order, publishes `order.placed` |
| Order tracking (IDOR-safe) | WORKS | `apps/api/src/routes/cart.ts` — ownership check on order retrieval |
| Reservations (customer) | WORKS | `apps/api/src/routes/reservations.ts` — availability, create, modify, cancel, waitlist |
| WhatsApp agent chat | WORKS | `apps/api/src/routes/whatsapp-webhook.ts` — 471 lines, state machine, debounce, rate limit |
| Staff authentication | WORKS | `apps/api/src/routes/auth.ts` — role-based (OWNER/MANAGER/ATTENDANT) |
| Admin dashboard | WORKS | `apps/admin/src/app/admin/page.tsx` — loads metrics + recent orders |
| Admin menu management | WORKS | `apps/admin/src/app/admin/cardapio/page.tsx` — list, search, toggle product status |
| Abandoned cart detection | WORKS | `apps/api/src/jobs/abandoned-cart-checker.ts` |
| Analytics event tracking | WORKS | PostHog client-side + NATS server-side |
| Delivery fee estimation | WORKS | `packages/tools/src/catalog/estimate-delivery.ts` + delivery zone lookup by CEP |

---

## What's Partial

| Feature | Status | What's missing |
|---------|--------|----------------|
| PIX checkout | CODE EXISTS | Untested in production, no timeout/expiry handling |
| Order refund handling | WEBHOOK ONLY | Stripe webhook fires but subscriber is TODO (`stripe-webhook.ts:85`) |
| Order dispute handling | WEBHOOK ONLY | Same — subscriber TODO (`stripe-webhook.ts:113`) |
| Intelligence tools (5) | REGISTERED BUT UNUSED | `get-recommendations`, `get-ordered-together`, `get-also-added`, `get-customer-profile`, `update-preferences` — registered in tool-registry but no agent prompt invokes them |
| Embeddings/vector search | DEAD CODE | 180+ lines in `packages/tools/src/embeddings/`, 0 production calls, requires OpenAI key for nothing |
| Wishlist | HALF-SHIPPED | Store + button exist, not wired into ProductCard/PDP, no "My Wishlist" page |

---

## What's Broken / Missing

| Feature | Status | Impact |
|---------|--------|--------|
| Web login UI | DOES NOT EXIST | Auth routes work but no page calls them |
| Admin orders page | STUB | Returns `<AdminComingSoonPage />` |
| Admin reservations page | STUB | Returns `<AdminComingSoonPage />` |
| Admin analytics page | STUB | Returns `<AdminComingSoonPage />` |
| Admin ratings page | STUB | Returns `<AdminComingSoonPage />` |
| Admin store settings | STUB | Returns `<AdminComingSoonPage />` |

---

## P0 for Launch (nothing else matters)

From [TODO-BACKLOG.md](backlog/TODO-BACKLOG.md) Steps 1-3 (13 items):

**LGPD Compliance (5 items)** — Required before any real users
- Cookie consent banner — blocks PostHog until accepted
- `/privacidade` — data collection, usage, retention
- `/termos` — purchase terms, returns, delivery policy
- WhatsApp first-message opt-in disclosure
- Data retention policy in Medusa customer settings

**Observability (4 items)** — Required for production visibility
- Structured pino logs -> CloudWatch
- PostHog dashboards: create the 3 dashboards defined in [analytics-dashboards.md](analytics-dashboards.md)
- Sentry error tracking setup
- BetterStack uptime monitoring

**Remaining Agent Tools + API Docs (4 items)**
- `check_inventory` — real-time stock check
- `get_nutritional_info` — ANVISA-format breakdown
- `handoff_to_human` — escalate to staff via WhatsApp
- Swagger/OpenAPI at `/docs`

**Everything else is NOT P0.**

---

## Test Coverage Reality

| Workspace | Coverage | Verdict |
|-----------|----------|---------|
| apps/api | 72% (36 tests) | STRONG — auth, cart, webhooks, jobs |
| packages/tools | 83% (43 tests) | STRONG — all tools, cart logic, search |
| packages/llm-provider | 100% (4 tests) | STRONG — agent + tool registry |
| packages/nats-client | 100% (2 tests) | STRONG |
| apps/web | 9% (15 tests) | WEAK — only store logic, 0 component tests |
| packages/domain | 3% (1 test) | WEAK — Prisma services untested |
| apps/commerce | 11% (1 test) | WEAK — only indexing subscriber |
| apps/admin | 0% | NONE |
| packages/ui | 0% | NONE |
| E2E (Playwright) | 3 specs | MINIMAL — smoke + golden paths only |

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

**Tier 2 — Should have (core UX)** — GAPS
- Web component tests (0 today, should cover: ProductCard, CartDrawer, Checkout form)
- Domain services (`packages/domain` — 1 test for 35 files)
- Admin API routes (sparse coverage)
- E2E: expand beyond 3 specs to cover auth flow, payment error, reservation

**Tier 3 — Nice to have (polish)**
- CLI command tests (16 exist, adequate for now)
- Intelligence tools (mock-only tests exist, keep as-is until tools are actively used)
- UI package component tests

### What NOT to Test Right Now

- Medusa internals (tested by Medusa)
- Prisma generated client (tested by Prisma)
- Type definitions (`packages/types` — no runtime logic)
- Seed scripts (manual verification sufficient)
- Dead code (embeddings, unused intelligence tools — delete instead of testing)

### Test Types

| Type | Tool | Where | Run |
|------|------|-------|-----|
| Unit | Vitest | `**/*.test.ts` co-located or `__tests__/` | `ibx test` |
| E2E | Playwright | `tests/e2e/*.spec.ts` | `npx playwright test` |
| Coverage | v8 + SonarCloud | Uploaded in CI | Automatic on PR |
| Security | CodeQL + Gitleaks | `.github/workflows/` | Automatic on PR |

---

## Dead Complexity (820+ lines)

| Code | Lines | Status | Action |
|------|-------|--------|--------|
| `packages/tools/src/embeddings/` | 180 | 0 production calls | DELETE |
| `packages/tools/src/cache/embedding-cache.ts` | 100 | Dead | DELETE |
| 5 intelligence tools | 540 | Registered, never invoked | DEPRECATE |
| Wishlist (store + button) | 100 | Not wired in | SHIP or DELETE |

Tracked in [TODO-BACKLOG.md](backlog/TODO-BACKLOG.md) Step 5: DEAD-001, DEAD-002, DEAD-003.
