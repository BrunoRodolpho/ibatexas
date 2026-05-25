> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover tech-debt audit (2026-05-23). Parallel-surface dragging (D8) was largely closed across Waves 7-9 (kernel chokepoint enforced via wrapper meta + intent-bridge). Pack-scaffolding boilerplate and config sprawl remain open as long-horizon improvement items. For current outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Code Quality & Tech Debt Audit

**Date:** 2026-05-23
**Auditor:** Code Quality & Technical Debt Auditor (Staff-engineer level)
**Scope:** Post-Wave-6 remediation snapshot. ~150+ mutation entrypoints, 416 packages source files, 273 apps source files, 447 commits since base.

---

## Executive summary

After six waves of remediation (W1–W6) and ~100+ commits the IbateXas codebase is functionally hardened but has accumulated three categories of compounding tech debt:

1. **Parallel-surface dragging** (D8 decision): every command service exposes `@deprecated` bare-arg method *next to* a `*FromEnvelope` envelope-typed method. 9 deprecated entry-points across 4 services, **9 known legacy call sites** still in production code (6 in `apps/api/src/routes/order-actions.ts`, 3 in `packages/tools/src/cart/{cancel-order,regenerate-pix}.ts`). Risk: each remaining call site is a kernel-bypass surface in disguise — the chokepoint claim in `CLAUDE.md` rule #9 is contingent on those callers being migrated.
2. **Pack scaffolding boilerplate**: 5 packs (`pack-orders`, `pack-reservations`, `pack-whatsapp`, `pack-customer-onboarding`, `pack-payments`) each ship a 99% identical `package.json` / `tsconfig.json` / `vitest.config.ts` and the same 5-file `src/` shape (`policies.ts`, `refusals.ts`, `capabilities.ts`, `types.ts`, `index.ts`). The `policies.ts` files total 2,683 LOC and structurally repeat the same composition pattern (state guards → taint policy → business guards → bundle assembly).
3. **Configuration sprawl**: **126 unique env vars** referenced across 293 source files. Only ~15 are validated in `apps/api/src/config.ts`. Everything else is read inline with `process.env.X || "default"` patterns scattered across the codebase, with **inconsistent default conventions** (sometimes `|| "5"`, sometimes `?? "5"`, sometimes silent), and zero typing.

Pillars 1 & 3 are kernel-rollout blockers (they make it hard to *prove* the chokepoint exists); pillar 2 is a velocity tax that grows with every new domain Pack.

**Estimated total debt to clear:** ~28 dev-days for the high-leverage items (priority P0+P1 in the ledger below). Full cleanup of all 21 items: ~62 dev-days.

---

## Per-target findings

### 1. The `@deprecated` parallel surfaces from D8

**Surface inventory.** Three command services in `packages/domain/src/services/` carry parallel surfaces:

| Service | `@deprecated` methods | New envelope-typed equivalent |
|---|---|---|
| `order-command.service.ts` | `create`, `transitionStatus`, `reconcileStatus` | `createFromEnvelope`, `transitionStatusFromEnvelope`, `reconcileStatusFromEnvelope` |
| `payment-command.service.ts` | `create`, `transitionStatus`, `reconcileFromWebhook` | `createFromEnvelope`, `transitionStatusFromEnvelope`, `reconcileFromWebhookFromEnvelope` |
| `customer.service.ts` | bare `anonymizeCustomer` (module-level helper) | `anonymizeCustomerFromEnvelope` |

Both `reservation.service.ts` (`reservation.service.ts:11`) and `order-policy-bundle.ts` (the entire file) declare themselves deprecated; `packages/llm-provider/src/order-policy-bundle.ts` is a 69-LOC re-export shim pointing at `@ibatexas/pack-orders`.

**Remaining production call sites** of the bare-arg methods (excludes tests and `__tests__`):

| File | Line | Call |
|---|---|---|
| `apps/api/src/routes/order-actions.ts` | 137 | `orderCmdSvc.create(...)` (lazy-create projection from Medusa) |
| `apps/api/src/routes/order-actions.ts` | 256 | `orderCmdSvc.transitionStatus(...)` (customer cancel — INSIDE a `runCustomerIntent` envelope, but the inner call is still bare-arg) |
| `apps/api/src/routes/order-actions.ts` | 267 | `paymentCmdSvc.transitionStatus(...)` (cancel active payment) |
| `apps/api/src/routes/order-actions.ts` | 1049 | `paymentCmdSvc.transitionStatus(...)` (method-switch — old → switching_method) |
| `apps/api/src/routes/order-actions.ts` | 1057 | `paymentCmdSvc.transitionStatus(...)` (method-switch — switching_method → canceled) |
| `apps/api/src/routes/order-actions.ts` | 1065 | `paymentCmdSvc.create(...)` (method-switch — new payment row) |
| `packages/tools/src/cart/cancel-order.ts` | 41 | `paymentCmdSvc.transitionStatus(...)` (LLM cancel-order tool) |
| `packages/tools/src/cart/regenerate-pix.ts` | 89 | `cmdSvc.transitionStatus(...)` (regenerate-pix tool) |
| `packages/tools/src/cart/regenerate-pix.ts` | 119 | `cmdSvc.create(...)` (regenerate-pix tool) |

**Total: 9 active bypass sites.** Each one is a mutation that runs *without* a kernel adjudication, without an audit record, and without a policy check.

