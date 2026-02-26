# Next Steps — Phase 1 Build Order

Steps 1–8 are complete. Steps 9–14 are below in order.
Remove a step from this file once it is done (git history is the record).

---

### Step 9 — Customer Intelligence

- `CustomerProfile` in Redis — populated from Medusa order history on first login
- Tools: `get_recommendations`, `update_preferences`, `submit_review`, `get_customer_profile`
- NATS event publishing (full catalogue in [customer-intelligence.md](design/customer-intelligence.md))
- Post-delivery review prompt — 30min delay via NATS → WhatsApp
- Review display on product pages (rolling average)

  > Abandoned cart publisher: scheduled job in `apps/api` (cron every 1h, checks carts
  > inactive > 24h). Publishes `cart.abandoned`. Subscriber in `packages/tools` sends
  > WhatsApp reminder and updates CustomerProfile.

---

### Step 10 — Checkout

Full purchase flow:

- Cart state via Medusa (guest + authenticated)
- Delivery type: delivery / pickup / dine-in
- CEP validation via ViaCEP + zone + fee
- Payments: PIX (QR) + Stripe card + cash + boleto (merchandise only)
- Gorjeta option (restaurant orders)
- Order confirmation + estimated time
- NF-e via Focus NFe

---

### Step 11 — Auth (Twilio Verify — WhatsApp OTP)

Auth via Twilio Verify — no passwords. Same flow for customers and staff.

- `POST /api/auth/send-otp` — sends WhatsApp OTP via Twilio Verify
- `POST /api/auth/verify-otp` — validates code, issues JWT + sets cookie
- API middleware: require auth on `/api/chat/*`, `/api/orders/*`, `/api/admin/*`
- Web middleware: require auth on `/checkout`, `/conta`, `/reservas`, `/admin`
- Guest → Customer promotion at checkout (cart migration)
- Staff role differentiated by `CustomerProfile.type` field, not by auth provider
- JWT stored in httpOnly cookie; refresh via `@fastify/jwt` + `@fastify/cookie`

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
- PostHog dashboards: sales, products, reservations, agent performance, customer cohorts
- Sentry for error tracking
- BetterStack for uptime monitoring
- `ibx health` extended to cover all running app services
