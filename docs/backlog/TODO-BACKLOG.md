# IbateXas Pre-Launch Backlog

## Summary

- **All P0, P1, and pre-launch items are DONE** (Steps 1-3 complete)
- **Security hardening DONE** (Step 6: Red Team audit + remediation + Zero-Trust alignment)
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
- [ ] **SEC-RES-1** `packages/tools/src/intelligence/welcome-credit.ts` — second copy of GET+DEL race (needs GETDEL)
- [ ] **SEC-RES-2** Session rotation should check for active checkout before rotating
- [ ] **SEC-RES-3** SSE streaming needs Redis Pub/Sub for horizontal scaling
- [ ] **SEC-RES-4** `wa:optin:*` keys need TTL (365 days recommended)
- [ ] **SEC-RES-5** Analytics endpoint needs per-IP rate limiting or session auth
- [ ] **SEC-RES-6** Router quantity extraction should not match CEP digits

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
- [x] **TST-E2E** ~~Expand Playwright suite beyond 3 specs~~ — partially addressed: 11 conversation scenario integration tests added (`packages/llm-provider/src/__tests__/scenarios/`). Playwright specs still at 3.
- [ ] **TST-E2E-PW** Expand Playwright E2E specs (auth flow, payment error, reservation) — original scope from TST-E2E
- [ ] **INFRA-DOC** Full Terraform guide (init, state mgmt, apply per environment)
- [ ] Admin store settings page (still stub)

---

---

## Step 6 — Security Hardening ✅ COMPLETE (2026-03-31)

Red Team Audit → Blue Team Remediation → Final Alignment

- [x] **SEC-P0-1** Tool dispatch state-gate (LLM cannot call tools outside allowed state)
- [x] **SEC-P0-2** Post-LLM event injection whitelist (`ALLOWED_POST_LLM_EVENTS`)
- [x] **SEC-P0-3** Admin proxy authentication + path allowlist
- [x] **SEC-P0-4** Welcome credit atomic GETDEL (race condition fix)
- [x] **SEC-P0-5** Cart creation lock (TOCTOU race fix)
- [x] **SEC-P1-6** Ownership-based Redis locks (WhatsApp + Web)
- [x] **SEC-P1-7** Web chat lock heartbeat
- [x] **SEC-P1-8** SSE stream fail-closed on Redis failure
- [x] **SEC-P1-9** Machine snapshot persistence retry
- [x] **SEC-P1-10** Module-level schedule race eliminated
- [x] **SEC-P1-11** Session rotation atomic Lua script
- [x] **SEC-P1-12** Cash payment confirmation step
- [x] **SEC-P1-13** JWT revocation fail-closed
- [x] **SEC-P1-14** Metrics atomicIncr() (3 locations)
- [x] **ALIGN-1** Zero-Trust LLM tool classification (READ_ONLY vs MUTATING)
- [x] **ALIGN-2** Intent bridge (`executeTool` returns intent for mutating tools)
- [x] **ALIGN-3** post_order compound state (cancelling, amending, regenerating_pix)
- [x] **ALIGN-4** Prompts rewritten for proposer role (no "CHAME" directives)

---

## Post-Launch — Conversation & Admin

- [ ] **CONV-001** Conversation admin UI — view/search archived conversations in admin panel
- [ ] **CONV-002** JetStream upgrade for guaranteed CDC delivery (conversation archival)
- [ ] **CONV-003** Conversation analytics — avg messages per order, common failure points, drop-off analysis

---

## Validation WARN Items (Tech Debt)

1. ~~**Redis-down JWT revocation bypass**~~ — **FIXED (2026-03-31).** JWT revocation and SSE stream ownership now fail closed (503) when Redis is unreachable.
2. ~~**Non-atomic analytics counters**~~ — **FIXED (2026-03-31).** WhatsApp metrics and staff alert counters now use `atomicIncr()`. Only `cache:stats:*` remains non-atomic (no security impact).
3. **Phone hash 48-bit collision space** — ~50% collision at 16.8M phones. Rate-limit only, not sessions.
4. **ECS egress fully open** — Standard for Fargate, could harden later.