**Removal unblockers:** the W3 P0-2 commit (35e2621) migrated payment/retry + regenerate-pix routes to envelope path. The remaining `regenerate-pix.ts` tool still uses the legacy `cmdSvc.create` path (line 119). The `method-switch` route (`PATCH /api/orders/:id/payment-method`) is the largest single block — 3 of the 9 calls. Migrating it requires a composite intent kind `payment.method.switch` plus a multi-step executor; it's flagged in the comments at `order-actions.ts:738` as Wave 5 work but never landed.

**Risk if not addressed:**
- Each call is a documented kernel bypass. The "zero state-mutation authority" claim in CLAUDE.md #9 is structurally false until they're migrated.
- Future maintainers reading the parallel surface will reasonably reach for the bare-arg form (it's shorter, has no `Adjudicated*` result wrapping). Tribal knowledge — "always use the envelope path" — does not scale.
- The `order-policy-bundle.ts` shim re-exports from `@ibatexas/pack-orders`, but its declared type widening (`PolicyBundle<string, unknown, OrderState>`) erases the Pack's intent-kind specificity. Any caller still using the legacy bundle gets a degraded type experience.

### 2. Configuration sprawl

**Counts.** 126 unique env var names referenced across the codebase, 293 source files contain at least one `process.env.X` access. Across `apps/api/src` alone: 87 occurrences; `apps/web/src`: 28; `packages/llm-provider/src`: ~20; `packages/tools/src`: ~30; `packages/cli/src`: 106.

**Centralization status.** `apps/api/src/config.ts` validates **15 env vars** via Zod schema with fail-fast in non-test environments. The other **111 env vars are not centrally typed or defaulted.** They're each read inline with one of three inconsistent patterns:

| Pattern | Example | Frequency |
|---|---|---|
| `process.env.X \|\| "default"` | `AGENT_MAX_TURNS \|\| "5"` (llm-responder.ts:52) | Most common |
| `process.env.X ?? "default"` | `RESTAURANT_PHONE ?? ""` (agent.ts:132) | Second most |
| `process.env.X === "true"` | `IBX_AUDIT_POSTGRES_ENABLED === "true"` (intent-audit-wiring.ts:107) | Boolean flags |

The `||` vs `??` divergence matters: `||` treats `""` as missing whereas `??` only checks nullish. The codebase mixes both for the same conceptual idiom; bugs hide where an operator intentionally sets `X=""` to mean "off" but `||` falls through to a non-empty default.

**Boolean coercion.** `IBX_AUDIT_POSTGRES_ENABLED`, `IBX_KERNEL_SHADOW`, `IBX_KERNEL_ENFORCE`, `IBX_LEDGER_ENABLED`, `IBX_LEDGER_ENFORCE`, `IBX_LEDGER_FAIL_OPEN`, `STALE_ORDER_DRY_RUN` all use string-comparison patterns (`=== "true"`). No shared parser. A typo (`TRUE`, `1`, `yes`) silently degrades to false.

**Full env-var inventory** (deduplicated, alphabetical):

```
ADMIN_API_KEY                          AGENT_MAX_CONVERSATION_RETRIES
ADMIN_API_KEY_ROLES_JSON               AGENT_MAX_TOOL_RETRIES
ADMIN_CORS                             AGENT_MAX_TURNS
AGENT_SESSION_TOKEN_BUDGET             AGENT_TOKEN_BUDGET_TTL
ANTHROPIC_API_KEY                      ANTHROPIC_MODEL
APP_BASE_URL                           APP_ENV
AUDIT_REDACT_SECRET                    AUTH_CORS
AWS_REGION                             CLAUDE_EMBEDDING_MODEL
COOKIE_SECRET                          CORS_ORIGIN
CUSTOMER_ANONYMIZE_GRACE_HOURS         CUSTOMER_PROFILE_RATE_LIMIT_HOURS
DATABASE_URL                           DEFER_TIMEOUT_IMMINENT_SECONDS
DELIVERY_CACHE_TTL                     EMBEDDINGS_CACHE_TTL_SECONDS
EMBEDDING_DIMENSION                    ENABLE_SWAGGER
GEOCODING_API_URL                      HEALTH_CHECK_TIMEOUT_MS
HESITATION_NUDGE_DELAY_MS              IBX_AUDIT_BUFFER_CAPACITY
IBX_AUDIT_POSTGRES_ENABLED             IBX_DEBUG_HTTP
IBX_EVENTS                             IBX_KERNEL_ENFORCE
IBX_KERNEL_SHADOW                      IBX_LEDGER_ENABLED
IBX_LEDGER_ENFORCE                     IBX_LEDGER_FAIL_OPEN
JWT_SECRET                             LOG_LEVEL
MACHINE_SNAPSHOT_TTL                   MAX_SESSION_AGE_MS
MEDUSA_ADMIN_EMAIL                     MEDUSA_ADMIN_PASSWORD
MEDUSA_BACKEND_URL                     MEDUSA_URL
MEDUSA_WORKER_MODE                     NATS_CREDS_PATH
NATS_NKEY_SEED                         NATS_TLS_CA
NATS_TLS_REQUIRED                      NATS_URL
NEXT_PUBLIC_ADDRESS                    NEXT_PUBLIC_API_URL
NEXT_PUBLIC_MEDUSA_BACKEND_URL         NEXT_PUBLIC_POSTHOG_HOST
NEXT_PUBLIC_POSTHOG_KEY                NEXT_PUBLIC_SENTRY_DSN
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY     NEXT_PUBLIC_URL
NEXT_RUNTIME                           NODE_ENV
NO_SHOW_GRACE_MINUTES                  OPENAI_API_KEY
OPENAI_BASE_URL                        PIX_EXPIRED_DELAY_MS
PIX_EXPIRY_SECONDS                     PIX_FALLBACK_EMAIL
PIX_FALLBACK_TAX_ID                    PIX_REMINDER_DELAY_MS
PONR_DAY_OVERRIDES                     PONR_DEFAULT_AMEND_MINUTES
PONR_DEFAULT_CANCEL_MINUTES            PORT
PROMETHEUS_TOKEN                       QUERY_CACHE_DYNAMIC_TTL_SECONDS
QUERY_CACHE_EXACT_TTL_SECONDS          QUERY_CACHE_TTL_SECONDS
QUERY_LOG_TTL_SECONDS                  RATE_LIMIT_MAX
REDIS_CB_FAILURE_THRESHOLD             REDIS_CB_RESET_TIMEOUT_MS
REDIS_URL                              REPLAY_TTL_SECONDS
RESERVATION_CANCEL_CONFIRM_HOURS       RESERVATION_NO_SHOW_ESCALATE_RATE
RESTAURANT_DINNER_END_HOUR             RESTAURANT_DINNER_START_HOUR
RESTAURANT_LAT                         RESTAURANT_LNG
RESTAURANT_LUNCH_END_HOUR              RESTAURANT_LUNCH_START_HOUR
RESTAURANT_PHONE                       RESTAURANT_SITE_URL
RESTAURANT_TIMEZONE                    SECRETS_BACKEND
SENTRY_DSN                             SESSION_HMAC_SECRET
SESSION_IDLE_THRESHOLD_MS              STAFF_ALERT_PHONE
STAFF_NOTIFICATION_PHONE               STALE_ORDER_DRY_RUN
STALE_ORDER_THRESHOLD_HOURS            STORE_CORS
STRIPE_SECRET_KEY                      STRIPE_WEBHOOK_SECRET
SESSION_HMAC_SECRET                    TF_VAR_
TRACE_TTL_SECONDS                      TRUST_PROXY
TWILIO_ACCOUNT_SID                     TWILIO_AUTH_TOKEN
TWILIO_OTP_CHANNEL                     TWILIO_VERIFY_SID
TWILIO_WEBHOOK_URL                     TWILIO_WHATSAPP_NUMBER
TYPESENSE_API_KEY                      TYPESENSE_COLLECTION_NAME
TYPESENSE_HOST                         TYPESENSE_PORT
TYPESENSE_PROTOCOL                     TYPESENSE_TIMEOUT_SECONDS
WAITLIST_EXPIRY_HOURS                  WAITLIST_OFFER_MINUTES
WEB_URL                                WHATSAPP_24H_WINDOW_GRACE_SECONDS
WHATSAPP_HANDOFF_LIMIT_MINUTES
```

**Recommended fix:** unify under a single `@ibatexas/config` package exposing a Zod-validated `config` object built at boot. Defaults documented in code, not in 50 inline `|| "5"` strings. Cost: ~3 dev-days for migration; tests pass once each call site is replaced with `config.AGENT_MAX_TURNS`.

### 3. Test scaffolding accumulation

**Counts.** 235 `*.test.ts` files plus 419 files under `__tests__/` dirs (some overlap; net unique ~280). 492 `vi.mock(...)` calls. 2 fixtures directories (`packages/llm-provider/src/__tests__/scenarios/fixtures`, `packages/tools/src/cart/__tests__/fixtures`).

**Shared helpers** — there is **only one** shared test helper file in the entire codebase: `apps/api/src/__tests__/helpers/auth-mock.ts` (factories for `requireAuth` / `optionalAuth` mocks). Everything else is per-file:
- Each route test rebuilds its `vi.mock("@ibatexas/domain", ...)` block (~10 copies).
- Each subscriber test rebuilds the NATS mock setup (~8 copies).
- Each pack test re-implements its own state-builder + envelope-builder pairs.

**Most-repeated pattern.** A test file looks like this (paraphrased):

```ts
vi.mock("@ibatexas/tools", async () => {
  const actual = await vi.importActual<...>("@ibatexas/tools")
  return { ...actual, getRedisClient: vi.fn(...), rk: actual.rk }
})

vi.mock("@ibatexas/domain", () => ({
  prisma: { ... },
  createOrderCommandService: () => ({ createFromEnvelope: vi.fn(...), ... }),
}))
```

That `createOrderCommandService` returning a hand-built mock with each `*FromEnvelope` keyed to a `vi.fn()` is repeated across at least 12 test files. A `createMockOrderCommandService(overrides?: Partial<...>)` factory would eliminate ~150 LOC of duplication.

**Buildable fix:** add `packages/test-utils` with three modules:
- `mock-services.ts` — factories for each command service mock
- `mock-prisma.ts` — common Prisma mock surface
- `fixtures.ts` — typed builders for `IntentEnvelope`, `OrderState`, `OrderProjection`

Cost: ~2 dev-days to extract; each migrated test file drops 30-50 LOC.

### 4. Pack scaffolding duplication

**Files duplicated per Pack** (5 packs × N files):
- `package.json` — 25 LOC each, 99% identical (only `name` and `pack-payments-pix` dep differ)
- `tsconfig.json` — 7 LOC, byte-identical across packs
- `vitest.config.ts` — 10 LOC, byte-identical
- `src/types.ts`, `src/policies.ts`, `src/refusals.ts`, `src/capabilities.ts`, `src/index.ts`, optional `src/signals.ts`

**`policies.ts` totals:**

| Pack | LOC |
|---|---|
| pack-orders | 647 |
| pack-reservations | 524 |
| pack-whatsapp | 480 |
| pack-customer-onboarding | 521 |
| pack-payments | 511 |
| **Total** | **2,683** |

**Structural repetition in `policies.ts`:**
- Every file imports `basis, BASIS_CODES, decision* from "@adjudicate/core"` and `createSystemTaintPolicy / createConfirmGuard / createEscalateGuard / createRewriteGuard from "@adjudicate/primitives"`.
- Every file declares a local `type PackGuard = Guard<IntentKind, Payload, State>` alias.
- Every file ends with the same shape: `export const policyBundle: PolicyBundle<...> = { taint: ..., guards: { state: [...], auth: [...], business: [...] }, defaultRefuse: refuseDefault }`.

**Could a `pack-base` package help?** Modestly. The mechanics are well-factored into `@adjudicate/primitives` already. The actual variation per pack is *which* guards apply to which intent kind — and that's load-bearing per-pack logic, not duplicable.

What WOULD reduce boilerplate: a scaffold tool `ibx pack new <name>` that generates the 5-file template + package.json + configs + a passing conformance test. Estimated savings: 4 hours per new pack.

**Recommendation:** keep `@adjudicate/primitives` as the shared substrate (it already exists and is doing this job correctly); add `ibx pack new` to `packages/cli`. Skip `pack-base`.

### 5. Audit pipeline complexity

**File:** `packages/llm-provider/src/intent-audit-wiring.ts` (328 LOC).

**Composition order** (from the file's top-of-file comment, lines 30-39):

```
sink (exported)
  └─ redactor.redact(record)              // Task 18 — PII gate
      └─ persistentBufferedSink           // Task 19 — durability
          └─ multiSink(
              consoleSink,
              natsSink,
              [postgresSink if IBX_AUDIT_POSTGRES_ENABLED]
            )
```

This IS documented (well — clearer than 90% of comparable wiring code). It's also implicit: the composition is built inside `loadSink()` from line 251, and the relationship between each layer is enforced by the function call order, not by a type.

**Branches and gates:**

1. `IBX_AUDIT_POSTGRES_ENABLED === "true"` — toggles the Postgres sink (line 107).
2. `IBX_AUDIT_BUFFER_CAPACITY` — overrides buffer capacity (line 94).
3. `AUDIT_REDACT_SECRET` — empty in dev, required in prod, warns on boot (line 140).
4. `_depsOverride.redis` — null forces in-memory spill fallback (line 153).
5. `_depsOverride.prismaWriter` — test injection for Postgres sink (line 223).
6. `_depsOverride.logger` — test injection for pino logger (line 256).
7. `lazyRedisClient()` — proxy to defer the `getRedisClient()` await (line 170).
8. Inner-try swallow in the exported `_sink.emit` — fail-open at the IbateXas boundary (line 295).

That's 8 conditional surfaces. Plus a singleton-with-test-reset pattern (`_resetAuditSink`).

**Could it be a single typed pipeline class?**

Yes, but at moderate cost. A `class AuditSinkPipeline` with a builder API would:
- Make the composition order a compile-time property (`.withRedactor().withBuffer().withSinks(...)`).
- Eliminate the lazy-singleton dance — instantiate once at boot, pass via DI.
- Replace the 8 conditional surfaces with a typed config record.

Trade-off: the current functional decomposition is 100% testable today (each loader is testable in isolation) and adopts mainstream Node idioms. The class form would be cleaner; it would also be a rewrite, and the redactor/buffer ordering invariant (the load-bearing one) is already enforced and tested by `audit-redaction-contract.test.ts`.

**Recommendation:** leave as-is. Document the composition order in a markdown architecture diagram instead. Score: medium debt, low leverage (the file is already well-structured for what it does).

### 6. The Wave 1-6 commits themselves

Reviewed the 60-commit ridge from W1 (commit `cc7f3fc`) to W6 (`3005d82`). Findings:

- **Concerns are well-separated.** Each W*P*-letter task ID maps cleanly to a single commit (e.g. `P0-4`, `P0-5`, `P1-F` each got their own commit). No mixed-concern commits.
- **No reverts.** No `revert ...` commits in the W1-6 range.
- **One mild shim**: `da5ed15` "Wave 2 merge" and `b1294f3` "W6-4 + W6-5" both merge two tasks at once. The W6-4/W6-5 split is arguably one logical change (pack-failure boot test + Lua atomicity races) but the second is independently a bug-fix on top of the first. Not problematic.
- **Comment density grew over time.** Later commits (W6+) carry extensive in-code comments referencing the audit findings and design choices. Useful for context; could be moved to ADRs to reduce file size in some places (e.g. `intent-audit-wiring.ts` has ~90 LOC of header comments).

**Recommendation:** the commit history is a clean reading. No refactor here. The header-comment density issue is benign — these comments are load-bearing for maintenance, not noise.

### 7. Naming inconsistencies

**`*FromEnvelope` vs `*WithEnvelope` vs `*Envelope`** — VERIFIED CONSISTENT. Every new envelope-typed method uses `FromEnvelope` suffix (`createFromEnvelope`, `transitionStatusFromEnvelope`, `reconcileFromWebhookFromEnvelope`, `addNoteFromEnvelope`, `switchTypeFromEnvelope`, `changeAddressFromEnvelope`, `anonymizeCustomerFromEnvelope`). Zero hits for `*WithEnvelope`. The `*Envelope` suffix is reserved for types (`IntentEnvelope<K, P>`). Clean.

**Intent kind `.system` suffix** — USED. `order.cancel.system` is referenced 8 times (pack-orders/policies.ts, types.ts, index.ts, intent-kinds.ts). Distinguished from `order.cancel` (the customer-driven kind). Consistent.

**Audit field naming** — CONSISTENT. `intentHash` is the unique-per-envelope hash (computed at build-time, never recomputed); `auditHash` is the per-audit-record hash (recomputed after redaction per P0-15 / W2). The fields are named the same way everywhere and the redactor's comment (`audit-redactor.ts:20-72`) explicitly documents the distinction. Clean.

**Verdict on naming:** the codebase is unusually consistent for its size. No findings.

### 8. Cyclomatic complexity hotspots

Top 5 production functions ranked by approximate cyclomatic complexity (branch count, depth, side-effect count):

| Rank | Function | File:line | Approx. complexity | Score (1-10) |
|---|---|---|---|---|
| 1 | `processToolCalls` | `packages/llm-provider/src/llm-responder.ts:221` (455 LOC) | ~45 branches, 4-level nesting, 8 distinct side-effects (tool exec, ledger, kernel, audit, dispatcher, park, refuse, fall-through), 5 try/catch | **10** |
| 2 | route handler `POST /api/orders/:id/payment-method` | `apps/api/src/routes/order-actions.ts:1020-1095` | 7 status guards, 3 inner Prisma mutations, withLock wrapper, 4 error returns | **9** |
| 3 | `startCartIntelligenceSubscribers` | `apps/api/src/subscribers/cart-intelligence.ts:118` (1185 LOC inner) | 7 NATS subscriber handlers, each with tier logic, cooldowns, redact paths; ~118 branches in the whole file | **9** |
| 4 | `executeKernel` | `packages/llm-provider/src/kernel-executor.ts:396` | 4 mutation call sites each wrapped in `adjudicateKernelMutation`, XState orchestration, machine-context handoff | **8** |
| 5 | `startDeferResolverSubscriber` | `apps/api/src/subscribers/defer-resolver.ts:647` (760 LOC file) | Sweeper + resume side + Redis IOError path + tamper detection + DLQ — 6 distinct paths | **8** |

**Lower-priority but flagged:**
- `infra.ts` CLI command (2143 LOC, score 8): not on the production path, but the size is a maintenance concern.
- `llm-responder.ts:692` (generate streaming response): score 7.
- `routes/admin/payments.ts:49` (1144 LOC file, multiple route handlers): individually each is fine; the file size is the smell.

**Refactor proposals:**
- `processToolCalls` (score 10): extract the per-decision-kind branches (`EXECUTE`, `DEFER`, `REFUSE/ESCALATE/CONFIRM`) into a discriminated-union handler map. Each branch becomes a ~30-LOC pure function returning a `ToolResultBlockParam`. Reduces top-level cyclomatic by ~30 points.
- `payment-method route`: split into a `withPaymentLock` higher-order handler + `executePaymentMethodSwitch` business operation, then call the operation from a thin route handler.
- `cart-intelligence subscribers`: each of the 7 subscribers should be its own module. The file currently bundles them for IIFE-style boot-time wiring; the same effect is achievable with explicit registration calls from a smaller orchestrator.

### 9. Dead code

**Verified removed and not re-introduced:**
- `executeToolDirect` (M1 Task 06 / commit `0501a61` / `fcc3eaf`): only references are 4 documentation comments in `tool-registry.ts`, `intent-dispatcher.ts`, `capability-planner.ts`, `kernel-executor.ts`. The function does not exist.
- `slot.released` signal (W2 P1-F / commit `844cfe5`): the signal is referenced 17 times in pack-reservations source/tests, all of them deliberately ("formerly DEFER on slot.released", "[W2/P1-F] removed"). No publisher exists. Clean.

**Still present:**
- 6 `// TODO` comments across the source tree (excluding `__tests__` and `.next/`):
  - `nats-client/src/index.ts:5` — "Full JetStream migration needed for production reliability" (open since pre-W1)
  - `tools/src/intelligence/submit-review.ts:43` — analytics pipeline placeholder
  - `tools/src/cart/{reorder.ts:72, add-to-cart.ts:78}` — cart analytics subscribers
  - `cli/src/commands/kernel.ts:298` — "TODO(audit-replay): re-feed records through adjudicate()"
  - `cli/src/commands/infra.ts:1758` — "derive from terraform outputs"
- 2 `@ts-expect-error` annotations in production code (`cli/src/commands/kernel.ts:273, 447`) — both with explanatory comments. Not blocking.
- 0 `if (false)` patterns and 0 unconditionally unreachable branches found by grep.

**Note:** the legacy `orderPolicyBundle` in `packages/llm-provider/src/order-policy-bundle.ts` is a 69-LOC deprecated shim. It's NOT dead — still imported by `kernel-executor.ts`, `llm-responder.ts`, `index.ts`, and one test file. It IS scheduled for removal "once every importer is updated".

### 10. Logging consistency

**Counts.**
- `console.{log,warn,error}` in `packages/`: **1192 calls** across **101 files**.
- After excluding `cli/` (where console output IS the UX): ~250 calls across ~30 files.
- After also excluding `domain/seed-*.ts` (which are run as scripts and legitimately use console): ~210 calls.
- After also excluding `llm-provider/` (which has a console-passthrough fallback when no pino logger is injected): ~150 calls.

**Migration status (W6-10 P2-C).** The commit `afc7a8a` migrated 11 call sites in `llm-provider/src/llm-responder.ts` and `intent-audit-wiring.ts` to a pino-shaped logger via dependency injection (`resolveLogger(opts.logger)`). The `apps/api/src/lib/logger.ts` exports a pino instance. The migration is real but incomplete.

**Files still using console:**
- `packages/nats-client/src/index.ts` — 1 TODO + several console calls
- `packages/tools/src/{redis,medusa,typesense}/client.ts` — console at boot-time errors
- `packages/tools/src/cart/{add-to-cart,update-cart,apply-coupon,...}.ts` — console.warn / console.error in 7+ tool files
- `packages/tools/src/embeddings/client.ts` — console at cache warmup
- `packages/tools/src/intelligence/submit-review.ts` — console.error on NATS publish

**Logging format winners.** Pino-style (`log.warn({ key: value }, "message")`) IS the chosen winner — adopted in apps/api (`lib/logger.ts`), in llm-provider's IbxLogger contract, and in the audit-wiring path. The remaining `console.*` calls are leftovers from earlier waves, not a competing style.

**Estimated cost** to migrate the remaining ~150 calls: ~3 dev-days. Each tool file needs a logger parameter threaded through its public API; the LLM dispatcher / tool-registry already plumb context, so the pattern is established.

### 11. Error type taxonomy

**17 custom Error classes** across non-test code:

| Class | File | Used in? |
|---|---|---|
| `CircuitOpenError` | `packages/tools/src/redis/circuit-breaker.ts:96` | redis circuit-breaker only |
| `MedusaAdjudicateRefusedError` | `packages/tools/src/medusa/adjudicated.ts:322` | medusa wrapper |
| `MedusaAdjudicateDeferredError` | `packages/tools/src/medusa/adjudicated.ts:342` | medusa wrapper |
| `MedusaAdjudicateNeedsReviewError` | `packages/tools/src/medusa/adjudicated.ts:362` | medusa wrapper |
| `MedusaRequestError` | `packages/tools/src/medusa/client.ts:28` | medusa client |
| `NonRetryableError` | `packages/types/src/agent.types.ts:9` | LLM responder |
| `PaymentConcurrencyError` | `packages/domain/src/services/payment-command.service.ts:45` | payment command |
| `PaymentNotFoundError` | `packages/domain/src/services/payment-command.service.ts:54` | payment command |
| `InvalidPaymentTransitionError` | `packages/domain/src/services/payment-command.service.ts:61` | payment command |
| `ActivePaymentExistsError` | `packages/domain/src/services/payment-command.service.ts:72` | payment command |
| `ConcurrencyError` | `packages/domain/src/services/order-command.service.ts:69` | order command |
| `ProjectionNotFoundError` | `packages/domain/src/services/order-command.service.ts:78` | order command |
| `InvalidTransitionError` | `packages/domain/src/services/order-command.service.ts:85` | order command |
| `MissingEventVersionError` | `packages/domain/src/services/order-command.service.ts:96` | order command |
| `CommandRefusedError` | `packages/domain/src/services/__shared__/with-adjudicate.ts:197` | adjudicate helper |
| `LedgerUnavailableError` | `packages/llm-provider/src/intent-ledger.ts:32` | execution ledger |
| `RedisUnavailableError` | `apps/api/src/middleware/auth.ts:26` | auth middleware (private) |

Plus `PackConformanceError` (imported from `@adjudicate/core`, used in `apps/api/src/plugins/kernel-bootstrap.ts`).

**Consistency.**
- Naming: PascalCase + Error suffix — consistent.
- Construction: all set `this.name` explicitly — consistent.
- Catching: 35 `instanceof X` checks across 279 `catch (err)` blocks. **Most catches use string-of-error log + rethrow / fail-open, NOT instanceof discrimination.** This is the consistency gap.

**Swallowed errors.** 2 deliberately-documented swallows (`search-products.ts:416` and `amend-order.ts:135` — both have comments explaining why). The 102 `throw new Error(...)` calls in production code are mostly framework/system boundaries (invariant violations, parsing failures) where a typed Error wouldn't add value. Reasonable.

**Recommendation:** establish a documented error-handling policy. Most code should `instanceof` discriminate at the boundary, not rethrow as `new Error(originalMessage)`. The current "log message + fail-open" pattern works but loses stack traces. Cost: ongoing; flag in code review.

### 12. The `pnpm-workspace.yaml` cross-repo dependency

**Current state.** `pnpm-workspace.yaml` lines 7-10:

```yaml
- "../adjudicate/packages/*"
- "../adjudicate/examples/*"
```

This is a sibling-directory workspace cross-mount. The platform repo's source-of-truth is `BrunoRodolpho/adjudicate`. CLAUDE.md rule #9 documents this explicitly. The Docker/CI clone is configured (commit `4402990`).

**Why it's fragile.**
- Anyone cloning ibatexas without also cloning the sibling repo gets a `workspace:* not found` resolution error at `pnpm install`.
- Worktree commands like `git worktree add` are awkward — the sibling path must exist relative to the new worktree, or paths break (the D1 worktree issue referenced in the audit).
- Branch divergence: ibatexas develops on `main`, adjudicate develops on `main`. A breaking change in adjudicate's `@adjudicate/core` won't be caught until the next ibatexas install. No version pinning beyond `workspace:*`.

**Migration path.** The CLAUDE.md rule #9 documents the plan: "Replace with npm registry deps once the platform publishes". Concrete steps:

1. Publish `@adjudicate/core`, `@adjudicate/audit`, `@adjudicate/audit-postgres`, `@adjudicate/primitives`, `@adjudicate/conformance`, `@adjudicate/locales-pt-br`, `@adjudicate/runtime`, `@adjudicate/pack-payments-pix` to a registry (npm public or private Verdaccio).
2. Replace `workspace:*` deps with semver ranges (`"@adjudicate/core": "^1.0.0"`).
3. Remove the `../adjudicate/packages/*` line from `pnpm-workspace.yaml`.
4. Update CI/Docker to drop the sibling-clone step.

**Cost.** ~2 dev-days for the publication setup + dep-bump. Ongoing: a release-coordination story per breaking change (release notes, semver discipline). Net: positive.

**Risk if not addressed.** Higher onboarding friction for new contributors. Higher CI flake rate (a sibling-repo update can break ibatexas CI without anyone in either repo realizing). Audit verifiability degraded — "which version of `@adjudicate/core` was running in prod last Tuesday?" requires a `git log` in two repos.

---

## Tech debt ledger

| # | Item | Type | Cost (dev-days) | Risk if not fixed | Priority |
|---|---|---|---|---|---|
| 1 | Migrate 9 remaining bare-arg `paymentCmdSvc.{create,transitionStatus}` and `orderCmdSvc.create` call sites to envelope path | Kernel chokepoint | 4 | LLM-authority claim structurally false; each call is a bypass | **P0** |
| 2 | Centralize 111 ad-hoc env-var reads into a single typed `@ibatexas/config` module with Zod validation | Config | 3 | Typos silently degrade to defaults; can't audit "what's enabled in prod" | **P0** |
| 3 | Remove `packages/llm-provider/src/order-policy-bundle.ts` (legacy shim) | Dead code | 0.5 | Type widening obscures intent-kind specificity; new code may import the wrong bundle | **P0** |
| 4 | Refactor `processToolCalls` (455 LOC, complexity 10) into discriminated-union handler map | Complexity | 2 | Bugs hide in 5-level nesting; tests cover happy paths but branch coverage gaps | **P0** |
| 5 | Publish `@adjudicate/*` packages to a registry; drop sibling-repo workspace mount | Cross-repo coupling | 2 | Worktree breakage; CI flake; no version pin | **P1** |
| 6 | Migrate ~150 remaining `console.{log,warn,error}` calls in non-CLI packages to pino logger | Logging | 3 | Lost reqId correlation; structured search broken | **P1** |
| 7 | Extract `packages/test-utils` with mock service factories, mock prisma, envelope/state fixtures | Test scaffolding | 2 | ~150 LOC duplication per route test file; mock drift across tests | **P1** |
| 8 | Split `apps/api/src/subscribers/cart-intelligence.ts` (1304 LOC, 7 subscribers) into per-subscriber files | Complexity | 1.5 | One bug touches all 7 handlers; file load-test failures | **P1** |
| 9 | Refactor `PATCH /api/orders/:id/payment-method` route into `payment.method.switch` composite intent kind + executor | Kernel chokepoint | 3 | 3 of the 9 bypass calls live here; flagged as "Wave 5 work" but never landed | **P1** |
| 10 | Migrate `packages/tools/src/cart/{cancel-order,regenerate-pix}.ts` to `*FromEnvelope` (3 call sites) | Kernel chokepoint | 1.5 | LLM-tool path still has bypasses | **P1** |
| 11 | Document audit pipeline composition order as an ADR + diagram (vs. only in code comments) | Documentation | 0.5 | Future maintainers may reorder layers; redactor-before-buffer invariant could break | **P2** |
| 12 | Add `ibx pack new <name>` scaffolding command | Tooling | 1 | Pack creation cost stays high; future domain packs replicate boilerplate | **P2** |
| 13 | Adopt consistent boolean env var coercion (`parseBoolEnv()` helper) for the 7 IBX_* flags | Config | 0.5 | Typos like `TRUE`/`yes` silently disable enforce; rollout safety degraded | **P2** |
| 14 | Migrate `||` → `??` for env defaults (or vice versa, pick one) | Config | 0.5 | Empty-string defaults behave inconsistently | **P2** |
| 15 | Document `instanceof Error` discrimination policy in `docs/code-style.md` | Process | 0.5 | 67 catch blocks rethrow as new Error, losing stack traces | **P2** |
| 16 | Resolve 6 `// TODO` comments (or convert to issue tickets) | Hygiene | 0.5 | Stale TODOs accumulate; no expiration date | **P2** |
| 17 | Move header comments in `intent-audit-wiring.ts` (90 LOC) to architecture doc | Documentation | 0.5 | File feels intimidating; comment-to-code ratio is unusual | **P3** |
| 18 | Split `apps/api/src/routes/order-actions.ts` (1183 LOC) into 3 files | Complexity | 1.5 | One file, 11 routes; harder to review | **P3** |
| 19 | Add a `BulkActiveCallSiteAuditor` test that grep-fails on bare-arg `*CmdSvc.create(...)` outside known carve-outs | Process | 0.5 | New bare-arg calls re-introduced; current parallel surface is silent foot-gun | **P3** |
| 20 | Pin `@adjudicate/core` workspace dep to a version constant via tooling (transition aid) | Cross-repo | 1 | Branch drift; need to remember to bump in two repos | **P3** |
| 21 | Add line-length / cyclomatic-complexity linter (eslint-plugin-complexity, `max-lines-per-function`) with a baseline allowlist | Tooling | 1 | New hotspots grow without signal | **P3** |

**Totals by priority:**
- P0: 4 items, 9.5 dev-days
- P1: 5 items, 11 dev-days
- P2: 6 items, 4 dev-days
- P3: 5 items, 4.5 dev-days
- **Grand total: 21 items, ~28 dev-days for P0+P1, ~32 dev-days for all P2 / P3.**

Net cleanup cost: **~62 dev-days** (8 weeks for one engineer).

---

## Complexity hotspots

| Function | File:line | Complexity score | Refactor proposal |
|---|---|---|---|
| `processToolCalls` | `packages/llm-provider/src/llm-responder.ts:221` | 10/10 | Extract decision-kind branches (EXECUTE/REWRITE/DEFER/REFUSE/CONFIRM/ESCALATE) into a discriminated-union handler map. Each branch becomes ~30 LOC; top-level cyclomatic drops by ~30. |
| `PATCH /api/orders/:id/payment-method` handler | `apps/api/src/routes/order-actions.ts:1020-1095` | 9/10 | Replace 3 inner `paymentCmdSvc` calls with a single composite `payment.method.switch` envelope. Decompose into `withPaymentLock` + `executePaymentMethodSwitch`. |
| `startCartIntelligenceSubscribers` (and 7 inner handlers) | `apps/api/src/subscribers/cart-intelligence.ts:118` | 9/10 | Split into 7 per-subscriber files (`cart-abandoned.subscriber.ts`, `payment-confirmed.subscriber.ts`, ...). Keep `startCartIntelligenceSubscribers` as a thin orchestrator. |
| `executeKernel` | `packages/llm-provider/src/kernel-executor.ts:396` | 8/10 | The 4 mutation call sites each call `adjudicateKernelMutation`. Extract a shared `wrapMutation(kind, payloadFactory, executor)` helper to flatten the structure. |
| `startDeferResolverSubscriber` (+ sweeper / resume / tamper paths) | `apps/api/src/subscribers/defer-resolver.ts:647` | 8/10 | Split into `defer-resume.ts` (signal-triggered resumption) + `defer-sweeper.ts` (TTL-driven cleanup) + `defer-tamper.ts` (envelope-hash verification). Three smaller files with a shared types module. |

**Lower-priority but worth flagging:**
- `infra.ts` CLI command (2143 LOC) — score 8 but NOT on production hot path.
- `routes/admin/payments.ts` (1144 LOC) — multiple route handlers; individually each scores 5-6.

---

## Dead code inventory

**Confirmed removed (verified by grep):**
- `executeToolDirect` — removed in M1 Task 06. Only 4 documentation references survive.
- `slot.released` — removed in W2 P1-F. 17 deliberate references (all "formerly DEFER on slot.released" or "[W2/P1-F] removed").
- `add_order_note` orphan in MUTATING classification — removed in F5 (commit `aeefad0`).

**Verified absent:**
- `if (false)` branches: 0 occurrences in source.
- `@ts-ignore` in production: 0 (only `.next/types/validator.ts` — generated).
- `@ts-expect-error` in production: 2 in `cli/src/commands/kernel.ts` (both with explanatory comments).

**Soft dead code (deprecated but live):**
- `packages/llm-provider/src/order-policy-bundle.ts` — 69-LOC re-export shim. Importers: `kernel-executor.ts`, `llm-responder.ts`, `index.ts`, 1 test. Removal blocked on updating those imports to `@ibatexas/pack-orders`.
- The 9 bare-arg `paymentCmdSvc.{create,transitionStatus}` and `orderCmdSvc.create` call sites mentioned in Target 1. These are LIVE but `@deprecated` — removing the methods is blocked on migrating callers.
- The 6 active `// TODO` markers (see Target 9).

**Conclusion.** Dead code hygiene is good. The "deprecated but live" set is the migration tail, not abandonment.

---

## Recommended quarterly cleanup roadmap

### Q1 (this quarter) — P0 items, ~10 dev-days

1. **Week 1:** Migrate the 9 remaining bare-arg call sites (item #1, #9, #10 from ledger). Outcome: kernel chokepoint truly closed; `CLAUDE.md` rule #9 becomes verifiable.
2. **Week 2:** Centralize env-var configuration in `@ibatexas/config` (item #2). Outcome: typed config object, fail-fast at boot, 111 inline reads collapse to 0.
3. **Week 2 (parallel):** Remove `order-policy-bundle.ts` shim (item #3). Outcome: no more soft-deprecated dual-import.
4. **Week 3:** Refactor `processToolCalls` (item #4). Outcome: complexity 10 → ~5; branch coverage easier; new decision-kind producers (e.g. `REQUEST_CONFIRMATION` flow) become a 30-LOC addition instead of touching the megafunction.

### Q2 — P1 items, ~11 dev-days

5. **Week 4-5:** Publish `@adjudicate/*` to private registry; drop workspace mount (item #5).
6. **Week 5-6:** Logger migration (item #6) + test-utils extraction (item #7) — these unblock the velocity tax on every route test.
7. **Week 7:** Split cart-intelligence subscribers (item #8). Outcome: 1304-LOC file becomes 7 ~200-LOC files.

### Q3 — P2 items, ~4 dev-days

Sprint-bag work — slot into normal sprints:
- `ibx pack new` scaffolding (item #12)
- `parseBoolEnv()` helper (item #13)
- `||` → `??` consistency pass (item #14)
- Audit-pipeline ADR (item #11)
- `instanceof Error` discrimination policy doc (item #15)
- TODO triage (item #16)

### Q4 — P3 items, ~4.5 dev-days

Tooling and process:
- Bare-arg call-site auditor test (item #19)
- Cyclomatic-complexity linter with baseline (item #21)
- Split `order-actions.ts` (item #18)
- Workspace dep pin (item #20)
- Move audit-wiring header comments (item #17)

---

## Final remarks

The codebase is in better shape than 100+ commits of remediation would suggest. The W1-W6 effort consistently improved structure rather than papering over it. Naming is uniform. Test coverage is dense (235 test files, 492 mock invocations). Dead code is minimal. The error taxonomy exists.

The two structural weaknesses to fix soon:
1. The parallel-surface drag from D8 — every dev-week these live they accrete more bare-arg callers.
2. The env-var sprawl — every dev-week without central typing is another silent-default rollout risk.

Everything else can be paid down on the normal velocity curve.
