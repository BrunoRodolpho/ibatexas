> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover test-coverage gap analysis (2026-05-23). Cross-layer composition gaps drove Wave-6 integration suite (LGPD lifecycle, fault-injection in critical path, concurrency over atomic primitives) and the conformance suites (T1, T3, T5, T6, T7, T2). For current test coverage and outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Test Coverage Gap Audit

**Audit date:** 2026-05-23
**Scope:** ~221 test files across `apps/api`, `apps/web`, `apps/commerce`, `packages/*`
**Method:** Static inspection of test descriptors + cross-reference to source files & migration tasks. No coverage instrumentation run.

---

## Executive summary

The overnight run produced **strong unit-level coverage** of each *isolated layer* of the new kernel-gated stack (Pack policies, route adjudication, subscriber dispatch, audit redaction, bypass-detection grep gate). However, **the audit identifies a sharp asymmetry**: every layer in isolation is well tested, but **the load-bearing cross-layer compositions — where the migration's real value lives — are almost entirely uncovered**.

Three structural gaps dominate:

1. **No true E2E "time-slice" tests.** The LGPD anonymize, multi-pack supersedes chains, and Stripe-webhook → command-service → DB → NATS paths are each *sliced* into unit tests but never composed end-to-end with real wire events crossing the seams. T0 + T+1h cancel + T+24h fire is verified only as three independent unit tests against the policy; no test runs the cancel-receipt-then-anonymize *sequence* through both the route handler AND the grace resolver in one run.
2. **No fault-injection tests in the kernel critical path.** The kernel design contract says the decision must *complete* even if the audit sink, NATS publish, or Redis park fails. Today we test that each *sink* survives its own failure mode in isolation. We do **not** test that `adjudicate() → sink fails → decision still returns EXECUTE` end-to-end through a real route.
3. **Zero concurrency tests against the Lua/atomic critical sections.** Task 13's atomic GET+DEL Lua script for admin two-step confirms has 0 tests with concurrent confirmation. Same for `customer.anonymize` re-entrancy, parked-DEFER collision, and audit Postgres ON CONFLICT. We're shipping atomic primitives without a single test exercising the race they protect against.

**Bypass-detection verdict: NEEDS EXTENSION.** The current 4-scenario grep gate covers ~60% of the bypass classes the CLAUDE.md hard-rules list. Critical missing: rule #10 (Redis lock release without UUID ownership check), `executeRawUnsafe` outside command services, direct Twilio WhatsApp `messages.create` outside the WhatsApp Pack, and `console.log` of envelope payloads (PII leak via stdout). See §"Bypass-detection extension opportunities" for the full list of foot-guns the gate doesn't catch.

**P0 close-out estimate:** ~10-14 engineering days for a single engineer to write the top 20 missing tests below. The highest-ROI investment is the **LGPD lifecycle integration test** (single test composing route → DEFER park → defer-timeout-sweeper → grace-resolver subscriber → anonymizeCustomer) at ~1-2 days that closes 4 P0 gaps simultaneously.

---

## High-stakes path coverage matrix

