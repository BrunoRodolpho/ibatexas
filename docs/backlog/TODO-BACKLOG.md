# IbateXas Pre-Launch Backlog
 
## Summary
 
- **All P0 and P1 items are DONE** (22/30 completed)
- Remaining: 11 items before launch-ready
 
---
 
## Step 1 — LGPD Compliance
 
Required before any real users:
 
- [ ] Cookie consent banner — blocks PostHog until accepted
- [ ] `/privacidade` — data collection, usage, retention
- [ ] `/termos` — purchase terms, returns, delivery policy
- [ ] WhatsApp first-message opt-in disclosure
- [ ] Data retention policy in Medusa customer settings
 
---
 
## Step 2 — Observability
 
Production-grade visibility:
 
- [ ] Structured pino logs → CloudWatch
- [ ] PostHog dashboards: create the 3 dashboards defined in `docs/analytics-dashboards.md`
- [ ] Sentry error tracking setup (DSN configured, code instrumented — needs project creation)
- [ ] BetterStack uptime monitoring
 
---
 
## Step 3 — Remaining Agent Tools + API Docs
 
3 tools from the spec not yet implemented:
 
- [ ] `check_inventory` — real-time stock check for a variant
- [ ] `get_nutritional_info` — full ANVISA-format breakdown
- [ ] `handoff_to_human` — escalate to staff via WhatsApp notification
 
API documentation:
 
- [ ] Swagger/OpenAPI at `/docs` — wire `@fastify/swagger` + `@fastify/swagger-ui` into existing Fastify route schemas
 
---
 
## Step 4 — Post-Launch Hardening
 
Non-blocking, do after launch:
 
- [ ] **EVT-001** Full JetStream migration for NATS (Redis outbox sufficient for launch)
- [ ] **ARCH-001** Authorization layer extraction (guards work, just not formalized)
- [ ] **OBS-001** Distributed tracing across API → Medusa → Typesense → Redis
 
---
 
## Cleanup
 
> **Note:** Admin UI lives at `apps/admin` (port 3002) as a standalone Next.js app.
> The deprecated admin routes in `apps/web/src/app/[locale]/admin/` should be
> deleted once the team confirms the migration. After deleting, remove
> `@tanstack/react-table` from `apps/web/package.json`.
 
---
 
## Validation WARN Items (Tech Debt)
 
1. **Redis-down JWT revocation bypass** — Revoked JWTs accepted if Redis is down. Intentional, 4h JWT lifetime cap mitigates.
2. **Non-atomic analytics counters** — `cache:stats:*` uses `redis.incr()`. No security impact.
3. **Phone hash 48-bit collision space** — ~50% collision at 16.8M phones. Rate-limit only, not sessions.
4. **ECS egress fully open** — Standard for Fargate, could harden later.