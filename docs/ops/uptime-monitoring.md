# Uptime Monitoring — BetterStack

Configuration guide for BetterStack uptime monitors, alert channels, and public status page for IbateXas production infrastructure.

---

## Monitors

Four HTTP monitors covering all public-facing services. Each monitor pings its target at a fixed interval and alerts after consecutive failures.

| Monitor | URL | Method | Expected | Interval | Alert after |
|---------|-----|--------|----------|----------|-------------|
| API Health | `{API_URL}/health` | GET | HTTP 200 | 60s | 2 consecutive failures |
| Web Storefront | `{WEB_URL}` | GET | HTTP 200 | 60s | 2 consecutive failures |
| Medusa Commerce | `{MEDUSA_URL}/health` | GET | Response body contains `"OK"` | 60s | 2 consecutive failures |
| Admin Panel | `{ADMIN_URL}` | GET | HTTP 200 | 120s | 2 consecutive failures |

> Replace `{API_URL}`, `{WEB_URL}`, `{MEDUSA_URL}`, and `{ADMIN_URL}` with the actual production URLs from environment variables.

### Monitor details

**API Health**
- Endpoint: `/health` route on the main API server
- Validates that the API process is running and responding
- 60-second check interval ensures fast detection of outages

**Web Storefront**
- Checks the Next.js storefront root URL
- A 200 response confirms the SSR pipeline and CDN are operational

**Medusa Commerce**
- Checks the Medusa v2 health endpoint
- Expects the response body to contain `"OK"` (not just HTTP 200) to verify the application layer is healthy, not just the reverse proxy

**Admin Panel**
- Lower priority — checked every 120 seconds instead of 60
- Staff-facing only, so slightly relaxed monitoring is acceptable

---

## Alert Channels

### Primary: Email

- **Recipient:** Owner/operator email address
- **Trigger:** Immediately on alert threshold (2 consecutive failures)
- **Content:** Monitor name, status, timestamp, response details

### Secondary: WhatsApp (via Twilio)

- **Integration:** BetterStack webhook → Twilio API → WhatsApp message
- **Required environment variables:**
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - Alert recipient phone number (WhatsApp-enabled)
- **Trigger:** 5 minutes after initial alert, if unacknowledged

### Escalation Policy

| Step | Channel | Timing |
|------|---------|--------|
| 1 | Email | Immediately on alert |
| 2 | WhatsApp | 5 minutes after alert, if unacknowledged |

> If the email alert is acknowledged (manually in BetterStack dashboard), the WhatsApp escalation is skipped.

---

## Status Page

Public-facing status page for customers to check service availability.

### Configuration

| Field | Value |
|-------|-------|
| **Public URL** | Custom subdomain (e.g., `status.ibatexas.com`) or BetterStack-hosted URL |
| **Visibility** | Public — no authentication required |

### Components

Display the following components on the status page, each mapped to one or more monitors:

| Component | Display Name | Mapped Monitor(s) |
|-----------|-------------|-------------------|
| Storefront | Storefront | Web Storefront |
| API | API | API Health |
| Pagamentos | Pagamentos | API Health (payment endpoints) |
| Reservas | Reservas | API Health (reservation endpoints) |

### Status indicators

Each component shows one of three states:

| Status | Meaning | Visual |
|--------|---------|--------|
| **Operacional** | All monitors passing | Green |
| **Degradado** | Intermittent failures or elevated latency | Yellow |
| **Fora do ar** | Monitor is down (2+ consecutive failures) | Red |

---

## Setup Steps

### 1. Create BetterStack account

1. Sign up at [betterstack.com](https://betterstack.com)
2. Navigate to **Uptime** section in the dashboard

### 2. Add monitors

Create each monitor via the BetterStack dashboard or API:

**Via Dashboard:**
1. Click **Create Monitor**
2. Set the URL, method, expected status/body, and check interval per the table above
3. Set "Alert after" to 2 consecutive failures
4. Repeat for all four monitors

**Via API (optional):**
```bash
curl -X POST https://uptime.betterstack.com/api/v2/monitors \
  -H "Authorization: Bearer ${BETTERSTACK_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "monitor_type": "status",
    "url": "https://api.ibatexas.com/health",
    "pronounceable_name": "API Health",
    "check_frequency": 60,
    "confirmation_period": 120
  }'
```

### 3. Configure Twilio integration for WhatsApp alerts

1. In BetterStack, go to **Integrations** → **Webhooks**
2. Create a webhook that posts to a Twilio-powered endpoint
3. The endpoint should use the Twilio API to send a WhatsApp message:
   - Account SID: `TWILIO_ACCOUNT_SID`
   - Auth Token: `TWILIO_AUTH_TOKEN`
   - From: Twilio WhatsApp sender (e.g., `whatsapp:+14155238886`)
   - To: Operator's WhatsApp number
   - Body: Monitor name + status + timestamp
4. Set the webhook to fire after 5-minute escalation delay

### 4. Create status page and add components

1. In BetterStack, go to **Status Pages** → **Create Status Page**
2. Set the page name (e.g., "IbateXas Status")
3. Configure custom domain if desired (`status.ibatexas.com`)
4. Add components:
   - **Storefront** — linked to Web Storefront monitor
   - **API** — linked to API Health monitor
   - **Pagamentos** — linked to API Health monitor
   - **Reservas** — linked to API Health monitor
5. Set the page to **Public**
6. Share the status page URL with customers as needed