| Flow | Unit (policy) | Unit (handler) | Integration | E2E | Verdict |
|---|---|---|---|---|---|
| **LGPD anonymize T0 → DEFER park** | YES (`lgpd-anonymize.test.ts` line 90) | YES (`me-routes.test.ts` line 298) | NO | NO | **GAP: route → subscriber chain untested** |
| **LGPD anonymize T+1h cancel supersedes** | YES (`lgpd-anonymize.test.ts` line 146) | YES (`me-routes.test.ts` line 392) | NO | NO | **GAP: no integration test verifying cancel actually clears the parked DEFER + receipt in one flow** |
| **LGPD anonymize T+24h fire (grace expired)** | YES (`lgpd-anonymize.test.ts` line 251 — policy only) | YES (`anonymize-grace-resolver.test.ts` line 106) | NO | NO | **GAP: no test composes sweeper → resolver → anonymizeCustomer end-to-end** |
| **Stripe webhook event → adjudicate → command service → DB → NATS** | N/A | YES (`stripe-webhook-route.test.ts` line 859, "kernel-gated reconciliation") | NO | NO | **GAP: command service is mocked; no test verifies a real `payment.update` row write end-to-end** |
| **Multi-pack: order.cancel → payment.refund supersedes chain** | NO | NO | NO | NO | **CRITICAL GAP: no test exercises a cancel that triggers a refund through the chain** |
| **DEFER park → wire event arrives → resume** | N/A | YES (`defer-roundtrip.test.ts` + `defer-resolver.test.ts`) | YES (`defer-roundtrip.test.ts` line 168) | NO | OK (good coverage in unit + integration) |
| **Concurrent admin two-step confirm (Lua atomic)** | YES (`force-routes-governance.test.ts` line 869, single sequential consume) | YES | NO | NO | **GAP: no concurrent two-step test — atomic claim is unverified** |
| **Audit sink fails mid-decision; decision still completes** | YES (Redis spill, `intent-audit-wiring-postgres.test.ts` line 234) | NO | NO | NO | **GAP: no test exercises a full `adjudicate() + emit fails + downstream route returns 200`** |
| **Stripe deterministic replay (same event_id → same hash)** | YES (`stripe-webhook-route.test.ts` line 1142) | YES | NO | NO | OK |
| **PIX charge DEFER (lighthouse pack composition)** | YES (`kernel-contract.test.ts` line 404) | YES (`defer-roundtrip*.test.ts`) | NO | NO | OK (pack-level + dispatcher-level coverage) |
| **All 32 KNOWN_INTENT_KINDS adjudicated** | PARTIAL (`kernel-contract.test.ts` has happy/sad path per kind but no exhaustive matrix) | N/A | N/A | N/A | **GAP: 32 kinds × 7 decision kinds = 224 cells; we have ~60 covered. ~73% uncovered cells.** |

---

## Failure-mode test gaps

| Failure mode | Tested? | Where it would be tested | Risk if unverified |
|---|---|---|---|
| Postgres audit-write throws mid-decision | PARTIAL — `intent-audit-wiring-postgres.test.ts` line 234 covers SPILL behavior. NO test verifies the underlying adjudicate() decision *completes and returns EXECUTE* to the caller while the sink is failing. | An integration test against any route that adjudicates + the postgres writer throws | Decision might be silently dropped, causing duplicate executes on retry |
| Redis outage during DEFER park | NOT TESTED end-to-end. The `defer-resolver` Redis-stub is happy-path. No test exercises `getRedisClient` rejecting. | `defer-resolver.test.ts` extension OR a new `defer-park-resilience.test.ts` | Customer DELETE /api/me/data returns 500; no fallback graceful response |
| NATS publish failure for resume signal | PARTIAL — `defer-timeout-sweeper.test.ts` line 261 covers "publishNatsEvent throws → leaves parked key in place". But NO test covers the case where the *resume signal* (e.g. `payment.confirmed`) is published-and-lost. | A NATS roundtrip integration test in `apps/api/src/__tests__/defer-roundtrip*` | Anonymize might never fire even after 24h+1ms — the timeout event is lost |
| NATS publish failure for `intent.defer.timeout` itself | COVERED for sweeper retry contract; NOT covered for cascade (sweeper publishes, subscriber crashes, sweeper already deleted parked key → orphaned receipt) | New test: `defer-timeout-sweeper.test.ts` "deletes parked key BEFORE publish ack" | LGPD deletion never completes; receipt stays in Redis forever |
| `installPack` failure at boot | **NOT TESTED.** No test file targets `kernel-bootstrap.ts` directly. Task 01 says it should exit non-zero, but `bootstrapKernel(server)` and `installFirstPartyPacks()` have no unit test that asserts PackConformanceError propagation. | New file: `apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts` | Pack drift goes undetected at boot in non-CI environments |
| `validateEnforceConfig` typo emits warn but doesn't exit | NOT TESTED in IbateXas (assumed tested upstream in `@adjudicate/core`) | Smoke test in `kernel-bootstrap.test.ts` | Operator typo silently disables shadow for an intent kind |
| Sentry init failure during sink wiring | NOT TESTED | `kernel-metrics-sink.test.ts` | Audit telemetry silently dropped |
| Twilio Verify API returns network error during anonymize OTP | PARTIAL — `me-routes.test.ts` line 239 covers `502 on Twilio error`. Does NOT cover the case where Twilio succeeds but returns `status: "approved"` for a *replayed* OTP code (no token expiry check on Twilio side) | `me-routes.test.ts` extension | OTP replay attack vector |
| Ledger Redis EVAL rejected (script not cached) | NOT TESTED | `admin-confirmation-store` unit test | Confirmation flow returns 500 in a NOSCRIPT error case |
| `executeKernel` throws unexpectedly (Pack runtime error) | NOT TESTED | New file: `kernel-runtime-resilience.test.ts` | A bug in any Pack's `policy()` function crashes the route handler |

