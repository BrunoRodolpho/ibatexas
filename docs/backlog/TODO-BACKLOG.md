# IbateXas Pre-Launch Backlog

## Summary

- **All P0, P1, and pre-launch items are DONE** (Steps 1-3 complete)
- **Quality & polish partially done** (Step 5: DEAD-001, DEAD-002, DEAD-003 complete)
- Remaining: 3 post-launch hardening (Step 4), 7 quality & polish (Step 5)

---

## Step 1 — LGPD Compliance ✅ COMPLETE

- [x] Cookie consent banner — blocks PostHog until accepted
- [x] `/privacidade` — data collection, usage, retention
- [x] `/termos` — purchase terms, returns, delivery policy
- [x] WhatsApp first-message opt-in disclosure
- [x] Data retention policy + LGPD data export/anonymize endpoints

---

## Step 2 — Observability ✅ COMPLETE

- [x] Structured pino logs (zero `console.*` in apps/api)
- [x] PostHog dashboards: 3 dashboards documented in `docs/ops/posthog-setup.md`
- [x] Sentry error tracking (apps/api, apps/web, apps/admin)
- [x] BetterStack uptime monitoring documented in `docs/ops/uptime-monitoring.md`

---

## Step 3 — Remaining Agent Tools + API Docs ✅ COMPLETE

- [x] `check_inventory` — real-time stock check for a variant
- [x] `get_nutritional_info` — full ANVISA-format breakdown
- [x] `handoff_to_human` — escalate to staff via WhatsApp notification
- [x] Swagger/OpenAPI at `/docs` — `@fastify/swagger` + `@fastify/swagger-ui` in production

---

## Step 4 — Post-Launch Hardening

Non-blocking, do after launch:

- [ ] **EVT-001** Full JetStream migration for NATS (Redis outbox sufficient for launch)
- [ ] **ARCH-001** Authorization layer extraction (guards work, just not formalized)
- [ ] **OBS-001** Distributed tracing across API → Medusa → Typesense → Redis

---

## Step 5 — Quality & Polish (Post-Launch)

### Done

- [x] **DEAD-001** Delete embeddings dead code (`packages/tools/src/embeddings/`, `cache/embedding-cache.ts`, `utils/vectors.ts`)
- [x] **DEAD-002** Ship wishlist (ProductCard, PDP, /lista-desejos page, Header badge, account link)
- [x] **DEAD-003** Activate intelligence tools in agent system prompt
- [x] **UX-001** Admin panel stubs replaced (orders, reservations, analytics, reviews pages)

### Remaining

- [ ] **TST-WEB** Test coverage for `apps/web` — component + page tests
- [ ] **TST-ADMIN** Test coverage for `apps/admin`
- [ ] **TST-UI** Test coverage for `packages/ui` — shared component library
- [ ] **TST-DOMAIN** Test coverage for `packages/domain` — Prisma services
- [ ] **TST-E2E** Expand Playwright suite beyond 3 specs
- [ ] **INFRA-DOC** Full Terraform guide (init, state mgmt, apply per environment)
- [ ] Admin store settings page (still stub)

---

## Validation WARN Items (Tech Debt)

1. **Redis-down JWT revocation bypass** — Revoked JWTs accepted if Redis is down. Intentional, 4h JWT lifetime cap mitigates.
2. **Non-atomic analytics counters** — `cache:stats:*` uses `redis.incr()`. No security impact.
3. **Phone hash 48-bit collision space** — ~50% collision at 16.8M phones. Rate-limit only, not sessions.
4. **ECS egress fully open** — Standard for Fargate, could harden later.
