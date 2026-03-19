# Phase 4 — Documentation, Low-Severity Fixes & Remediation Report

**Date:** 2026-03-18
**Status:** Complete

---

## Fixes Applied

### DL-F06 [MEDIUM] — Schema vs design doc drift

**Files modified:**
- `docs/design/domain-model.md`
- `docs/design/bounded-contexts.md`

**Changes:**
- Added `Customer.source` and `Customer.firstContactAt` to entity map and Prisma schema section
- Added `Review.productId` field (marked `productIds` as DEPRECATED)
- Added `TimeSlot.reservedCovers` with description as atomic counter
- Updated `Customer` model in Prisma section to include `source`, `firstContactAt`, `reservations` relation
- Updated `Reservation` model to show `Customer` FK relation and `onDelete: Restrict` on TimeSlot
- Updated `Review.customer` relation to show `onDelete: SetNull`
- Updated `CustomerOrderItem` to show nullable `customerId` with `onDelete: SetNull`
- Updated `DeliveryZone.deliveryFee` to `feeInCentavos` (matching actual schema naming)
- Updated `Waitlist` model to show `onDelete: Restrict` on TimeSlot
- Noted `Staff` model as **NOT YET IMPLEMENTED** in bounded-contexts.md
- Updated `TimeSlot.startTime` documentation to show 'HH:MM' format constraint

---

### DL-F07 [MEDIUM] — startTime stored as String not Time type

**File:** `packages/domain/prisma/schema.prisma`
**Fix:** Added `@db.VarChar(5)` annotation to `startTime` field and documented the 'HH:MM' format constraint. This enforces a 5-char maximum at the database level, preventing oversized strings while keeping the String type (Prisma does not support native Postgres TIME type).

---

### DL-F09 [LOW] — No migration history (prisma db push)

**Status:** Documented (process change, not a code change)

**Transition plan:**
1. Current state: schema applied via `prisma db push` (no audit trail, no rollback)
2. Phase 1 already created migration files in `packages/domain/prisma/migrations/` for CHECK constraints and product ID backfill
3. Recommended transition:
   - Run `prisma migrate dev --name baseline` on a fresh dev database to create a baseline migration
   - For existing environments, use `prisma migrate resolve --applied <migration>` to mark existing migrations as applied
   - Switch all `ibx db` commands from `db push` to `prisma migrate deploy`
   - Add migration linting to CI (check for destructive changes)
4. This is a process change that requires team coordination and should be done during a low-traffic window

---

### DL-F12 [LOW] — specialRequests JSON shape inconsistency

**File:** `packages/domain/prisma/schema.prisma`
**Fix:** Added code comment documenting the expected JSON shape for `specialRequests`:
- Expected: `SpecialRequest[]` where each entry has `type` and optional `notes`
- Valid types: `birthday`, `anniversary`, `allergy_warning`, `highchair`, `window_seat`, `accessible`, `other`
- Noted that legacy seed data may contain plain `string[]` and consumers must handle both shapes

---

### EVT-F11 [LOW] — Medusa subscribers have no retry on Typesense failure

**Files modified:**
- `apps/commerce/src/subscribers/_product-indexing.ts` — Added `withTypesenseRetry()` utility (max 2 retries with exponential backoff: 500ms, 1000ms)
- `apps/commerce/src/subscribers/product-deleted.ts` — Wrapped `deleteProductFromIndex` in retry
- `apps/commerce/src/subscribers/product-updated.ts` — Import updated (retry is internal via `fetchAndIndexProduct`)
- `apps/commerce/src/subscribers/price-updated.ts` — Wrapped direct `indexProduct` call in retry
- `apps/commerce/src/subscribers/variant-updated.ts` — Wrapped direct `indexProduct` call in retry

**Note:** These are CJS files (Medusa constraint). The retry logic handles transient Typesense failures that would otherwise cause the search index to become permanently stale until manual re-index.

---

### WA-L09 [LOW] — Debounce boundary behavior documentation

**File:** `apps/api/src/routes/whatsapp-webhook.ts`
**Fix:** Added detailed code comment documenting the 2s debounce edge case: messages arriving at the exact boundary can trigger two runners competing for the agent lock. The post-lock re-check mechanism (WA-H02 fix) ensures no messages are permanently lost.

---

### WA-L07 [LOW] — Phone hash truncation collision risk

**File:** `apps/api/src/whatsapp/session.ts`
**Fix:** Added JSDoc comment documenting that 12-char SHA-256 truncation provides 48-bit collision space (~16.8M phones for 50% collision probability). At current scale (<10k phones) this is acceptable. A collision would affect rate limits and debounce but NOT session data.

---

### WA-L11 [LOW] — State machine has no timeout/reset mechanism

**File:** `apps/api/src/whatsapp/state-machine.ts`
**Fix:** Added file-level documentation explaining that stale state (e.g., user stuck in 'checkout') is handled gracefully: the state machine returns null for unrecognized input, causing fallthrough to the LLM agent which treats it as a new conversation intent. No explicit reset mechanism is needed at current scale.

---

### FE-L2 [LOW] — Chat store last message unbounded

**File:** `apps/web/src/domains/chat/chat.store.ts`
**Fix:** Added `MAX_MESSAGE_LENGTH = 10_000` constant. The `updateLastMessage` function now truncates content if it exceeds this limit, preventing unbounded memory growth from long SSE streams.

---

### SEC-F12 [LOW] — Stripe webhook idempotency key deletion edge case

**File:** `apps/api/src/routes/stripe-webhook.ts`
**Fix:** Added code comment documenting the edge case: deleting the idempotency key on error allows retry but may cause duplicate NATS events if the original partially succeeded. Current mitigation relies on downstream subscriber idempotency. Recommended future improvement: make each handler operation independently idempotent.

---

### .env.example updates

**File:** `.env.example`
**Fix:** Added missing environment variables:
- `AGENT_MAX_TURNS=10`
- `AGENT_MAX_TOOL_RETRIES=3`
- `AGENT_MAX_TOKENS=2048`
- `AGENT_SESSION_TOKEN_BUDGET=100000`
- `NO_SHOW_GRACE_MINUTES=15`

---

## Totals

- **Findings addressed:** 11 (2 Medium, 9 Low)
- **Code changes:** 4 (schema annotation, chat store truncation, subscriber retry logic, .env.example)
- **Documentation changes:** 7 (design docs, code comments, process documentation)
