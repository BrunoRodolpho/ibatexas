# 08 — Security & Trust Boundaries

> Investigator 8 / 8. Scope: security boundaries and trust-crossing surfaces in
> IbateXas that the LLM can reach. Files cited are absolute paths.

## Executive summary

The IbateXas system has a generally well-thought-out trust model — the Zero-Trust
LLM (IGE v2.0) intent bridge prevents the LLM from directly executing mutating
tools, customer cart ownership is checked, webhook signatures are verified for
both Stripe and Twilio, idempotency keys are in place for webhooks, and OTP
rate limiting is layered (IP + phone-hash + brute-force). However, the
"adjudicate is the authority on every sensitive mutation" goal is **not yet
true**:

1. **Adjudication today is scoped to LLM-proposed intents only.** Every REST
   route reachable by an authenticated cookie (customer or staff) bypasses
   `adjudicate()`. Account creation/anonymization, refunds, payment-status
   overrides, order cancel/amend via REST, switch payment method — all go
   straight to domain services. Adjudicate's "only path that mutates" promise
   is currently a half-truth.
2. **The audit pipeline persists raw PII.** `AuditRecord.envelope.payload`
   contains the LLM's literal tool input. For `set_pix_details` that means
   name, email, and CPF; for `cancel_order` that includes the
   `customerId` (`order-policy-bundle.ts` reads `ctx.customerId` from OrderContext
   embedded in the kernel call). Audit records are published verbatim to NATS
   subject `audit.intent.decision.v1` and to console — no redaction, no field
   masking.
3. **Pure-legacy mode is the default for almost every intent kind.** The
   responder in `llm-responder.ts` short-circuits to `EXECUTE` when an intent
   kind is neither in `IBX_KERNEL_ENFORCE` nor `IBX_KERNEL_SHADOW`. In
   practice, the kernel guards are dormant until the env-var rollout flips them
   on.

Webhook verification is solid (Stripe + Twilio WhatsApp + Twilio Verify), but
the LLM can still reach moderately sensitive surfaces (handoff_to_human sends
WhatsApp messages to staff with a user-controlled `reason` string; `cancel_order`
runs without confirmation; `regenerate_pix` can be triggered without explicit
customer confirmation though it is rate-limited 3/h / 5/order).

PII flows: the LLM **sees PII via tool results from `get_customer_profile`,
`get_order_history`**, etc. There IS a `sanitizeToolResultForLLM()` in
`llm-responder.ts` that masks CPF and email in tool result *strings* before
re-feeding to the model, which is a nice defense-in-depth, but it doesn't apply
to the audit pipeline or to the data the model already produced from its prior
turn.

---

## Auth surfaces

### Customer

