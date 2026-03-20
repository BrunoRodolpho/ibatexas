# Code Health Check -- Post-Remediation
> Quick validation that audit fixes are solid
> Generated: 2026-03-19

---

## TypeScript Health

All apps and packages extend `tsconfig.base.json` which has `"strict": true` -- global strict mode is confirmed.

| Package/App | tsconfig | Strict | Notes |
|-------------|----------|--------|-------|
| `packages/types` | extends base | Yes | Minimal, clean |
| `packages/tools` | extends base | Yes | Clean |
| `packages/nats-client` | extends base | Yes | Clean |
| `packages/llm-provider` | extends base | Yes | Clean |
| `packages/domain` | extends base | Yes | Clean |
| `packages/cli` | extends base | Yes | Clean |
| `packages/ui` | extends base | Yes | No build script (source-level TS consumed by Next.js) |
| `apps/api` | extends base | Yes | Clean |
| `apps/commerce` | extends base | Yes | Adds `experimentalDecorators` + `emitDecoratorMetadata` (Medusa requirement) |
| `apps/web` | extends base | Yes | Adds `jsx: preserve`, `moduleResolution: bundler` (Next.js) |
| `apps/admin` | extends base | Yes | Same Next.js config as web |

**Status**: All clear -- strict mode enabled globally, no anomalies.

---

## Import Health

### Package exports vs actual files

| Package | Declared exports | Files exist | Status |
|---------|-----------------|-------------|--------|
| `@ibatexas/tools` | `.` -> `dist/index.js`, `./api` -> `dist/api/base-url.js` | Yes (source files verified) | OK |
| `@ibatexas/types` | `.` -> `dist/index.js` | Yes | OK |
| `@ibatexas/nats-client` | `.` -> `dist/index.js` | Yes | OK |
| `@ibatexas/llm-provider` | `.` -> `dist/index.js` | Yes | OK |
| `@ibatexas/domain` | `.` -> `dist/index.js` | Yes | OK |
| `@ibatexas/ui` | `.`, `./atoms`, `./molecules`, `./organisms` -> source TS | Yes (consumed raw by Next.js bundler) | OK |

### Cross-package imports
- All workspace packages use `workspace:*` protocol -- no version mismatches possible.
- No references to deleted or moved files found in import statements.

**Status**: All clear.

---

## Dead Code

Checked `packages/tools/src/` -- the largest tool package with 80+ source files.

### Files in `packages/tools/src/` not exported from `index.ts`:
| File | Reason | Verdict |
|------|--------|---------|
| `intelligence/query-products-by-ids.ts` | Internal helper used by `get-recommendations`, `get-also-added`, `get-ordered-together` | OK -- internal module |
| `cart/_shared.ts` | Internal HTTP helpers used by all cart tools | OK -- internal module |
| `reservation/utils.ts` | Internal date/location helpers used by `create-reservation`, `notifications` | OK -- internal module |
| `intelligence/types.ts` | Partially exported (`PROFILE_TTL_SECONDS`, `RECENTLY_VIEWED_MAX`) | OK |

### Tools registered in index.ts vs source files:
All 26 tool modules (search, catalog x2, cart x9, intelligence x6, reservation x6, embeddings, redis x2, mappers, cache x2, typesense x2, medusa, config, whatsapp sender, api base-url) are accounted for and exported.

**Status**: No dead code found. All source files are either exported or used internally.

---

## Environment Variables

### Vars used in code but MISSING from `.env.example`:

| Var | Used In | Impact | Recommendation |
|-----|---------|--------|----------------|
| `MEDUSA_API_KEY` | `packages/tools/src/medusa/client.ts`, `packages/domain/src/services/order.service.ts`, `apps/api/src/config.ts` (Zod schema) | **Critical** -- required by Zod config validation | Add to `.env.example` |
| `APP_BASE_URL` | `apps/api/src/subscribers/cart-intelligence.ts`, `packages/tools/src/reservation/notifications.ts` | Medium -- defaults to `https://ibatexas.com.br` | Add to `.env.example` |
| `MEDUSA_ADMIN_EMAIL` | `packages/domain/src/seed-orders.ts`, `packages/domain/src/seed-homepage.ts`, `packages/cli/src/lib/medusa.ts` | Low -- seeding/CLI only | Add to `.env.example` |
| `MEDUSA_ADMIN_PASSWORD` | Same as above | Low -- seeding/CLI only | Add to `.env.example` |
| `ANTHROPIC_MODEL` | `packages/llm-provider/src/agent.ts` | Low -- defaults to `claude-sonnet-4-6` | Add to `.env.example` (optional) |
| `REMINDER_CHECK_HOUR` | `apps/api/src/jobs/reservation-reminder.ts` | Low -- defaults to `9` | Add to `.env.example` (optional) |
| `WAITLIST_OFFER_MINUTES` | `packages/domain/src/services/reservation.service.ts` | Low -- defaults to `30` | Add to `.env.example` (optional) |
| `WAITLIST_EXPIRY_HOURS` | `packages/domain/src/services/reservation.service.ts` | Low -- defaults to `24` | Add to `.env.example` (optional) |
| `AGENT_MAX_CONVERSATION_RETRIES` | `packages/llm-provider/src/agent.ts` | Low -- defaults to `10` | Add to `.env.example` (optional) |
| `LOG_LEVEL` | `apps/api/src/server.ts` | Low -- defaults to `info` | Add to `.env.example` (optional) |