---

## Concurrency test gaps

**None of these scenarios have any test today.**

| Scenario | Risk |
|---|---|
| Two concurrent admin confirms (same `confirmationId`) — only one should win via Lua | High: a race window that the Lua script claims to close is *unverified*. A regression that swaps Lua for plain GET+DEL would not be caught. |
| Two concurrent `customer.anonymize` attempts for the same `customerId` — should be idempotent | High: re-park collision behavior is implementation-defined by Redis SET NX; we have no test pinning it |
| Two concurrent `customer.anonymize.cancel` attempts | Medium: idempotency check is in the receipt, no test exercises the race |
| Two concurrent envelope builds with the same content + nonce | Critical: intent hash must be identical (replay-safe), but we have *no test that explicitly constructs the race and verifies hash equality* — only sequential determinism tests. The audit emission contract test (`audit-emission-contract.test.ts` line 137) tests identical sequential calls; not concurrent. |
| Two concurrent DEFER parks for the same sessionId — collision behavior | Medium: receipt overwrite vs idempotent-rejection is undefined and untested |
| Audit consumer NATS redelivery during Postgres write — duplicate insert avoided by isNewEvent | YES, sequential test exists (`audit-consumer.test.ts` line 235). NO concurrent variant. |
| Sweeper sweep + concurrent customer cancel-deletion arriving — who wins? | High: a customer cancels 1ms before the 24h sweep — no test exercises this. The receipt could already be cleared by `cancel-deletion` while the sweeper publishes `intent.defer.timeout`; the grace resolver should see `no_pending_receipt` (it would skip). Tested as the unit `skipped on no_pending_receipt` case — but NOT as a real concurrent sequence. |

---

## Replay test gaps

| Capability | Status |
|---|---|
| `audit-emission-contract.test.ts` line 137 — same envelope inputs produce same intentHash | YES |
| Stripe webhook same event_id → same intentHash | YES (`stripe-webhook-route.test.ts` line 1142) |
| `system-actor-envelope.test.ts` line 22 — same eventId same hash | YES |
| **Feed historical audit record back through kernel → same decision** | **NO** — `ibx kernel replay` is a stub today (`kernel.test.ts` line 143). The CLI tests assert the stub returns a TODO message. There is **no test that takes an actual AuditRecord and verifies adjudicate(envelope, state, policy) reproduces the same Decision kind**. |
| `classifyReplayDrift` function — does it exist? | **The grep finds zero references** to `classifyReplayDrift` in this codebase or the adjudicate sibling repo accessible from this workspace. Either (a) the task spec named a function that was never implemented, or (b) it lives behind a different name. Either way: **no test exists for replay drift classification**. |
| Replay drift class breakdown (kind change, basis change, payload rewrite delta) | NOT TESTED |
| Audit row → Pack state reconstruction → re-adjudicate | NOT TESTED. The state-snapshot field in `AuditRecord` would need to be loaded from an audit row, but there's no test exercising that flow. |

---

## Bypass-detection extension opportunities

**Current state:** 4 scenarios (`bypass-detection.test.ts` + `no-direct-prisma-bypass.test.ts`):
1. Direct Prisma writes to kernel-owned tables outside `*FromEnvelope`
2. Direct `medusaStore`/`medusaAdmin` writes outside `medusaAdjudicated()`
3. `executeToolDirect` re-introduction
4. `setMetricsSink(undefined|null)` reset in production

**Critical bypasses NOT detected by the gate:**

