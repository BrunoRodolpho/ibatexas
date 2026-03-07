# Next Steps — Remaining Build Order

Steps 1–11 are complete. Steps 12–15 are below in order.
Remove a step from this file once it is done (git history is the record).

> **Note:** Admin UI lives at `apps/admin` (port 3002) as a standalone Next.js app.
> The deprecated admin routes in `apps/web/src/app/[locale]/admin/` should be
> deleted once the team confirms the migration. After deleting, remove
> `@tanstack/react-table` from `apps/web/package.json`.

---

### Step 12 — WhatsApp Channel

Connect the agent to WhatsApp via Twilio:

- Incoming webhook → parse → build `AgentContext { channel: 'whatsapp' }` → run agent
- Outgoing: text, image (product photos), list messages (menus), button messages (confirmations), payment links
- Phone → customerId mapping in Redis
- Same tools, same cart, same Medusa backend as web

---

### Step 13 — LGPD Compliance

Required before any real users:

- Cookie consent banner — blocks PostHog until accepted
- `/privacidade` — data collection, usage, retention
- `/termos` — purchase terms, returns, delivery policy
- WhatsApp first-message opt-in disclosure
- Data retention policy in Medusa customer settings

---

### Step 14 — Observability

Production-grade visibility:

- Structured pino logs → CloudWatch
- PostHog dashboards: create the 3 dashboards defined in `docs/analytics-dashboards.md` (PostHog integration code is complete — only UI dashboard setup remains)
- Sentry for error tracking
- BetterStack for uptime monitoring

---

### Step 15 — Remaining Agent Tools + API Docs

3 tools from the spec not yet implemented:

- `check_inventory` — real-time stock check for a variant (standalone, beyond `add_to_cart` internal check)
- `get_nutritional_info` — full ANVISA-format breakdown (beyond `get_product_details.nutritionalInfo`)
- `handoff_to_human` — escalate to staff via WhatsApp notification

API documentation:

- Swagger/OpenAPI at `/docs` — wire `@fastify/swagger` + `@fastify/swagger-ui` into existing Fastify route schemas
