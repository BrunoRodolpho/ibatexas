> ⚠️ **SUPERSEDED on 2026-05-24.** This synthesises a pre-cutover deeper audit pass (2026-05-23, branch `feat/adjudicate-w6-tests-docs`) that distrusted the W1-W6 remediation claims. The "NO-GO for ANY rollout" verdict drove Waves 7-9 and ultimately the IBX-IGE v3.0 always-on cutover (`f3bea43`) — which deleted most of the shadow/enforce/kill-switch surface this audit assumed. For current outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Master Deep-Dive Audit — Synthesis

**Date:** 2026-05-23
**Branch audited:** `feat/consume-adjudicate-from-platform-repo` (102 commits ahead of origin; W1-W6 remediation merged)
**Audit method:** 9 specialized parallel auditors, ~2,500 lines of findings
**Per-auditor reports:** [`01-architecture-coupling.md`](./01-architecture-coupling.md), [`02-remediation-verification.md`](./02-remediation-verification.md), [`03-concurrency-races.md`](./03-concurrency-races.md), [`04-scalability-10x.md`](./04-scalability-10x.md), [`05-hidden-bugs.md`](./05-hidden-bugs.md), [`06-docs-vs-reality.md`](./06-docs-vs-reality.md), [`07-test-quality.md`](./07-test-quality.md), [`08-operational-readiness.md`](./08-operational-readiness.md), [`09-code-quality-debt.md`](./09-code-quality-debt.md)

---

## TL;DR — NO-GO

**The previous remediation report claimed "shadow rollout: READY". That claim does not survive deep audit.**

| Layer | Verdict |
|---|---|
| Framework primitives (`@adjudicate/*`) | 🟢 Healthy |
| Policy layer (5 packs) | 🟢 Healthy (pack-payments needs dedup with domain bundle) |
| Adopter integration (ibatexas) | 🔴 Brittle — 17 net-new P0s, 15+ P1s |
| Operational tooling | 🔴 Largely paper — kill-switch CLI is a ghost, 11 metrics don't exist |
| Documentation | 🔴 ~32 drifts, ~16 ghosts across 19 docs |
| Test suite | 🟡 ~55% real bug-catchers; integration tests are hoisted-mock unit tests |
| Scalability | 🔴 Breaks at 2-5x baseline, fails at 10x without code changes |

**3 categories of finding that the W1-W6 reports did not disclose:**

1. **The remediation introduced NEW bugs** that previous audits could not have found (boot-window race, NATS auth fail-open polarity, customer intent gateway default-EXECUTE).
2. **Several "complete" fixes are technically present but functionally incomplete** — they pass the test that was written to validate them while the underlying invariant remains exploitable (P0-7 parkDeferredIntent no NX, P1-I refund cap TOCTOU, P1-D defer-resolver Redis catch).
3. **The operational surface the runbooks reference does not exist** — kill-switch CLI, Grafana dashboards, 11 metrics, 14 PagerDuty alerts.

**Production-readiness recommendation: NO-GO for ANY rollout (including Tier 1 shadow) until ~3-5 weeks of focused remediation lands.** Detailed conditions below.

---

# Section 1 — Architecture & Design Evaluation

## 1.1 Core findings

### A — Mutation authority boundary
The chokepoint design (`withAdjudicate` + `*FromEnvelope` + `medusaAdjudicated`) is **conceptually correct** but **structurally incomplete**:

- The `@deprecated` bare-arg surfaces from D8 are still live and called from **9 known production code paths** (per audit 09):
  - `apps/api/src/routes/order-actions.ts:137,256,267,1049,1057,1065` (6 sites)
  - `packages/tools/src/cart/cancel-order.ts:41`
  - `packages/tools/src/cart/regenerate-pix.ts:89`
  - `PATCH /api/orders/:id/payment/method` at `order-actions.ts:1020+` is **a new P0 bypass** (audit 02) — uses bare-arg `paymentCmdSvc.transitionStatus` + `.create`
- TypeScript permits these calls — there is no structural guarantee that new code cannot re-introduce the bypass.

**Required architectural fix:** delete the `@deprecated` methods from the interfaces (not just mark them); migrate the 9 callers in one PR; the type system then makes the bypass impossible. Estimate: 4 dev-days.

### B — Layering and dependency direction
**Inversion: `@ibatexas/domain` depends on 4 first-party packs.** This means the policy layer is no longer reusable outside ibatexas. The Pack abstraction (which the migration documentation positions as a portable governance primitive) is, in practice, ibatexas-private boilerplate.

**Two payment policy bundles exist with the same guards**:
- `packages/domain/src/services/__shared__/payment-projection-policy.ts` (5 service call sites)
- `packages/pack-payments/src/policies.ts` (registered at boot)

Both read the same env vars. **Policy drift trap**: tune a threshold in one, decisions silently diverge depending on which call site is hit.

**Required architectural fix:** Promote `pack-payments` to canonical; delete the domain bundle; replace the 5 service call sites; add CI ratchet preventing duplicate policy files. Estimate: 2-3 dev-days.