| Bypass class | Why it matters | Detection difficulty |
|---|---|---|
| **Redis lock release without UUID ownership check (CLAUDE.md rule #10)** | A regression `redis.del(lockKey)` (instead of the Lua conditional release) silently releases another holder's lock. The CLAUDE.md explicitly calls this out as a hard rule. | Easy: grep for `redis.del.*lock` or `del.*lock` in source — false positives manageable with allow-list |
| **`prisma.$executeRaw` / `$executeRawUnsafe` outside command services** | Currently only `audit-consumer.ts` uses `$executeRawUnsafe`, and the bypass-detection ALLOWS it implicitly. A regression that adds `$executeRawUnsafe` to a route or job would silently bypass type-checking AND envelope flow. | Easy: grep for `executeRaw\|executeRawUnsafe` outside an `ALLOWED_RAW_SQL` set |
| **Direct `twilio.messages.create` / Twilio SDK send bypassing the WhatsApp Pack** | Per task 10, all WhatsApp sends should go through `whatsappPack` adjudication. A direct SDK call would skip pt-BR validation, rate limit, and audit. | Medium: grep for `twilio(...).messages.create` — false-positive risk in tests/setup |
| **`console.log` of envelope payloads (PII leak via stdout)** | Stdout in Docker/k8s logs is non-redacted. A `console.log(envelope)` in a route handler dumps CPF/CVV/email to the log aggregator. | Hard automation, but feasible: grep for `console.log.*envelope` or `console.log.*payload` outside test code |
| **`process.env.SECRET` / hardcoded secrets** | CLAUDE.md rule #3 (`process.env` for config, never hardcode) is unenforced by grep | Medium: regex for `=\s*"sk_\|=\s*"pk_\|=\s*"AC[a-f0-9]` etc. |
| **NATS publish outside `publishNatsEvent` wrapper** | Direct `nc.publish()` would bypass redaction + retry. | Easy: grep for `nc.publish\|jc.publish` outside `nats-client` |
| **Direct cookie / JWT manipulation outside auth middleware** | A handler that reads `request.cookies.session_id` and trusts it would bypass `requireAuth`. | Hard — needs taint flow analysis, not grep |

**Verdict: extend the gate to at least 4 of these (rule #10, executeRaw, Twilio direct, console.log of envelope). Estimated effort: 1 day. Each extension is a 5-15 line addition to `bypass-detection.test.ts`.**

---

## CLI test gaps

| Command | Tested? | Gap |
|---|---|---|
| `ibx kernel status --json` | YES (`kernel.test.ts` line 70) | Schema is asserted but no JSON-schema validation lib — format drift only caught by string-match on key names |
| `ibx kernel status` text mode | YES (line 85) | OK |
| `ibx kernel replay` stub mode | YES (`kernel.test.ts` line 143) — asserts the TODO is emitted | **No test for the eventual real replay path** because that path is a stub. When the real implementation lands, the test must change. **Risk: lands without a test rewrite, silently no-ops in production.** |
| `ibx kernel replay --since` duration parsing | YES (line 153) | OK |
| `ibx kernel replay --intent-kind` filter | YES (line 164) | Filter passthrough only — doesn't verify the *query* against postgres ever runs |
| `ibx kernel divergence` | YES (line 178) | Stub-only, same caveat |
| Other CLI commands (`ibx dlq`, `ibx db`, `ibx svc`) | Variable — most have no unit test | Out of scope for this audit but worth a follow-up |

---

## Edge case gaps

| Scenario | Status | Risk |
|---|---|---|
| **Empty cart checkout** — kernel REFUSEs | TESTED (`kernel-contract.test.ts` line 450, `orders-pack.test.ts` line 119, `conformance.test.ts` line 274) | OK |
| **Anonymize during open order** — what does the kernel decide? | **NOT TESTED.** The `customerOnboardingPolicyBundle` does not check for open orders in the state guard for `customer.anonymize`. The fixture `CustomerOnboardingState` in tests doesn't even include an `openOrders` field. **A customer with an unfulfilled R$10000 order can initiate deletion today.** Unknown if this is by-design or by-omission. | High: LGPD allows deletion request but creates a refund-orphan |
| **DEFER while another DEFER is parked for same sessionId** | NOT TESTED. The route-handler test `me-routes.test.ts` line 339 covers idempotency at the *receipt* layer (returns "Já existe"), but the *underlying parked envelope blob* is implicitly overwritten by SET — no test verifies this is the intended behavior. | Medium: a second anonymize attempt could replace the first's intentHash silently |
| **Anonymize after order.cancel.fail** (order cancel REFUSEd; customer tries delete anyway) | NOT TESTED | Medium |
| **Stripe webhook arrives for a customer that has been anonymized** | NOT TESTED. Could 200 / 404 / 500. | High: PII leak risk if the handler echoes back the customer field |
| **Multi-pack chain: cancel → refund → audit row count** | NOT TESTED end-to-end | High: chained envelopes' supersedes link could break audit-trail genealogy |
| **OTP replay (same token, two `DELETE /api/me/data` calls within 5min)** | NOT TESTED. `consumeOtpMarker` is in the test but no test exercises a deliberate replay. The Twilio Verify side might or might not reject. | High: anonymization replay |

---

## Real coverage vs claimed

The overnight run reports "**~2500 tests passing**." Sample inspection of 5 source files vs their test files:

| Source file | Lines | Test file | Covered branches (eyeball) | Uncovered branches |
|---|---|---|---|---|
| `packages/llm-provider/src/audit-redactor.ts` | ~700 | `audit-redactor.test.ts` (450 lines, 55 cases) | High (~85%) | Edge case: redactor running on already-redacted payload (idempotency tested) but not on a circular-reference payload |
| `packages/llm-provider/src/shadow.ts` (if exists; else `adjudicate-with-shadow`) | adjudicate sibling repo | `shadow-enforce-branching.test.ts` | DECISION_KIND + PAYLOAD_REWRITE + BASIS_ONLY tested. **NONE explicitly tested (negative case).** Only inferred from "no DECISION_KIND events" assertion (line 213). | NONE-class divergence-event-emit suppression not asserted positively |
| `packages/domain/src/services/payment-command-service.ts` | (~500 estimated) | `payment-command-envelope.test.ts` | Happy path EXECUTE / REFUSE covered. Idempotency-key-collision and version-conflict paths probably uncovered. | Optimistic-lock retry behavior |
| `apps/api/src/routes/me.ts` (~400 lines) | | `me-routes.test.ts` (425 lines) | OTP gate + 3-endpoint flow covered | Race between cancel-deletion and 23h59m sweeper |
| `apps/api/src/subscribers/anonymize-grace-resolver.ts` | (~120 estimated) | `anonymize-grace-resolver.test.ts` (138 lines, 4 tests) | 4 outcomes covered (skipped × 2, anonymized, error) | Sentry/log assertions, redis del failure mid-clear |

**Quality verdict:** Per-file coverage is HIGH where tests exist, but the *seams* between files are LOW. The migration's risk is at the seams.

---

## Top 20 recommended new tests (ranked by risk)

1. **`lgpd-full-lifecycle.integration.test.ts`** — single test that exercises: POST initiate → DELETE OTP → DEFER park (T0) → POST cancel-deletion (T+1h) → POST initiate again → DELETE OTP → DEFER park (T+1h+1s) → fast-forward 24h → defer-timeout-sweeper publishes → grace resolver consumes → `anonymizeCustomer` is called exactly once with the correct customerId. Closes 4 P0 gaps in one shot.

2. **`concurrent-admin-confirm.test.ts`** — Promise.all of two concurrent `confirm` calls with the same `confirmationId`. Asserts exactly one returns 200 and one returns 410; `transitionStatusFromEnvelope` called exactly once. Pins the Lua atomic claim.

3. **`audit-sink-failure-decision-completes.test.ts`** — adjudicate() runs through a real route handler while the Postgres audit writer throws. Asserts the route returns 200 (or the kernel-decided status) and the decision is not silently dropped. Verifies the spill-and-continue contract end-to-end.

4. **`bypass-detection-extension.test.ts`** — extend `bypass-detection.test.ts` with: (a) Redis lock release without Lua ownership check, (b) `executeRawUnsafe` outside command services, (c) direct Twilio messages.create outside WhatsApp Pack, (d) console.log of envelope payloads.

5. **`order-cancel-refund-multi-pack-chain.integration.test.ts`** — customer cancels paid order; the cancel-handler enqueues a refund envelope; the refund completes; audit shows two linked rows with `supersedes` pointing back. Pins the multi-pack chain.

6. **`kernel-bootstrap-failure.test.ts`** — Pack with intentional drift is registered; `bootstrapKernel(server)` throws `PackConformanceError`; process exits non-zero. Pins task 01's "exit non-zero on conformance fail" contract.

7. **`stripe-webhook-anonymized-customer.test.ts`** — Stripe `payment_intent.succeeded` arrives for a customer that was anonymized 25h ago. Asserts no PII echoes back, no 5xx, deterministic 200 with no-op semantics.

8. **`anonymize-during-open-order.test.ts`** — customer with an unfulfilled order tries to initiate deletion. Asserts a defined behavior (REFUSE or DEFER with order-completion signal). Today: undefined.

9. **`shadow-divergence-NONE-class.test.ts`** — extend `shadow-enforce-branching.test.ts` with a positive `divergence === "NONE"` assertion (currently only inferred from absence). Completes the 4-class matrix.

10. **`concurrent-envelope-build-determinism.test.ts`** — Promise.all of N concurrent `buildEnvelope(...)` calls with identical content. Asserts all hashes identical and one audit row would be written (with current code path). Pins the replay-safety claim under concurrency.

11. **`replay-from-audit-record.test.ts`** — load a real AuditRecord (from fixture), reconstruct envelope + state, call `adjudicate()`, assert returned decision kind matches the record's `decision.kind`. This is the first actual replay test (today's `ibx kernel replay` is a stub).

12. **`redis-outage-defer-park.test.ts`** — `getRedisClient()` rejects during DEFER park. Asserts the route returns a graceful 5xx (not crash) and no half-state is persisted.

13. **`nats-publish-failure-resume-cascade.test.ts`** — `publishNatsEvent('payment.confirmed', ...)` rejects; verify the parked envelope STAYS parked and isn't prematurely cleared. (Today: sweeper-side is tested; this is the *publisher*-side.)

14. **`ledger-noscript-recovery.test.ts`** — Redis EVAL rejects with NOSCRIPT for the Lua confirm script; assert the route falls back gracefully or re-loads the script.

15. **`twilio-otp-replay.test.ts`** — same OTP token used twice within 5min for `DELETE /api/me/data`. Today: the freshness marker is consumed atomically on first use (passing test exists at line 329 — verify) but the *Twilio Verify* side is not pinned in this assertion. Add a positive test.

16. **`anonymize-cancel-race-with-sweeper.test.ts`** — defer-timeout-sweeper runs at T+23h59m59s; customer cancel-deletion arrives at T+23h59m59.5s. Assert exactly one of the two wins, and the receipt + parked envelope are both cleared either way.

17. **`installPack-pack-drift-exits.test.ts`** — already covered by item 6 in part; this is the broader version testing each of the 4 first-party packs individually. ~30min effort.

18. **`audit-redactor-circular-reference.test.ts`** — payload contains a circular reference (object → child → parent). Today the redactor does a deep walk; circular refs might infinite-loop. ~15min effort to add.

19. **`stripe-webhook-charge-dispute-create.deterministic-hash.test.ts`** — extend the existing `payment_intent.succeeded` determinism test to all 5 Stripe event types (refunded, dispute.created, payment_failed, canceled). Currently only succeeded is pinned.

20. **`metric-sink-drop-resilience.test.ts`** — `setMetricsSink({} as any)` (broken sink missing recordDecision). Today: the kernel-metrics-sink test (line 252) covers the `recordSinkFailure` *counter increment*; this would test that a *broken* sink doesn't crash adjudicate().

---

## Closing notes

- **Effort estimate for P0 close-out** (items 1-9 above): **~10-14 engineer-days for a single engineer**. Highest-ROI is item 1 (~2 days, closes 4 gaps).
- **Effort estimate for full P0+P1 close-out** (items 1-15): **~3 engineer-weeks**.
- **Audit-of-audit:** 5 of the 13 task numbers cited in the question (task 01, 03, 12, 13, 19, 20) refer to functionality where the *test* exists but the *integration boundary* does not. The pattern repeats: unit tests are thorough; cross-cutting tests are sparse.
- The bypass-detection gate as-shipped is a strong foundation; extending to 8 scenarios (from 4) is **one engineer-day** and closes 80% of the foot-gun surface that the CLAUDE.md hard-rules enumerate.