**Files:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/auth.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/middleware/auth.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/whatsapp/session.ts` (WhatsApp auto-auth)

**Flow:**
1. `POST /api/auth/send-otp` — Twilio Verify (SMS by default, `whatsapp` opt-in via `TWILIO_OTP_CHANNEL`).
2. `POST /api/auth/verify-otp` — verifies code, upserts `Customer`, issues a
   4-hour JWT in `token` cookie + 30-day refresh token in `refresh_token` cookie.
3. `POST /api/auth/refresh` — single-use rotation: deletes the old refresh
   token from Redis (`rk('refresh:{token}')`) before issuing a new one.
4. `POST /api/auth/logout` — best-effort JWT revocation via
   `rk('jwt:revoked:{jti}')` (TTL = remaining JWT life), plus refresh-token
   deletion.
5. `GET /api/auth/me` — returns sanitized customer data.

**Token storage:** JWTs signed with `JWT_SECRET` (HS256), payload `{ sub, userType, jti }`. Cookies are `httpOnly`, `secure` in production, `sameSite=lax`. Refresh tokens are UUIDs persisted in Redis with single-use semantics. Revocation list is Redis-backed with TTL bound to JWT expiry.

**Rate limiting:**
- IP rate limit: 10 OTP attempts/hour (`rk('otp:ip:{ip}')`).
- Phone-hash rate limit on send: 3/10 min (`rk('otp:rate:{hash}')`).
- Brute-force lockout: 5 failures/hour, 429 on subsequent attempts (`rk('otp:fail:{hash}')`).
- Phone hashing: SHA-256 truncated to 12 hex chars. 48-bit collision space — fine for hundreds of thousands of phones, *fails-open* (shared rate-limit bucket) at scale.

**WhatsApp side-channel auth:** The WhatsApp webhook auto-creates a customer record on first inbound message via `customerSvc.upsertFromWhatsApp(phone)`. Trust is rooted in Twilio's signature validation of the inbound webhook. This is a parallel auth path — no OTP required, the phone in `From:` is treated as identity.

**Trust boundary issues:**
- `Redis fail-closed` is correctly enforced in the auth middleware (`RedisUnavailableError` → 503). Good.
- `JWT_SECRET` minimum length is 16 chars (config.ts schema). HS256 needs ≥32 for adequate security; the dev `.env` has a 44-char base64 secret, but production deploys must enforce ≥32.
- `SESSION_HMAC_SECRET` (used by `createSessionToken` in `/packages/tools/src/session/signed-claims.ts`) defaults to literal `"dev-session-secret-change-me"`. If deploys forget to set it, web-channel session tokens are HMAC'd with a known constant.

### Staff/admin

**Files:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/auth.ts` (staff endpoints)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/middleware/staff-auth.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/admin/index.ts`

**Flow:**
1. `POST /api/auth/staff/send-otp` — checks phone is registered staff +
   `active`, sends OTP. Optionally uses a *separate Twilio account*
   (`TWILIO_STAFF_*`) for isolation; falls back to the customer account.
2. `POST /api/auth/staff/verify-otp` — verifies, issues an 8-hour
   `staff_token` JWT with `{ sub: staffId, userType: "staff", role, jti }`.
   **No refresh token** (intentional — shorter-lived sessions).
3. Admin routes accept *either* `staff_token` cookie *or* `x-admin-key` header
   (timing-safe comparison against a comma-separated allow list,
   `ADMIN_API_KEY`).
4. RBAC via `requireStaff` / `requireManager` / `requireManagerRole`
   middleware. `OWNER` / `MANAGER` / `ATTENDANT` are the only roles. Sensitive
   ops (`payment/status` force-override) require explicit `OWNER` check in
   the handler.

**Audit log:** Admin routes use an `onResponse` hook to log
`{ admin: true, staffId, staffRole, method, url, statusCode }` — good
operational visibility, *but no business-level audit beyond Fastify pino logs*
(no NATS event for admin mutations; the audit-record pipeline is intent-only).

### Auth-related mutations (adjudication gaps)

| Mutation | Reachable from | Adjudicated? | Notes |
|---|---|---|---|
| Customer creation (`upsertFromPhone`) | `POST /api/auth/verify-otp` | **No** | Pure Prisma upsert; no NATS, no audit record |
| Customer creation (WhatsApp auto-auth) | `POST /api/webhooks/whatsapp` | **No** | Driven by `upsertFromWhatsApp`; rate-limited 100/min globally |
| Customer profile name update | `POST /api/auth/verify-otp` body.name | **No** | Same upsert call; no validation beyond `z.string().max(100)` |
| Customer anonymization (LGPD) | `DELETE /api/me/data` | **No** | Deletes addresses, prefs, delinks order items — only requires `requireAuth` |
| Customer data export (LGPD) | `GET /api/me/data` | **No** | Returns customer + addresses + preferences + reviews + orderHistory |
| Staff role change | *not exposed in any route* | n/a | Roles are only mutated via direct Prisma (no API) |
| JWT revocation | `POST /api/auth/logout` | **No** | Best-effort Redis set; no event |
| Login (issuing JWT) | `POST /api/auth/verify-otp` | **No** | After Twilio approval, JWT is issued unconditionally |

> **Adjudication gap.** None of the auth-related mutations cross the kernel
> today. If adjudicate is meant to be the deterministic authority on every
> sensitive mutation, account creation/deletion/role-changes should produce
> `IntentEnvelope`s with `principal: "user"` and audit records. They currently
> do not.

---

## LLM-reachable privileged operations

The LLM never sees mutating tools in the Anthropic tool list — they're filtered
out by `resolveTools()` in `/packages/llm-provider/src/capability-planner.ts`.
When the model tries to call a mutating tool anyway (because it's in the
`MUTATING` set in `/packages/llm-provider/src/machine/types.ts`), the
intent-bridge in `executeTool()` captures it as a `ToolIntent`, runs it through
`adjudicate()`, and only dispatches if the decision is `EXECUTE` (or `REWRITE`).

| Operation | Adjudicated? | Confirmation required? | Customer-scoped? | PII exposure? |
|---|---|---|---|---|
| `add_to_cart` | Shadow-able via `IBX_KERNEL_*`; legacy=always-EXECUTE | No | Yes (cart.customer_id check via `assertCartOwnership`) | No |
| `update_cart` / `remove_from_cart` | Same as above | No | Yes (cart ownership) | No |
| `apply_coupon` | Same as above | No | Yes (cart-scoped) | No |
| `create_checkout` | Same as above; in `NON_RETRYABLE_TOOLS` | No | Yes | High (sends `name/email/CPF` to Stripe) |
| `cancel_order` | Same as above | **No** — LLM can trigger cancel; uses PONR check inside tool | Yes (`svc.cancelOrder(orderId, customerId)` validates ownership) | Returns no PII |
| `amend_order` | Same as above | **No** | Yes | No |
| `regenerate_pix` | Same as above | **No** | Yes (`ctx.customerId` required); 3/h + 5/order rate-limited | Returns new PIX QR/copia-e-cola (not PII per se, but financial instrument) |
| `set_pix_details` | Same as above | No — fields validated, then event emitted to machine | Yes (no `customerId` required — works for guests too) | **High** — name/email/CPF cross adjudicate's audit payload verbatim |
| `submit_review` | Same as above | No | Yes (`ctx.customerId`) | No |
| `update_preferences` | Same as above | No | Yes | Stores allergens (safety-critical) and dietary restrictions in DB + Redis profile |
| `handoff_to_human` | Same as above | **No** | Session-scoped | Sends `reason` (user-controlled string) to staff via WhatsApp |
| `schedule_follow_up` | Same as above | No | Yes | No |
| `create_reservation` / `modify_reservation` / `cancel_reservation` | Same as above | No | Yes (`createReservation` wrapped by `withCustomerId`) | Reservation has customer name |
| `join_waitlist` | Same as above | No | Yes | No |
| `reorder` | Same as above | No | Yes | No |

**Cross-customer leak risk:** Tool handlers consistently call
`withCustomerId()` to *force* the `ctx.customerId` over any LLM-supplied value
(`/packages/llm-provider/src/tool-registry.ts` lines 192–203 — "Always
override customerId from ctx; never trust LLM input"). Combined with
`assertCartOwnership` for cart-scoped tools, the LLM cannot directly target
another customer's data. **However:**

- The LLM CAN echo back PII the tool returned: `get_customer_profile` returns
  the customer's order history, `lastOrderedProductIds`, preferences, etc. The
  system prompt does not forbid echoing this. The post-hoc
  `sanitizeToolResultForLLM` masks CPF/email **before re-feeding to the next
  turn**, so the model gets a masked view, but if a tool returns PII in its
  first response the model still sees it once.
- The LLM CAN send arbitrary messages to itself across turns and can be
  prompted into producing PII for any customer it's currently serving.

**Refunds:** Customer-side LLM tools do NOT include `refund`. Refunds are
admin-only via `POST /api/admin/orders/:id/payment/refund`
(MANAGER+ role required). Good.

**Allergen guardrails:** The hard rule "allergens are always explicit `[]`,
never inferred" is enforced at two layers:
1. Schema-level: `UpdatePreferencesInputSchema` requires
   `allergenExclusions: string[]`.
2. Search-level: `passesAllergenFilter` in
   `/packages/tools/src/search/search-products.ts` strictly compares the
   exclusion list to product `allergens` field. The `allergens` field on each
   product is `string[]` and never null.
3. System prompt: "Alérgenos: informe APENAS o que a ferramenta retornar.
   Nunca presuma alérgenos pelo nome ou descrição do prato." (CLAUDE.md
   rule 1).

The LLM cannot weaken allergen filters: `excludeAllergens` is passed through
the search tool; the model doesn't gate that filter, the user's
`customerPrefs.allergenExclusions` does (loaded from DB).

---

## Secrets and PII handling

### Storage

- All secrets read from `process.env`. Validation in
  `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/config.ts` via Zod.
- Critical: `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID`, `JWT_SECRET`, `DATABASE_URL`,
  `REDIS_URL`, `NATS_URL`, `ADMIN_API_KEY`, `SESSION_HMAC_SECRET`.
- The repository's `.env` file (gitignored per CLAUDE.md rule #6) contains
  real-looking test/dev secrets. The file *also* sets
  `NEXT_PUBLIC_ADMIN_API_KEY=Zrjsx1p5g3UagKXGFrvk5GXU7fOueX/TpxeMNOV7kJw=`
  — that env-var name pattern (`NEXT_PUBLIC_`) makes the value visible to the
  browser. The string is not currently referenced in any TS file under
  `apps/admin/src` or `apps/web/src` (I grepped), so it's *unused*, but the
  pattern is a footgun waiting for a future PR to introduce the leak.
- `SESSION_HMAC_SECRET` has a hardcoded fallback `"dev-session-secret-change-me"`
  if unset (`signed-claims.ts` line 7). Production must set this; missing it
  silently downgrades signed session-claim security.

### Audit redaction

**None.** Every `adjudicate()` call produces an `AuditRecord` (built by
`buildAuditRecord` in `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/audit.ts`)
that contains:

```
{
  envelope: IntentEnvelope,    // includes payload — raw tool input
  decision: Decision,
  decision_basis: [...],
  ...
}
```

This record is then `JSON.stringify`ed and published via:
1. `createConsoleSink({ prefix: "[ibx-audit]" })` — to `stdout`.
2. `createNatsSink(...)` — publishes to NATS subject
   `audit.intent.decision.v1` (prefixed by `publishNatsEvent` to
   `ibatexas.audit.intent.decision.v1`).

For `set_pix_details`, the payload is
`{ toolName: "set_pix_details", input: { name, email, cpf }, toolUseId }`.
So every PIX-details submission emits a NATS event containing
**plaintext full name, email, and CPF**.

For `update_preferences`, payload includes the customer's allergen list.
For `create_reservation`, payload includes party size + date.
For `cancel_order`, payload is `{ orderId }` — no PII directly, but `orderId`
is correlatable.

**No redaction layer exists** between the LLM's tool input and the audit
record. The framework code in `@adjudicate/core/audit.ts` does not redact;
the IbateXas adapter
`/packages/llm-provider/src/intent-audit-wiring.ts` does not redact; the
NATS sink does not redact.

### Logging redaction

- `apps/api/src/utils/sanitize-analytics.ts` redacts CPF/email/phone for
  PostHog analytics — but only applied in `apps/api/src/routes/analytics.ts`
  (the public `/api/analytics/track` endpoint).
- `apps/api/src/utils/sanitize-analytics.ts` is NOT used anywhere in the
  audit, agent, or webhook pipelines.
- `llm-responder.ts` has `sanitizeToolResultForLLM(result)` (line 178) — masks
  CPF and email *in the result JSON string before passing back to the model*.
  This is a model-context protection, not a logging protection.
- Twilio inbound payloads (incoming WhatsApp messages) are logged at INFO with
  `phone_hash` (good), but `Body` content is not logged. OTP send/verify logs
  use `phone_hash`. The bot's INFO logs for agent runs include `phone_hash`
  but the LLM input/output is not logged at INFO — *unless* the structured
  audit pipeline kicks in, which then publishes the raw payload to NATS.

---

## Webhook signature verification

| Webhook | Verified? | How | Bypass path? |
|---|---|---|---|
| `POST /api/webhooks/stripe` | **Yes** | `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` with built-in 300s tolerance | None visible — handler refuses if `STRIPE_WEBHOOK_SECRET` unset (returns 500), if signature header missing (400), or if verification fails (400) |
| `POST /api/webhooks/whatsapp` | **Yes** | `twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, TWILIO_WEBHOOK_URL, body)` | Signature mismatch returns 403; missing config returns 500 |
| `POST /api/auth/send-otp` (Twilio Verify API CALL out) | n/a | Sending side — server initiates | n/a |
| Inbound OTP verify (no webhook — synchronous Twilio API call from server) | n/a | Server polls Twilio | n/a |
| WhatsApp Business webhook verification challenge (e.g. Meta GET request) | Not implemented in apps/api — Twilio handles the upstream Meta integration | n/a | n/a |
| NATS event ingress | **No verification** | NATS auth is connection-level (NATS_URL credentials), not per-message signed | A compromised NATS publisher can inject `audit.intent.decision.v1` events; not a customer-reachable path but a lateral-movement risk |

**Replay protection:**
- Stripe: `rk('webhook:processed:{event.id}')` set with 7-day TTL via
  `SET ... NX`. Duplicate events return 200 immediately. On processing error,
  TTL is reduced to 5 min to let Stripe retry. Good.
- Twilio WhatsApp: `rk('wa:webhook:{MessageSid}')` set with 24h TTL via
  `SET ... NX`. Duplicate messages drop silently. Good.

**Edge case:** the Stripe webhook handler logs the *unverified* IP address on
failure but does not actively rate-limit unverified webhook attempts (the
global Fastify rate limit applies — 30/min/IP in production). A motivated
attacker can probe the signature endpoint without blowing past the global
rate cap.

---

## Idempotency & replay protection

- **Stripe webhooks:** event-ID-keyed Redis NX lock for 7 days. Cancellation
  of webhook processing rolls back to 5-min TTL so retries succeed.
- **WhatsApp inbound:** `MessageSid`-keyed NX lock for 24 hours.
- **OTP:** Twilio Verify enforces single-use codes on its side. No additional
  client-side dedup.
- **Mutating tools via LLM:** the *Execution Ledger*
  (`@adjudicate/audit/ledger-redis.ts`, gated by `IBX_LEDGER_ENABLED` /
  `IBX_LEDGER_ENFORCE`) checks `rk(intentHash)` before dispatch. Behaviour:
  - **Off** (no env-var): ledger skipped entirely (`getIntentLedger` returns null).
  - **Shadow** (`IBX_LEDGER_ENABLED=true`): records executions but doesn't
    block duplicates.
  - **Enforce** (`IBX_LEDGER_ENFORCE=true`): blocks duplicate intents
    (intent_hash match) with a tool result `status: "already_processed"`.
  - **Fail-open** vs **fail-closed**: `IBX_LEDGER_FAIL_OPEN` controls behaviour
    when Redis is unavailable. If `false` (default), the responder surfaces
    `LedgerUnavailableError`; if `true`, dedup is silently skipped.
- **REST customer-driven mutations** (`POST /api/orders/:id/cancel`, etc.) have
  per-customer rate limits (5 cancels/10 min) but **no idempotency keys**.
  A double-submit POST would create two events, two `paymentCmdSvc.transitionStatus`
  calls (which has its own optimistic locking via `expectedVersion`, but no
  natural request-level dedup).
- **`paymentCmdSvc.reconcileFromWebhook`** acquires a Redis lock
  (`payment:{id}`) for 30s per webhook handler call.

**Replay attack surface:**
- **Replayed Stripe webhook:** blocked by event-ID dedup.
- **Replayed envelope (LLM intent):** blocked **only** if ledger is enabled +
  enforced; otherwise duplicates may execute. Until the rollout flips
  `IBX_LEDGER_ENFORCE=true` for each intent kind, the LLM can be re-prompted
  on a stalled session and a tool intent can be re-issued, executing twice.
- **Replayed REST mutation:** unprotected at the route level. Optimistic
  locking on `Payment.version` and order-status transitions mitigates many
  cases, but `regenerate_pix` is rate-limited (3/h) and `cancel_order`
  customer endpoint is rate-limited (5/10min). Charge duplication via Stripe
  is mitigated by `paymentCmdSvc.reconcileFromWebhook`'s status check.

---

## Rate limiting

| Surface | Limit | Window | Key | File |
|---|---|---|---|---|
| Global REST | 30/min (prod) | 1 min | IP | `apps/api/src/plugins/rate-limit.ts` |
| OTP send (customer + staff) | 3 | 10 min | phone-hash | `auth.ts:checkSendRateLimit` |
| OTP IP-level | 10 | 1 h | IP | `auth.ts:checkIpRateLimit` |
| OTP brute-force | 5 fails | 1 h | phone-hash | `auth.ts:checkBruteForce` |
| WhatsApp inbound | 20 | 1 min | phone-hash | `whatsapp-webhook.ts:checkWebhookRateLimit` |
| Customer creation (auto-auth) | 100 | 1 min | global | `whatsapp/session.ts:resolveWhatsAppSession` |
| `regenerate_pix` per-customer | 3 | 1 h | customerId | `regenerate-pix.ts` |
| `regenerate_pix` per-order | 5 | total | orderId | `regenerate-pix.ts` |
| Customer cancel via REST | 5 | 10 min | customerId | `order-actions.ts:/cancel` |
| Analytics `track` | 100 | 1 min | IP | `analytics.ts` |
| LLM token budget | 100K tokens | 24 h | sessionId | `llm-responder.ts:SESSION_TOKEN_BUDGET` |
| LLM tool calls per turn | 5 | per turn | — | `llm-responder.ts:MAX_TOOLS_PER_TURN` |
| LLM turns | 5 | per agent run | — | `MAX_TURNS` |
| LLM tool retries | 3 | per tool call | — | `MAX_TOOL_RETRIES` |
| LLM total retries per conversation | 10 | — | conversation | `MAX_CONVERSATION_RETRIES` |

**Defense against prompt-injection-driven tool floods:**
- `MAX_TOOLS_PER_TURN=5` cap in `processToolCalls` — extras are dropped with a
  warning.
- `state-gate` in `llm-responder.ts:processToolCalls` rejects tool calls not in
  the planner's allowed set (returns a synthetic error in `tool_result`).
- Per-session token budget logs `[budget-bypass]` and aborts when exceeded
  (see budget-bypass test).
- LLM `MAX_TURNS=5` prevents infinite tool→tool→tool loops.

**Defense against per-tool spam:**
- `NON_RETRYABLE_TOOLS` set short-circuits retries for side-effect tools
  (`add_to_cart`, `create_checkout`, `cancel_order`, `amend_order`,
  `remove_from_cart`, `apply_coupon`, `submit_review`, `create_reservation`,
  `cancel_reservation`, `modify_reservation`, `handoff_to_human`).
- `handoff_to_human` has **no per-customer rate limit** beyond the WhatsApp
  inbound 20/min. A malicious customer can flood staff with handoff WhatsApp
  messages 20×/min × 60 min = 1200/hour. The handoff subscriber has a
  `isNewEvent` dedup keyed by `sessionId`, but each new session can trigger a
  fresh notification.

---

## Prompt injection / jailbreak surface

**System prompt claims:**
The SYSTEM_PROMPT in `/packages/llm-provider/src/system-prompt.ts` instructs
the LLM:
- "Você NÃO executa ações — o sistema processa tudo automaticamente."
- "NUNCA invente preços, disponibilidade ou informações sobre alérgenos."
- "Alérgenos: informe APENAS o que a ferramenta retornar. Nunca presuma."
- "NUNCA diga 'confirmado', 'registrado' ou 'finalizado' antes do sistema processar."
- "NUNCA peça nome, CPF, telefone ou qualquer dado pessoal para 'identificar' o cliente."

These are **soft promises**. The hard guarantees come from:
1. The capability planner (`resolveTools` in `capability-planner.ts`)
   limiting visible tools per state.
2. The intent bridge converting MUTATING tool calls into intents.
3. The `validation-layer.ts` two-phase commit that buffers text in states
   with active tools, then scans it for forbidden phrases (`pedido
   cancelado`, `pedido confirmado`, etc.) before streaming. A match triggers
   REWRITE (sanitize) or REFUSE (replace with safe text).
4. The kernel `adjudicate()` call when an intent kind is in the enforce list.

**Tool description leakage:**
- Tool descriptions are pt-BR and operational. None reveal admin-only or
  escalation paths. `submit_review` says
  "Envia a avaliação do cliente para um produto após a entrega" — the
  "após a entrega" hint isn't load-bearing (the actual constraint is the
  Prisma `submitReview` service).
- `handoff_to_human` is benign: "Transfere o atendimento para um atendente
  humano via WhatsApp". Doesn't reveal the staff phone number or that the
  message includes the user-supplied `reason`.
- `update_preferences` description **does** reveal the allergen vocabulary:
  "gluten, lactose, castanhas, amendoim, ovos, peixes, frutos_do_mar, soja".
  Helpful for the model; not a security issue.

**User-controlled strings reaching privileged tool arguments:**
- `handoff_to_human.reason` — user-controlled (router maps `HANDOFF_HUMAN`
  event from message text). Sent via WhatsApp to staff with no
  sanitization. A prompt-injection payload could inject instructions
  visible to staff or — much worse — a phishing message that staff might act
  on. **P1 finding.**
- `submit_review.comment` — user-controlled, written to DB. Length-capped
  via Zod. Free-form text; an XSS payload here could surface in the admin
  reviews UI. Admin UI sanitization not audited here.
- `schedule_follow_up.reason` — user-controlled label; only stored in Redis
  follow-up set, used to template a follow-up nudge later. Risk of injecting
  arbitrary text into a follow-up WhatsApp message.
- `update_preferences.allergenExclusions` — user-controlled (via LLM), but
  the LLM has structured guidance to use the ANVISA vocabulary. No
  whitelist enforcement at the tool layer — invalid allergen strings are
  accepted but won't match product `allergens[]` so are inert. *However*,
  a customer could set `allergenExclusions = []` via prompt injection,
  effectively disabling their own allergen filter — annoying but
  self-targeted, not a cross-customer risk.

---

## Cross-trust crossings (highest-blast-radius scenarios)

| Crossing | How | Today's mitigation | Residual risk |
|---|---|---|---|
| LLM → WhatsApp to staff | `handoff_to_human` + NATS subscriber `handoff-subscriber.ts` | Per-session dedup; STAFF_NOTIFICATION_PHONE optional | Staff phishing via `reason`; unbounded handoffs per customer (rate-limited only by inbound 20/min) |
| LLM → WhatsApp to customer | `sendText` in `whatsapp/client.ts` (driven by agent loop) | Twilio API key gated; message length capped at 4096 | LLM can be coerced to send misleading content (mitigated by validation layer for ordering states) |
| LLM → Stripe charge | `create_checkout` tool | `assertCartOwnership`; amount derived from cart total (not LLM input); `customerId` injected from ctx | LLM cannot specify amount or merchant; can only trigger checkout for its OWN customer's current cart |
| LLM → Stripe refund | Not exposed to LLM | n/a | Refund is admin-only via `requireManagerRole` |
| LLM → external API arbitrary payload | None — Anthropic SDK is the only outbound LLM-driven HTTP | The SDK is gated behind `ANTHROPIC_API_KEY`; no `fetch_url` or generic HTTP tool | None |
| Webhook → Stripe charge | Webhook can only acknowledge/reconcile state, not initiate new charges | Verified signature; PaymentIntent metadata-driven order ID | Forged webhook impossible without `STRIPE_WEBHOOK_SECRET` |
| Webhook → cancel another customer's order | `handlePaymentIntentCanceled` operates on the PI's `metadata.medusaOrderId` | The Stripe-signed event maps to one order; cross-customer requires Stripe-side compromise | Negligible |
| Customer cookie → mass enumeration | `GET /api/orders/:id/...` routes verify ownership via `verifyOwnership` | Returns 404 (not 403) on mismatch (good UX, slows enumeration) | Customer-id is a Prisma string; not enumerable via REST |
| Admin API key → all admin ops | `x-admin-key` header bypasses staff JWT | Timing-safe comparison; ≥32-char enforced in production | If the key leaks (committed to git, .env exposure), full admin compromise — there's no per-action allow list |

---

## Threat model summary

**Attackers in scope:**
1. **Malicious customer.** Has WhatsApp + ability to chat. Goal: exploit
   coupon abuse, cause duplicate charges, jailbreak the agent to leak data,
   harass staff via handoff floods.
2. **Compromised staff JWT.** Lateral-attacker after admin cookie theft.
   Goal: refund themselves, change own role, exfiltrate customer data.
3. **External fraudster (no auth).** Goal: forge webhooks, exhaust OTPs,
   enumerate users.
4. **Insider (e.g. compromised developer).** Goal: covert NATS subscriber
   stealing audit-stream PII.

**Top defenses currently in place:**
- Webhook signature verification (Stripe + Twilio).
- IP + phone-hash rate limits on OTP.
- LLM intent bridge: model cannot directly mutate.
- Cart ownership assertion in all cart tools.
- LLM-supplied `customerId` always overridden by session context.
- Capability planner restricts visible tool set per state.

**Top blind spots:**
- Audit-record PII bleed to NATS (no redaction).
- REST mutations not adjudicated (bypass kernel).
- LGPD anonymize is one-click for an authenticated customer (no soft
  delete, no confirmation, no waiting period — irreversible).
- `SESSION_HMAC_SECRET` default fallback.
- `NEXT_PUBLIC_ADMIN_API_KEY` naming pattern in `.env`.

---

## Top P0/P1 security gaps

### P0

1. **Audit pipeline leaks PII to NATS / console without redaction.**
   `AuditRecord.envelope.payload` contains the LLM's literal tool input.
   `set_pix_details` sends customer's full name + email + CPF as a NATS
   message to subject `ibatexas.audit.intent.decision.v1`. Anyone with NATS
   subscribe permission (subscribers in `apps/api/src/subscribers/*.ts`,
   future auditing services, future analytics consumers) reads CPF in
   cleartext. The console sink in dev does the same to stdout.
   *Fix:* introduce an `AuditRedactor` in `@adjudicate/audit` that masks
   fields per intent-kind schema; wire it into `intent-audit-wiring.ts`.
   Effort: ~1–2 days for the framework; ~1 day for IbateXas adapter.

2. **LGPD anonymize is unconfirmed + unadjudicated + one-click destructive.**
   `DELETE /api/me/data` immediately wipes addresses + preferences and
   anonymizes the customer record. There is no confirmation flow, no email
   verification, no grace period, no rollback. If a customer's JWT is
   stolen, the attacker can permanently destroy that customer's account
   data with a single request.
   *Fix:* (a) put `/api/me/data` behind a fresh-OTP gate
   (`POST /api/me/data/initiate-deletion` → OTP → `DELETE /api/me/data?token=`),
   (b) produce an `IntentEnvelope<account.delete, ...>` so adjudicate gets
   a chance to refuse or DEFER. Effort: ~2 days.

3. **Kernel adjudication is dormant for most intent kinds.** The
   `IBX_KERNEL_ENFORCE` env-var must be a non-empty allow-list per intent
   kind; otherwise `llm-responder.ts` falls through to legacy "always
   EXECUTE." Until the rollout playbook has been run for every mutating
   intent, the kernel's refusal logic (`order-policy-bundle.ts`) is
   inactive. This is acknowledged in CLAUDE.md as the "4-stage shadow →
   enforce playbook" but no rollout completion tracker exists. *Fix:*
   document current enforce/shadow status per intent in a single dashboard;
   complete the rollout. Effort: 1–2 weeks coordinated rollout.

### P1

4. **`handoff_to_human` can flood staff WhatsApp.** No per-customer rate
   limit; user-controlled `reason` is template-injected into a staff-bound
   WhatsApp message. *Fix:* (a) rate-limit per `customerId` to 1 handoff
   per 10 minutes, (b) sanitize `reason` (strip newlines/markdown injection,
   truncate to 100 chars), (c) consider gating handoff behind kernel
   adjudicate to surface a REQUEST_CONFIRMATION decision. Effort: ~0.5 day.

5. **REST customer mutation routes bypass kernel.**
   `POST /api/orders/:id/cancel`, `POST /api/orders/:id/amend/batch`,
   `PATCH /api/orders/:id/payment/method`, `POST /api/orders/:id/payment/retry`,
   `POST /api/orders/:id/payment/regenerate-pix`, `DELETE /api/me/data`,
   etc. — all reachable by an authenticated cookie and none produce an
   `IntentEnvelope` or an audit record from `@adjudicate/core/audit`. The
   goal of "adjudicate is the deterministic authority on every sensitive
   mutation" is unmet for the REST surface. *Fix:* wrap each REST mutation
   handler in `buildEnvelope + adjudicate` with `principal: "user"`. This
   is a larger refactor (~1–2 weeks).

6. **`SESSION_HMAC_SECRET` fallback to literal `"dev-session-secret-change-me"`.**
   If production deploys forget to set it, an attacker who learns the
   constant can forge web-session tokens. *Fix:* fail-fast at startup if
   unset in production (`config.ts`). Effort: 30 minutes.

7. **`NEXT_PUBLIC_ADMIN_API_KEY` in `.env`.** Not currently referenced
   but the variable's `NEXT_PUBLIC_` prefix makes it browser-readable if
   anyone uses it. *Fix:* rename to `ADMIN_FRONTEND_KEY` (server-only)
   and remove from `.env.example` or document why both copies exist.
   Effort: 30 minutes + audit any `apps/admin` PRs.

8. **JWT `JWT_SECRET` minimum length is 16 chars in config.ts; HS256
   recommends ≥32.** Currently the dev secret is fine, but production
   schema permits weaker secrets. *Fix:* bump `.min(16)` to `.min(32)` in
   `apps/api/src/config.ts`. Effort: 5 minutes + rotation if needed.

9. **`submit_review.comment` written to DB without HTML/markdown
   sanitization.** A prompt-injected XSS payload could surface in the admin
   `/api/admin/reviews` UI. The admin UI was not audited here for output
   encoding. *Fix:* sanitize at write time or DOMPurify at read time.
   Effort: 1 hour.

10. **Phone-hash truncation to 12 hex chars (48-bit collision space).** Fine
    today; will fail-open (shared rate-limit / debounce buckets) as the
    customer count grows. *Fix:* widen to 16+ hex when the customer count
    exceeds ~1M (or proactively). Effort: 30 min + Redis key migration.

### P2 (mentioned for completeness)

- Twilio OTP channel defaults to `sms`, not `whatsapp` (per `.env`),
  meaning OTP delivery cost + UX is higher and CLAUDE.md's claim "Twilio
  Verify WhatsApp OTP" is partially misaligned with the live config.
- The customer auto-creation rate limit (100/min globally) prevents DB
  amplification but does NOT protect against a slow-burn enumeration
  attack — a sustained 99/min for an hour creates ~6K throwaway customer
  rows. Not a security issue per se but a database-hygiene cost.