### CLI-only vars (not needed in `.env.example`):
- `IBX_DEBUG_HTTP`, `IBX_EVENTS`, `API_URL` -- developer/debug flags, acceptable to omit.

### Key finding:
`MEDUSA_API_KEY` is validated as **required** in `apps/api/src/config.ts` Zod schema but is absent from `.env.example`. The API server will crash on startup without it. This is the only critical gap.

---

## Unclear Item Verification

### SEC-F09: Guest Checkout Without Identity Verification
- **Status**: Still uses `optionalAuth` (not fixed / not addressed)
- **Evidence**: `apps/api/src/routes/cart.ts` line 257: `preHandler: optionalAuth` on `POST /api/cart/checkout`. Guest users can complete checkout including cash/PIX without phone verification. The `createCheckout` function receives `userType: request.userType ?? "guest"` and proceeds.
- **Verdict**: This appears to be **intentional business logic** -- guest web checkout is a common e-commerce pattern. Card payments go through Stripe validation. Cash orders have no payment validation but are fulfilled in-person. Should be formally documented as a conscious decision.

### REDIS-L01: Query Cache Hit Count Read-Modify-Write Race
- **Status**: Still present (consciously deferred)
- **Evidence**: `packages/tools/src/cache/query-cache.ts` line 204: `entry.hitCount++` with GET-modify-SET pattern. This is analytics-only data used for cache stats -- losing a few increments under concurrency has zero business impact.
- **Verdict**: Acceptable at current scale. Formally documenting as deferred.

### REDIS-L02: SCAN Accumulates All Keys in Memory
- **Status**: Still present (consciously deferred)
- **Evidence**: `packages/tools/src/cache/query-cache.ts` lines 230-235 and `packages/tools/src/cache/embedding-cache.ts` line 97-98: Both use `scanIterator` collecting all keys into an array before batch delete. At <200 products, this is well within safe limits.
- **Verdict**: Acceptable at current scale. Monitor post-launch.

### SEC-XF01: No Global Rate Limit on WhatsApp Customer Auto-Creation
- **Status**: FIXED
- **Evidence**: `apps/api/src/whatsapp/session.ts` line 82: `rk("ratelimit:customer:create")` with `INCR` + unconditional `EXPIRE` (line 84) and 100/min cap check (line 85). Tested in `whatsapp-session.test.ts` lines 231-238.
- **Verdict**: Confirmed fixed with proper rate limiting pattern.

### DL-F09: Transition from `prisma db push` to `prisma migrate`
- **Status**: Partially addressed
- **Evidence**: `packages/domain/package.json` has both `db:push` and `db:migrate` / `db:migrate:deploy` scripts. Two migration SQL files exist in `packages/domain/prisma/migrations/`. However, the workflow has not been fully switched -- `db:push` is still available and likely still the primary workflow.
- **Verdict**: Migration infrastructure is in place but the team process change has not been executed. Remains a pre-production blocker.

---

## Spot-Check Results (from Handoff Notes)