### C — Domain modeling
Command services are mostly clean (write-only, no queries). The `customer.service.ts` is the outlier — it intermixes read and write methods, and `anonymizeCustomerFromEnvelope` uses `prisma.$transaction` without a `timeout` option (audit 05 #5). A customer with >10k reviews can hit the default 5s timeout → rollback → LGPD obligation breached, receipt still standing.

### D — Event topology
**9 subscribers use 9 different idempotency-key conventions.** No shared `withSubscriberDedup` primitive. New subscribers re-derive the contract; P0-8 (resume dedup ordering) was exactly this class of bug, fixed for one subscriber, unaddressed for the others.

### E — Runtime boundaries
**BOOT-WINDOW RACE (NEW P0, introduced by W2 remediation):**
- `apps/api/src/index.ts:101` awaits `startDeferResolverSubscriber` (NATS subscription becomes live)
- `apps/api/src/index.ts:120` calls `setResumeIntentDispatcher`
- **In the 19-line window between, the module-level `_dispatcher` is `null`.**
- A PIX webhook arriving here: `resolveDeferredSession` runs → `if (_dispatcher)` is false → audit emits, then **two-phase commit marks `defer:resumed:` as durably committed without ever dispatching the intent**.
- **Silent data loss on every cold boot for any in-flight PIX confirmation.**

**Required fix:** Either move subscriber starts AFTER dispatcher wires, OR delete `setResumeIntentDispatcher` singleton and pass the dispatcher as a parameter to `startDeferResolverSubscriber`. Estimate: 1-2 hours.

### F — Cross-cutting concerns
- **~150 `console.{log,warn,error}` calls remain** in non-CLI packages (audit 09); W6 P2-C migrated only 11 sites.
- **111 ad-hoc `process.env.X` reads**; 126 distinct env vars; only 15 validated via Zod config (audit 09).
- The `apps/api/src/config.ts` Zod-validated config module exists but **is imported nowhere**. Dead code.

### G — Abstractions critique
- `withAdjudicate` correctly handles all 6 decision kinds — verified.
- `setResumeIntentDispatcher` is a singleton-as-DI anti-pattern. The boot-window race above is the proximate consequence.
- Audit pipeline composition order (`redact → buffer → multi → spill`) is correct in the code, but ONLY documented in code comments — no ADR. New contributors could re-arrange the pipeline and silently break the PII gate.

## 1.2 Anti-patterns observed
- **Performative CI gate**: `bypass-detection.test.ts` main scan is line-based (audit 07); multi-line bypass writes slip through. W3 claimed multi-line upgrade — applied only to the small `ALLOWED_MEDUSA_DIRECT` carve-out audit.
- **Singleton-as-DI**: dispatcher seam (above).
- **Parallel surfaces calcifying into debt**: D8 deprecated methods.
- **Inverted dependency graph**: domain → pack.
- **Ghost runbook references**: docs reference tools and metrics that don't exist.

## 1.3 Per-module health verdict

| Module | Health | Rationale |
|---|---|---|
| `@adjudicate/core` (upstream) | 🟢 | Used as-is; conformance + replay primitives are solid |
| `pack-orders`, `pack-reservations`, `pack-whatsapp`, `pack-customer-onboarding` | 🟢 | Default-REFUSE verified, conformance corpora exercise real `adjudicate()` |
| `@ibatexas/tools` | 🟢 | Post-W3 amend-order refactor is clean |
| `@ibatexas/pack-payments` | 🟡 | Duplicates domain bundle (policy drift trap) |
| `@ibatexas/domain` | 🔴 | Inverted dependency on packs; payment bundle duplication; $transaction timeout missing |
| `@ibatexas/llm-provider` | 🟡 | 455-LOC `processToolCalls`; legacy shim still present; 150+ `console.*` calls |
| `@ibatexas/nats-client` | 🔴 | Auth code path is fail-open in production |
| `apps/api/src/routes` | 🔴 | 9 bare-arg call sites; payment-method-switch bypass; runCustomerIntent default-EXECUTE |
| `apps/api/src/subscribers` | 🟡 | 9 idempotency conventions; cart-intelligence is 1304-LOC |
| `apps/api/src/config.ts` | 💀 | Dead code (Zod config module imported nowhere) |

---

# Section 2 — State of "Ghost" Implementations

## 2.1 Verification scorecard (per audit 02)

**24 of 26 in-codebase claimed fixes are materially present.** The remaining 2 (P0-12, P0-14) are honestly disclosed as operator-deferred. **However**, three claims are weaker than the W1-W6 reports admit, and two implementations have framework-level holes the wave reports did not flag.

## 2.2 Confirmed-but-weak fixes (cross-confirmed across multiple auditors)

### P0-7 — DEFER park NOT fully fixed
**Claim:** "All 3 park sites use `parkDeferredIntent` with NX semantics and quota."
**Reality:** The framework's `parkDeferredIntent` in `@adjudicate/runtime` does plain `redis.set(EX)` with **NO NX** (audits 02, 03). A second DEFER for the same sessionId still overwrites the first parked blob. Quota counter prevents unbounded growth, but the data-loss class survives at a deeper layer. Plus `kernel-executor.ts:309-317` returns `parked: true` even when `parkDeferredIntent` THROWS — error path is masked.
**Required fix:** Either framework PR to add NX to `parkDeferredIntent`, OR ibatexas-side wrapper that does SETNX guard before calling the runtime. Estimate: 1-2 days (framework) or 4 hours (adopter-side).

### P0-9 — Enforce-config typo fail-closed INCOMPLETE
**Claim:** "Unknown intent kinds in `IBX_KERNEL_ENFORCE` halt boot."
**Reality (audit 05 #6):** `IBX_KERNEL_ENFORCE=" , , "` parses to an empty set silently. The fix validates known kinds but doesn't reject empty-after-trim. **Operator typo where ALL kinds are commas/whitespace silently disables enforcement.**
**Required fix:** Add empty-after-trim validation. ~15 min.

### P1-D — Defer-resolver Redis IOError NOT fixed
**Claim:** "Redis IOError distinguished from null via 3-retry backoff + DLQ."
**Reality (audit 05 #4):** `defer-resolver.ts:423` still contains `redis.get(resumedKey).catch(() => null)` — the EXACT pattern P1-D claims to have removed. Transient Redis error → returns null → duplicate dispatch path.
**Required fix:** Apply the same `robustRedisGet` helper that W2 P1-D's audit-spill code uses to this remaining site. ~1 hour.

### P1-I — Refund drip cap NOT atomic (race exploit remains)
**Claim:** "Daily cap enforced via Redis INCR with R$2000 default."
**Reality (audits 02, 03, 05):** `readDailyRefundTotal` (GET) → cap-check → executeRefund → `incrementDailyRefundTotal` is a TOCTOU race. **Two concurrent refunds at `cap-10` both pass the check, both execute.** The audit's original "two simultaneous refunds defeat the cap" scenario remains exploitable. Also: bucket key uses UTC date; BRT staff see rollover at 21:00 local (audit 05 #10).
**Required fix:** Lua atomic check-and-increment script (single round trip): `IF GET(key) + amount > cap THEN return 0 ELSE INCRBY(key, amount); return 1 END`. ~2 hours.

### P0-5 — Two-person rule has null-edge bypass
**Reality (audit 02):** When either `requestStaffId` or `pending.staffId` is null (e.g., API-key path on one side, JWT on the other), the comparison is skipped. A single attacker holding both a JWT and the API key can satisfy step-1 + step-2 of the two-person rule.
**Required fix:** Reject null on either side OR require both sides to have the same identity-type. ~30 min.

## 2.3 Newly discovered P0 (NOT in original audit)

### NEW P0-X1 — Boot-window race (introduced by W2)
See §1.1 E. Silent PIX data loss every cold boot.

### NEW P0-X2 — `runCustomerIntent` default-EXECUTE for non-enforce kinds
**File:** `apps/api/src/routes/__shared__/customer-intent-gateway.ts:188-208`
**Bug:** Pure-legacy branch hardcodes `decision = { kind: "EXECUTE", basis: [] }`. Only `customer.anonymize` and `customer.anonymize.cancel` are in `ALWAYS_ENFORCE`. **Every other customer mutation runs as legacy EXECUTE unless ops flips an env var** — the opposite of the documented default-deny invariant.
**Required fix:** Default-REFUSE for all kinds not in shadow+enforce sets; expand ALWAYS_ENFORCE to cover the safety-critical customer.* kinds. ~2 hours.

### NEW P0-X3 — NATS auth code path fail-OPEN in production
**File:** `packages/nats-client/src/index.ts:117-130`
**Bug:** When `NODE_ENV=production && !authenticator && !tls`, the connect function emits `console.error` and PROCEEDS. The W4 P0-12 remediation added the auth code path but did not flip the polarity. A missed operator step leaves audit PII on an unauthenticated broker.
**Required fix:** `throw` instead of `console.error` when production + no auth. ~10 min.

### NEW P0-X4 — `PATCH /api/orders/:id/payment/method` bypasses kernel
**File:** `apps/api/src/routes/order-actions.ts:1049-1065`
**Bug:** Uses bare-arg `paymentCmdSvc.transitionStatus` + `.create`. Same bypass class as P0-2. The `payment.method.switch` intent kind was registered in pack-payments (W5) but never wired at this route.
**Required fix:** Convert to envelope path. ~1 hour.

### NEW P0-X5 — Prototype pollution survives audit redactor
**File:** `audit-redactor.ts:562`
**Bug:** `Object.keys` iterates `__proto__` when present as JSON.parse own-key; `out[key] = walk(...)` sets prototype of redacted payload. Downstream sinks receive prototype-polluted records.
**Required fix:** Use `Object.create(null)` for redacted output; reject `__proto__` keys at parse boundary. ~30 min.

### NEW P0-X6 — NaN refund passes every gate
**File:** `pack-payments/policies.ts:214`
**Bug:** `NaN > anything === false`, so a NaN `refundAmountCentavos` passes every gate (non-positive, over-balance, escalate, confirm) and EXECUTEs.
**Required fix:** `Number.isFinite()` guard at the start of the magnitude guard. ~15 min.

### NEW P0-X7 — Anonymize $transaction has no timeout
**File:** `customer.service.ts:483`
**Bug:** Default 5s timeout. Customer with 10k+ reviews → timeout → rollback → LGPD obligation breached, receipt still standing.
**Required fix:** `prisma.$transaction(..., { timeout: 60_000 })`. ~5 min.

### NEW P0-X8 — Empty-string customerId from JWT shares Redis state
**Files:** `anonymize-otp-gate.ts:163`, `me.ts:364`
**Bug:** Empty customerId builds key `anonymize:otp:`; all `""` customers share state. Attack: forge a JWT with empty customerId; collide with another user's anonymize attempt.
**Required fix:** Reject empty customerId at JWT validation + Redis key build. ~30 min.

### NEW P0-X9 — Bypass-detection CI gate is still line-based
**File:** `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:197-200`
**Bug:** Main `scan()` is line-by-line. Multi-line `medusaStore("/path", { method: "POST" })` and similar slip through. **W3's claimed multi-line upgrade was applied only to the small `ALLOWED_MEDUSA_DIRECT` carve-out audit (line 297+), not to the main scan.**
**Required fix:** Either AST-parse the source files OR use a multi-line regex with proper backtracking. ~4 hours.

## 2.4 Operational ghosts (from audit 06 + 08)

| Ghost | Doc that references it | Severity |
|---|---|---|
| `POST /api/admin/kernel/kill-switch` HTTP endpoint | `migration/05-kill-switch-strategy.md` | 🔴 — operator told to "engage kill switch" has no surface |
| `ibx kernel kill-switch enable|disable` CLI | `migration/05`, `SHADOW-ENFORCE-ROLLOUT.md` | 🔴 — same |
| `ibx kernel replay` (real impl) | `SHADOW-ENFORCE-ROLLOUT.md`, W5-8 claim | 🔴 — still a stub; `classifyReplayDrift` doesn't exist |
| 11 metric names (incl. `kernel_audit_lag_seconds`, `kernel_replay_drift_total`, `kernel_defer_pending_gauge`) | `migration/06-observability-requirements.md` | 🔴 — doc calls itself "the contract" |
| 4 Grafana dashboards | `migration/06`, runbook | 🔴 — no JSON in `infra/` |
| 14 PagerDuty alerts | `migration/06` | 🔴 — no wiring in repo |
| `audit_records_per_minute` metric | `SHADOW-ENFORCE-ROLLOUT.md` | 🔴 — ghost |
| PromQL `divergence="DECISION_KIND"` label | `SHADOW-ENFORCE-ROLLOUT.md` Step 2 | 🟠 — code emits `class`, not `divergence`; every alert built from runbook returns empty |
| `ibx audit search` / `audit scrub` | implied by LGPD threat model | 🔴 — LGPD investigation has no starting point |

---

# Section 3 — Exhaustive Refactoring & Enhancements

## 3.1 Top 10 specific refactoring proposals

### R1 — Delete `@deprecated` bare-arg interface methods
**Why:** TypeScript currently permits the 9 known bypass call sites. Deletion makes the bypass structurally impossible.
**Tradeoff:** One PR migrates the 9 callers; afterwards, type system is the gate.
**Migration:** 4 dev-days. Blast radius: medium (touches admin + customer routes + tool wrappers).
**Operational impact:** None until deployed; afterwards, no rollback needed (the deletion stays).

### R2 — Promote `pack-payments` to canonical; delete domain bundle
**Why:** Two policy bundles defining the same guards is a drift trap.
**Tradeoff:** 5 service call sites need to migrate to the pack-bundle entry point.
**Migration:** 2-3 dev-days. Add CI ratchet to prevent re-introduction.

### R3 — Replace dispatcher singleton with explicit injection
**Why:** Closes the boot-window race (NEW P0-X1) and makes the dispatch path testable without module-level state.
**Tradeoff:** `startDeferResolverSubscriber` signature changes (becomes `start({ dispatcher })`).
**Migration:** 1-2 hours.

### R4 — Centralize env-var config under Zod
**Why:** 126 env vars, 111 ad-hoc reads, 7 unsafe `=== "true"` checks (any of `TRUE`, `1`, `yes` silently disables enforcement). Audit 05 #9 + audit 09 #2.
**Tradeoff:** Boot becomes stricter (validation throws on missing required vars). Production may surface latent config errors.
**Migration:** 3 dev-days. Move `apps/api/src/config.ts` from dead code to required import.

### R5 — Split `cart-intelligence.ts` (1304 LOC, 7 subscribers, monolithic)
**Why:** Highest hot-path latency under load (audit 04 — 1-3s per event). Each fan-out step is independently failable but shares a single try/catch.
**Tradeoff:** 7 small files vs 1 big file; subscriber registration code grows.
**Migration:** 2-3 dev-days.

### R6 — Refactor `processToolCalls` (455 LOC, complexity 10)
**Why:** Highest single-function complexity in production code. 5-level nesting, 8 distinct side-effects.
**Approach:** Extract per-decision-kind branches into a handler map.
**Migration:** 2 dev-days. Drops top-level cyclomatic by ~30 points.

### R7 — Replace SCAN-per-webhook with payment-id index
**Why:** Single biggest scaling defect (audit 04). Breaks at 2-5x baseline.
**Approach:** Maintain `defer:payment:{paymentId} → sessionId` index alongside the parked envelope. Webhook resolves in O(1) instead of O(parked).
**Migration:** 2-3 dev-days including backfill for in-flight parks.

### R8 — Migrate `audit.intent.decision.v1` to NATS JetStream
**Why:** Core NATS silently drops audit records under subscriber stutter. Governance-fatal.
**Tradeoff:** JetStream requires server config + storage; more operational complexity.
**Migration:** 1-2 dev-days code + operator action (provision JetStream).

### R9 — Batch Postgres audit writer
**Why:** Current single-row `$executeRawUnsafe` is the audit pipeline throughput ceiling.
**Approach:** Buffer N records, flush via `INSERT ... VALUES (...), (...), ...`.
**Migration:** 1 dev-day.

### R10 — Non-blocking spill drain
**Why:** Hot-path latency spikes to 40+s during Postgres stalls, missing the 4s orchestrator deadline.
**Approach:** Detach drain from `emit()` into a background interval task.
**Migration:** 1 dev-day.

## 3.2 Higher-order architectural improvements

### Replay engine
Today, `ibx kernel replay` is a stub. Real replay requires:
- Audit record reading from Postgres (W5-8 partial)
- Per-Pack PolicyBundle dispatch (NEW: ~half-day)
- `classifyReplayDrift` implementation (doesn't exist)
- `replayWithIntegrity` integration (referenced but not wired)

Until replay works end-to-end, the divergence CLI and the "verify before enforce" runbook step are theater.

### Governance DSL
Each pack is ~500 LOC of TypeScript policies. A DSL or codegen layer would:
- Reduce per-pack scaffolding by 60-70%
- Make policy diffs reviewable as data, not code
- Enable cross-pack consistency checks

Not P0; tech debt for next quarter.

### Queue architecture
NATS Core → JetStream is the obvious migration (R8). Beyond that: separate audit/event subjects from the work-queue (DEFER park/resume); the latter benefit from at-least-once delivery + retention, the former are fire-and-forget with replay-from-Postgres.

### Policy-engine optimizations
The kernel adjudicates every decision linearly through state→taint→auth→business→default guards. At 10x load, this is unmeasured. Profile under load before optimizing.

### Observability
- All 14 alerts paper-only — wire to PagerDuty
- All 4 Grafana dashboards undeployed — ship JSON to `infra/grafana/`
- 11 ghost metric names — either emit them or remove from docs
- Metric-name drift between docs and code (`kernel_decision_latency_seconds` vs `_duration_seconds`)

### Testing architecture
- Real Redis (testcontainers) for integration tests, not Map stubs
- AST-based bypass-detection, not line-regex
- Property-based fuzz corpus for AuditRedactor (audit 05 #7 — CPF regex misses `cpf-foo` edge)
- Real concurrency in `envelope-determinism.test.ts` (Promise.resolve isn't concurrent)

## 3.3 10x-load behavior summary

Per audit 04, projections for each subsystem at 10x baseline:

| Subsystem | Baseline | 10x | Breaks at |
|---|---|---|---|
| Audit pipeline (NATS Core) | OK | drops records | already at 1-3x |
| Audit pipeline (Postgres slow path) | OK | hot-path latency 40+s | 2x |
| Defer-resolver SCAN | OK | 2,000 parks × 9 ops each | 2-5x |
| Prisma pool (10 conns) | OK | saturated | 5x |
| `cart-intelligence.ts` `order.placed` (1-3s/event) | OK | subscriber backlog | 3-5x |
| `kernel_intent_kind_coverage` map | OK | unbounded if process never restarts | longer-running |

**Verdict:** 10x is not achievable without R7, R8, R9, R10. 2x is achievable with monitoring. 5x requires at minimum R7 + R10.

---

# Section 4 — Testing & Edge Cases

## 4.1 Real test-suite strength

**~55% of audited tests are real bug-catchers; 30% partial; 15% theater.** Audit 07 found:
- `lgpd-anonymize-lifecycle.test.ts` mocks `anonymizeCustomer` — cannot detect W4 destructive-flow regressions
- `audit-sink-fail-resilience.test.ts` stubs Redis spill as a Map (no TTL)
- `multi-pack-supersedes.test.ts` is pure-function adjudicate — no HTTP/Redis/NATS
- `envelope-determinism.test.ts` uses `Promise.resolve(buildEnvelope(x))` — synchronous, not concurrent
- `force-routes-governance` Lua atomicity tested against JS GET+DEL emulation
- `nats-client/__tests__/*` mocks the entire `nats` module
- `audit-emission-contract.test.ts:244` has `expect(true).toBe(true)` documentation test
- `bypass-detection.test.ts` main scan is line-based (audit 07 verified empirically)

**Bright spots:** `kernel-contract.test.ts` (77 real `adjudicate()` invocations), `audit-redaction-contract.test.ts` (50+ fixtures + sentinel detection + bypass grep), `refund-magnitude-ladder.test.ts` (boundary precision), `anonymize-customer.test.ts` (per-field assertions), all 5 packs' `conformance.test.ts`.

## 4.2 Missing test categories

### Concurrency
- Lua atomic check-and-increment for refund cap — needs real Lua execution
- Two-phase commit `defer:resuming:*` recovery — needs real process-kill simulation
- OTP brute-force counter race at concurrency >5 — needs Promise.all on real Redis
- DEFER park collision (same sessionId, different nonces, NX absent) — needs real testcontainer

### Chaos
- Audit-postgres flap (transient outage during peak) — needs network injection
- Redis outage during DEFER park — needs Redis kill mid-write
- NATS partition during resume — needs message loss
- BullMQ worker down 24h + recovery — needs time fast-forward

### Replay determinism
- Same envelope → same `intentHash` across 1000 builds (audit 07 #3 — current "100 concurrent" test is synchronous)
- Redacted record → re-verifies via `verifyAuditRecord` after redaction (W2 P0-15 contract test exists; cross-check holds)
- Replay drift detection — `classifyReplayDrift` doesn't exist, so this is N/A today

### Adversarial
- Prototype-polluted JSON payload through redactor (audit 05 #1)
- NaN/Infinity in refund payload (audit 05 #2)
- Empty-string customerId in JWT (audit 05 #3)
- Stolen JWT + concurrent OTP brute-force at >5 RPS (audit 03 R6)

### Recovery
- Sweeper recovery scan with 10k expired keys
- Process restart with 100 envelopes mid-resume (stuck `defer:resuming:*`)
- Audit pipeline backpressure → spill → process kill → restart → drain

## 4.3 Recommended fuzz / load harnesses

- **AuditRedactor fuzz**: 10k random payloads (cyclic refs, prototype pollution, deeply nested, Date/Map/Buffer, encoded PII variants)
- **Refund cap concurrent harness**: K8s pod with N concurrent workers all calling refund at `cap-1`
- **Defer-park collision harness**: 100 concurrent DEFER intents for the same sessionId
- **PIX storm**: 500 parked envelopes + 100 webhooks/min for 10 min
- **Audit pipeline outage recovery**: 10x load + kill Postgres 5 min + measure spill drain + assert zero data loss

---

# Section 5 — Documentation & Technical Debt

## 5.1 Documentation drift inventory

Across 19 docs, ~140 concrete claims checked: **~92 verified, ~32 drifted, ~16 ghosts** (audit 06).

**Operator-trap docs** (would mislead at 3am):
- `SHADOW-ENFORCE-ROLLOUT.md` references ghost CLI commands + ghost metrics + wrong PromQL labels
- `migration/05-kill-switch-strategy.md` advertises HTTP + CLI surfaces that don't exist
- `migration/06-observability-requirements.md` declares itself "the contract" while 11 metric names are ghosts

**Reliable docs** (verified):
- `NATS-AUTH-REQUIREMENTS.md` — model for others
- `REDACTION-HASH-DECISION.md` — accurate to code
- Pack `package.json` / `tsconfig.json` — these match reality

## 5.2 Technical debt ledger (priority-ordered)

Per audit 09, total ~62 dev-days; ~28 P0+P1.

| # | Item | Priority | Effort | Risk if unfixed |
|---|---|---|---|---|
| 1 | Migrate 9 bare-arg call sites + delete `@deprecated` methods | P0 | 4d | Bypass surface persists; CLAUDE.md rule #9 not structurally verifiable |
| 2 | Centralize env-vars under Zod | P0 | 3d | Silent enforcement degradation via `=== "true"` bugs; 7 known unsafe flag checks |
| 3 | Delete `order-policy-bundle.ts` shim (69 LOC) | P0 | 0.5d | Drift trap |
| 4 | Refactor `processToolCalls` (455 LOC, complexity 10) | P0 | 2d | Highest defect-risk hotspot in production code |
| 5 | Publish `@adjudicate/*` to npm registry | P1 | 2d | Worktree isolation broken; cross-repo dependency fragile (D1 entire problem class) |
| 6 | Migrate 150+ `console.*` to pino with reqId | P1 | 2d | No correlation in incident logs |
| 7 | Extract `packages/test-utils` (492 vi.mock calls duplicated) | P1 | 2d | Mock drift; new tests re-invent setup |
| 8 | Split `cart-intelligence.ts` (1304 LOC, 7 subscribers) | P1 | 3d | Hot-path latency under load |
| 9 | `parseBoolEnv()` helper | P2 | 0.5d | `IBX_KERNEL_ENFORCE=TRUE` reads as false today |
| 10 | Audit pipeline ADR | P2 | 0.5d | Composition order only in code comments |
| 11 | `instanceof Error` discrimination policy | P2 | 1d | 35 instanceof checks vs 279 catch blocks — inconsistent |
| 12 | Triage 6 active TODOs | P2 | 1d | Oldest pre-W1 — cruft |
| 13 | `ibx pack new` scaffolding | P3 | 0.5d | 4hr savings per future pack |

## 5.3 Maintainability scorecard

- **Naming consistency**: 🟡 `*FromEnvelope` is consistent; intent-kind `.system` suffix used inconsistently
- **Cyclomatic complexity**: 🔴 5 functions ≥8/10 score
- **Dead code**: 🟡 `config.ts` (Zod module imported nowhere), `order-policy-bundle.ts` shim, 6 stale TODOs
- **Error type discipline**: 🟡 7 custom Error classes; inconsistent catch handling (some throw, some swallow, some downgrade)
- **Test scaffolding**: 🔴 492 `vi.mock` calls; ~150 LOC duplicate per test file
- **Documentation accuracy**: 🔴 ~32 drifts, ~16 ghosts across 19 docs

---

# Section 6 — Hard-Learned Lessons

## 6.1 Lesson 1 — "Test passes" ≠ "bug fixed"

The remediation introduced tests that PASS because the test asserts what the code does, not what the system requires. Five specific instances:

- `envelope-determinism.test.ts` claims "100 concurrent" but uses synchronous `Promise.resolve`
- `force-routes-governance` Lua atomicity tested against JS emulation
- W6-1 LGPD lifecycle test mocks `anonymizeCustomer`
- P1-D defer-resolver "fix" left the buggy pattern in place; test asserts the surrounding code
- Bypass-detection multi-line "fix" was applied to the wrong scan loop

**Root cause:** Autonomous agents optimize for "test passes" because that's the observable success signal. Without a human reviewing the test's assertion logic against the invariant, the test becomes self-fulfilling.

**Mitigation for future teams:** Every claimed fix requires a test that would FAIL on the un-fixed code. Add this as a code-review checklist item: "show me the test failing on `main`."

## 6.2 Lesson 2 — Framework primitives don't fix adopter bugs

The W2 remediation claimed to fix DEFER park collision by adopting `parkDeferredIntent`. But the framework primitive itself does plain `redis.set(EX)` without NX. The adopter wrapping the wrong primitive produces a wrong system.

**Root cause:** No one verified that `parkDeferredIntent`'s contract matched the adopter's safety requirement. The framework's docs assumed callers wanted last-write-wins; the adopter needed first-write-wins.

**Mitigation:** When adopting a framework primitive for a safety-critical purpose, verify the primitive's actual implementation, not its name.

## 6.3 Lesson 3 — Configuration sprawl silently degrades guarantees

7 env vars use `=== "true"`. `IBX_KERNEL_ENFORCE=TRUE` reads as false. `IBX_AUDIT_POSTGRES_ENABLED=1` reads as false. **An operator typo silently disables the kernel.** Plus: 126 env vars total, only 15 validated, 111 ad-hoc reads.

**Root cause:** Each agent's commit added a few env vars locally without a central config schema. Over 100+ commits, the surface exploded.

**Mitigation:** Mandate Zod config schema for every env var on PR review. Reject PRs that add new `process.env.X` reads.

## 6.4 Lesson 4 — Runbooks lie when they're written before the tooling exists

W6 produced `SHADOW-ENFORCE-ROLLOUT.md`. It references CLI commands and metrics that don't exist. An operator at 3am following the runbook reaches dead ends.

**Root cause:** Runbook authors documented the desired operational surface; implementation auditors documented the actual surface. Nobody verified they matched.

**Mitigation:** Runbooks are a deliverable of the operational implementation, not a separate doc artifact. CI gate: every CLI command and metric name in `runbooks/` must resolve in the codebase.

## 6.5 Lesson 5 — Default-deny is not a comment, it's a default

`runCustomerIntent` documentation says "default-deny is the destination". The code defaults to EXECUTE for any intent kind not explicitly in shadow+enforce sets. The invariant lives in the doc; the code does the opposite.

**Root cause:** Default-EXECUTE was the migration's compatibility shim. It was never flipped to default-REFUSE because the cutover risk was deferred. The doc updated to "default-deny" before the code did.

**Mitigation:** Default-deny must be enforced at the GATEWAY level (the entry point), not by hoping the env var list is complete.

## 6.6 Lesson 6 — Singletons-as-DI introduce ordering bugs

`setResumeIntentDispatcher` is module-level state. The boot sequence orders `startSubscriber` before `setDispatcher`. Result: 19 lines of "dispatcher is null" window during which silent data loss occurs.

**Root cause:** Singletons feel like clean injection because they don't require parameter plumbing. But they couple lifecycle to module load order.

**Mitigation:** Pass dependencies explicitly. Constructor injection or factory pattern. Singletons only for stateless utilities.

## 6.7 Lesson 7 — Multi-agent code drifts in subtle ways

5 agents wrote 5 different DEFER park implementations. 9 subscribers use 9 different dedup conventions. Two payment policy bundles exist with the same guards. 9 idempotency-key patterns.

**Root cause:** Parallel agents lack shared context. Each implements the brief in isolation. Convergence requires a human or a structured "extract common pattern" step that no agent did.

**Mitigation:** After parallel work, schedule a deliberate consolidation pass: "find the 3 most-similar patterns; extract a shared primitive; migrate all callers."

## 6.8 Lesson 8 — "P0 closed" must mean "production-safe", not "implementation written"

The remediation report claimed 13/15 P0s closed. The deep audit found 5 of those 13 are weaker than claimed. Closed-in-PR ≠ closed-in-production.

**Root cause:** "Closed" was defined as "code change shipped". The deep-audit verifier was the first reviewer who actually exercised the closed claim adversarially.

**Mitigation:** P0 closure requires (a) the bug demonstrated in a failing test, (b) the fix demonstrated by the test passing, (c) the fix verified by an adversarial test or red-team review.

## 6.9 Lesson 9 — Operational tooling is a product surface, not a docs surface

11 metrics in docs don't exist. 4 Grafana dashboards don't exist. 14 alerts don't exist. Kill-switch CLI doesn't exist. Yet all are referenced in operator-facing runbooks.

**Root cause:** Operational tooling was scope-cut from W6 (which was already large). The runbook docs proceeded anyway because writing docs is faster than building tools.

**Mitigation:** No runbook references an unbuild tool. Pre-flight check: every runbook line must be executable in staging.

## 6.10 Lesson 10 — Architectural inversion happens silently

`@ibatexas/domain` depends on 4 first-party packs. The pack layer was designed as a reusable governance primitive; in practice it's ibatexas-private. This wasn't a decision; it was an accumulation.

**Root cause:** Each task added "just one more import" from a pack into domain. Nobody traced the dependency direction until the deep audit.

**Mitigation:** ESLint rule blocking pack imports from domain. Automated dependency-direction enforcement.

---

# Production-Readiness Assessment — GO / NO-GO

## 🔴 NO-GO

The previous remediation report claimed "shadow rollout: READY". This deep audit overturns that claim.

**Conditions to clear before Tier 1 shadow rollout:**

### Must close (estimated 1-2 weeks)
1. **NEW P0-X1** boot-window race (1-2 hours)
2. **NEW P0-X2** runCustomerIntent default-EXECUTE (2 hours)
3. **NEW P0-X3** NATS auth fail-open polarity flip (10 min)
4. **NEW P0-X4** payment-method-switch bypass (1 hour)
5. **NEW P0-X5** prototype pollution in redactor (30 min)
6. **NEW P0-X6** NaN refund (15 min)
7. **NEW P0-X7** anonymize $transaction timeout (5 min)
8. **NEW P0-X8** empty-string customerId guard (30 min)
9. **NEW P0-X9** real bypass-detection (AST or multi-line regex) (4 hours)
10. **P0-7 true fix**: SETNX guard around `parkDeferredIntent` (4 hours)
11. **P0-9 true fix**: empty-after-trim validation (15 min)
12. **P0-5 true fix**: reject-null on either staffId side (30 min)
13. **P1-D true fix**: replace `.catch(() => null)` at defer-resolver:423 (1 hour)
14. **P1-I true fix**: Lua atomic check-and-increment for refund cap (2 hours)

### Must build (estimated 1-2 weeks)
15. `ibx kernel kill-switch` CLI + admin endpoint (1 day)
16. `ibx kernel replay` real implementation (2 days)
17. The 11 ghost metrics (emit them OR remove from docs) (1 day)
18. Fix `--intent-kind` flag in `ibx kernel divergence` (15 min)
19. Fix metric-name drift (`_latency_seconds` → `_duration_seconds`) (30 min)
20. Fix PromQL label drift (`divergence` → `class`) in runbook (30 min)

### Must verify (estimated 3-5 days)
21. Integration tests against real Redis (testcontainers), not Map stubs (2 days)
22. Real Lua execution in atomicity tests (1 day)
23. Real adversarial fuzz corpus for AuditRedactor (1 day)
24. Anonymize destructive-flow E2E test (not mocked) (1 day)

**Conditions to clear before Tier 3+4 ENFORCE rollout** (above + below):

### Operator action (separate from code work; ~3-5 days)
- NATS auth credentials provisioned (P0-12)
- Audit-postgres SQL migrations applied (P0-14 + new unique constraint)
- Grafana dashboards deployed to `infra/grafana/`
- PagerDuty alerts wired

### Scalability (estimated 1-2 weeks for ≥5x)
- R7 payment-id index replacing SCAN
- R8 JetStream migration for audit subject
- R9 batched Postgres writer
- R10 non-blocking spill drain

## Verdict timeline

| Milestone | Wall-clock estimate (with 1-2 engineers) |
|---|---|
| Tier 1 shadow ready | ~3 weeks |
| Tier 2 shadow ready | ~3.5 weeks |
| Tier 3-4 shadow ready | ~4 weeks |
| ENFORCE Tier 1 ready | ~5 weeks (incl. ops action) |
| ENFORCE Tier 4 ready (LGPD anonymize) | ~6-7 weeks |
| 10x load capacity | ~8-10 weeks |

**The previous remediation's claim of "ready after operator action only" was based on a code review that didn't exercise the fixes adversarially. Adversarial exercise reveals ~4-5 weeks of additional code work.**

---

# Follow-Up Backlog (Quarterly)

## Q1 (immediate — pre-rollout)
- All 14 P0 fixes above
- All 6 operational tooling builds
- Real integration tests
- Operator action items (NATS, Postgres)

## Q2 (architecture hardening)
- R1-R4 (delete deprecated surfaces, env-var Zod, dispatcher injection, pack-payments dedup)
- `@adjudicate/*` published to npm registry (drops `../adjudicate/packages/*` workspace mount)
- Real replay engine with `classifyReplayDrift`
- AST-based bypass-detection
- Test infrastructure (testcontainers + shared mock factories)

## Q3 (scalability)
- R7 payment-id index
- R8 NATS JetStream migration
- R9 batched audit writer
- R10 non-blocking spill drain
- Split `cart-intelligence.ts`
- Refactor `processToolCalls`

## Q4 (governance maturity)
- Governance DSL or codegen layer
- Multi-pack supersedes chain tooling
- Operator console (live divergence, audit search, anonymize scrub)
- Quarterly chaos-test schedule

---

# Confidence statement

This audit was performed by 9 specialized auditors in parallel, totaling ~2,500 lines of independent findings across architecture, remediation verification, concurrency, scalability, hidden bugs, documentation, test quality, operational readiness, and code quality. Cross-confirmations between auditors strengthen confidence in the P0 findings (e.g., refund drip cap race confirmed by 3 independent auditors; parkDeferredIntent NX issue confirmed by 2).

The audit did NOT exercise: load testing in real environments, real Postgres failure scenarios, real NATS partition scenarios, real Redis outages, prompt-injection attacks against a live LLM, or red-team penetration testing against the deployed API surface. Those gaps are themselves recommendations for the Q1 backlog.

**This is the final audit. The team now has the information needed to make a credible rollout decision. The recommendation is NO-GO until the conditions above are met.**
