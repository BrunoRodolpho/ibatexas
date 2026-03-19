# Phase 3: WhatsApp & Webhook Quality Fixes

**Date:** 2026-03-18
**Audit report:** `docs/audit/03-whatsapp-webhooks.md`

---

## Summary

Fixed 7 findings (4 Medium, 3 Low) from the WhatsApp & webhooks audit. All changes tagged with `// AUDIT-FIX: {FINDING-ID}`.

---

## Fixes Applied

### MEDIUM

| ID | Finding | Fix | Files |
|----|---------|-----|-------|
| WA-M03 | Early crash in `handleMessageAsync` leaves user with no response | Wrapped entire function body in outer try/catch. Catch sends pt-BR fallback message via `sendText`: "Desculpe, ocorreu um erro. Tente novamente em alguns instantes." | `routes/whatsapp-webhook.ts` |
| WA-M04 | No rate limit on customer auto-creation via `upsertFromWhatsApp` | Added global Redis rate limit: max 100 new customers/minute using `rk('ratelimit:customer:create')` with INCR + unconditional EXPIRE pattern (REDIS-M03). Throws on exceed, caught by M03 outer catch. | `whatsapp/session.ts` |
| WA-M05 | Stripe content type parser intercepts ALL JSON routes | Scoped raw body parser to webhook route only via `server.register()` encapsulated plugin. Other routes now use Fastify's built-in optimized JSON parser. | `routes/stripe-webhook.ts` |
| WA-M06 | WhatsApp content type parser intercepts all form-urlencoded routes | Same approach as M05 -- scoped parser to webhook route via `server.register()` encapsulated plugin. Simplified to single branch (no URL check needed). | `routes/whatsapp-webhook.ts` |

### LOW

| ID | Finding | Fix | Files |
|----|---------|-----|-------|
| WA-L08 | Duplicate `phoneHash` / `hashPhone` function definitions | Removed duplicate `phoneHash` from `client.ts`. Now imports `hashPhone` from `session.ts` and re-exports as `phoneHash` for backward compatibility. Single source of truth. | `whatsapp/client.ts` |
| WA-L10 | No Twilio 429 / Retry-After header handling | Added 429 status check in retry loop. Parses `Retry-After` header (seconds) and uses it as delay. Falls back to 5s if header missing or invalid. Non-429 errors keep exponential backoff. | `whatsapp/client.ts` |
| WA-L12 | `collectAgentResponse` has no timeout | Added 60-second timeout using `AbortController` + `setTimeout` guard. If LLM provider hangs, throws pt-BR error "Tempo limite atingido ao aguardar resposta do agente". Timer cleaned up in `finally`. Timeout is configurable via optional parameter for testing. | `whatsapp/formatter.ts` |

---

## Files Modified

- `apps/api/src/routes/whatsapp-webhook.ts` (M03 outer try/catch, M06 scoped parser)
- `apps/api/src/routes/stripe-webhook.ts` (M05 scoped parser)
- `apps/api/src/whatsapp/session.ts` (M04 rate limit)
- `apps/api/src/whatsapp/client.ts` (L08 dedup, L10 429 handling)
- `apps/api/src/whatsapp/formatter.ts` (L12 timeout)
- `apps/api/src/__tests__/whatsapp-session.test.ts` (M04 test + mock updates)

---

## Not Fixed (out of scope)

- **H-01** (Agent lock / debounce key mismatch): Already fixed in phase 2 (REDIS-H03/WA-H01)
- **H-02** (Silent message loss when agent lock is held): Already fixed in phase 2 (WA-H02 re-check)
- **L-07** (Phone hash truncation 12 chars): Acceptable at current scale; no collision risk for single-location restaurant
- **L-09** (Debounce window drops legitimate rapid follow-up): Architectural tradeoff; debounce is working as designed
- **L-11** (State machine has no timeout/reset): Minor UX issue; LLM agent handles fallback correctly

---

## Test Results

```
Test Files  110 passed (110)
Tests       1514 passed (1514)
Duration    18.33s
```

All tests pass. 2 new tests added for WA-M04 (rate limit exceeded + unconditional EXPIRE pattern).