| Check | Expected | Found | Status |
|-------|----------|-------|--------|
| `assertCartOwnership()` in `packages/tools/src/cart/assert-cart-ownership.ts` | Exists | Confirmed (line 20) | OK |
| `withCustomerId` uses `ctx.customerId` in `packages/llm-provider/src/tool-registry.ts` | Overrides LLM input | Confirmed -- `ctx.customerId` used at line 144, 147 | OK |
| `SELECT FOR UPDATE` in `reservation.service.ts` create() | Row-level lock | Confirmed -- `$queryRaw` with `FOR UPDATE` at line 252-253 | OK |
| Deep health check pinging Redis, Postgres, NATS, Typesense | All 4 checked | Confirmed in `apps/api/src/routes/health.ts` | OK |
| `isRunning` guard in all 4 job files | Overlap prevention | Confirmed in `no-show-checker.ts`, `review-prompt-poller.ts`, `abandoned-cart-checker.ts`, `outbox-retry.ts` | OK |
| Agent lock keyed by `phoneHash` | Not sessionId | Confirmed -- `acquireAgentLock(phoneHash)` at line 143 | OK |
| Redis client promise-based mutex | Not TOCTOU | Confirmed -- `connectingPromise` pattern at line 10 | OK |
| `onDelete: Restrict` on TimeSlot relations | No Cascade | Confirmed -- Reservation->TimeSlot and WaitlistEntry->TimeSlot both use `Restrict` | OK |
| Dockerfiles exist | 3 files | Confirmed: `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/admin/Dockerfile` | OK |
| Zod config schema validates critical vars | 4 vars | Confirmed: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `NATS_URL` in `apps/api/src/config.ts` | OK |
| `drain()` in nats-client | Not `close()` | Confirmed at line 190 | OK |
| `EXPIRE` unconditional in auth.ts | Not inside `if (count === 1)` | Confirmed -- EXPIRE is unconditional on every INCR | OK |
| `unsafe-eval` conditional on NODE_ENV | Dev-only | Confirmed in both `apps/web/next.config.mjs` and `apps/admin/next.config.mjs` | OK |
| AUDIT-FIX tag count | 40+ | 119 in apps/ + 88 in packages/ = 207 total | OK |
| AUDIT-REVIEW tag count | ~8 | Found 8 (5 TODO placeholders + 1 intentional note + 2 in NATS/agent) | OK |
| `onDelete: Cascade` on TimeSlot | Should NOT appear | Confirmed -- TimeSlot relations use `Restrict`, not `Cascade` | OK |

---

## Script Consistency

| App/Package | dev | build | test | lint | Status |
|-------------|-----|-------|------|------|--------|
| `apps/api` | `tsx watch src/index.ts` | `tsc` | `vitest run` | `tsc --noEmit && eslint` | Complete |
| `apps/web` | `next dev -p 3000` | `next build` | `vitest run` | `next lint` | Complete |
| `apps/admin` | `next dev -p 3002` | `next build` | **MISSING** | `next lint` | Missing test script |
| `apps/commerce` | `medusa develop` | `tsc --noEmit` | `vitest run` | `tsc --noEmit` | Complete |
| `packages/tools` | -- | `tsc --outDir dist` | `vitest run` | `tsc --noEmit && eslint` | Complete |
| `packages/types` | -- | `tsc --outDir dist` | **MISSING** | `tsc --noEmit` | No tests (types-only pkg, acceptable) |
| `packages/nats-client` | -- | `tsc --outDir dist` | `vitest run` | `tsc --noEmit` | Complete |
| `packages/llm-provider` | -- | `tsc --outDir dist` | `vitest run` | `tsc --noEmit && eslint` | Complete |
| `packages/domain` | -- | `tsc + cp generated` | **MISSING** | `tsc --noEmit` | No test script (has seed scripts instead) |
| `packages/cli` | `tsc --watch` | `tsc --outDir dist` | `vitest run` | `tsc --noEmit && eslint` | Complete |
| `packages/ui` | -- | **MISSING** | **MISSING** | `tsc --noEmit` | Source-consumed by Next.js (no build needed) |
| `packages/eslint-config` | -- | **MISSING** | **MISSING** | **MISSING** | Config-only package (acceptable) |

### Observations:
- `apps/admin` is missing a `test` script -- should add `vitest run` for consistency.
- `packages/ui` has no build or test scripts -- acceptable since it's consumed as raw TypeScript by Next.js.
- `packages/domain` has no test script -- domain service tests live in `packages/tools` which depends on domain.

---

## Handoff Notes

### Critical (address before launch):
1. **`MEDUSA_API_KEY` missing from `.env.example`** -- The API server Zod config requires this var but `.env.example` does not list it. New developers will get a cryptic crash on startup. Add it to the Medusa Secrets section.
2. **`prisma migrate` transition not yet executed (DL-F09)** -- Migration infrastructure is in place but the team has not switched from `db push`. This must happen before production to have migration history and rollback capability.

### Low Priority (backlog):
3. **`apps/admin` missing test script** -- Add `"test": "vitest run"` for CI consistency.
4. **Several optional env vars undocumented** -- `APP_BASE_URL`, `MEDUSA_ADMIN_EMAIL`, `MEDUSA_ADMIN_PASSWORD`, `ANTHROPIC_MODEL`, `LOG_LEVEL`, `REMINDER_CHECK_HOUR`, `WAITLIST_OFFER_MINUTES`, `WAITLIST_EXPIRY_HOURS` are used with defaults but not listed in `.env.example`. Low risk (all have sensible defaults) but documenting them improves developer experience.
5. **SEC-F09 guest checkout decision needs documentation** -- The `optionalAuth` on `POST /api/cart/checkout` is likely intentional but was flagged in the audit as unclear. Add a code comment or design doc entry confirming this is a conscious business decision.
6. **REDIS-L01 and REDIS-L02 need formal deferral tracking** -- Both were informally deferred but should be added to the backlog with monitoring thresholds (e.g., "revisit when cache key count exceeds 5,000").
