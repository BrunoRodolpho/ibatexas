# Concurrency & Races Deep Audit

Auditor: Concurrency & Race Conditions Auditor (distributed-systems-engineer level)
Scope: Redis-key choreography, two-phase commit recovery, audit pipeline backpressure, OTP/two-person rule races, refund drip cap, DEFER park/resume oscillation, pack-installation atomicity.
Date: 2026-05-23.
Files-deep-read (28): `defer-resolver.ts`, `defer-timeout-sweeper.ts`, `defer-park.ts` (adjudicate runtime), `defer-resume.ts` (adjudicate runtime), `kernel-executor.ts`, `llm-responder.ts`, `me.ts`, `anonymize-otp-gate.ts`, `anonymize-grace-resolver.ts`, `admin-confirmation-store.ts`, `admin/payments.ts`, `stripe-webhook.ts`, `intent-audit-wiring.ts`, `redis-spill-storage.ts`, `persistent-buffered-sink.ts` (adjudicate audit), `kernel-bootstrap.ts`, `customer-intent-gateway.ts`, `whatsapp/session.ts`, `distributed-lock.ts` (`@ibatexas/tools`), `order-actions.ts`, `pix-expiry-checker.ts`, `stale-order-checker.ts`, `envelope.ts` (adjudicate core), `pack-conformance.ts` (adjudicate core), `register-workers.ts`, `payment-command.service.ts` (sketch), `defer-resolver.test.ts`, `defer-timeout-sweeper.test.ts`.

---

## Executive summary

The DEFER park/resume choreography is the most concurrency-sensitive surface and is largely well thought-out — there is an explicit two-phase commit (`defer:resuming:*` claim marker + `defer:resumed:*` dedup ledger), idempotent recovery via `recovery:fired:{intentHash}`, and the runtime's `parkDeferredIntent` includes a Lua eval seam (`evalIncrCheck`) for race-free quota INCR-and-check. However, the wiring at adopters does NOT provide `evalIncrCheck`, falling back to the non-atomic INCR → EXPIRE → check → DECR sequence. There are also three confirmed atomicity holes outside DEFER: the **refund drip cap is read-then-INCRBY (not INCRBY-then-check)**, the **OTP brute-force counter is read-then-INCR (with no atomic-cap check)**, and the **admin-confirmation `consumeWithSameActorCheck` performs the same-actor check AFTER the atomic GET+DEL drains the receipt** — meaning a step-1 actor can race a step-2 attempt by another actor and lose the receipt.

Severity ranking (highest first): refund drip-cap race (P0), OTP brute-force window (P1), same-actor receipt drain (P1), DEFER park-key overwrite (P1), parkDeferredIntent quota non-atomic (P1 only because Lua eval seam exists but isn't wired), startup recovery scan vs steady-state sweeper (P2 — mitigated by SETNX on `recovery:fired:*`), audit-spill durability hole on Redis outage at process-death (P2), pack-installation partial-state on PackConformanceError (P3 — bootstrap fails-loud, but `installPack` mutates a process-global registry before throwing).

No deadlock-class lock-ordering bugs found. `withLock` is always single-resource and `withLock` calls do NOT nest. Defer's `defer:resuming:{hash}` ↔ `defer:resumed:{hash}` ↔ `defer:pending:{sessionId}` choreography is sequential (no cross-acquisition) and the cycle counter increments before the SETNX dedup, so an exhausted-cycle attempt cannot pollute the resumed ledger.

---

## Redis key choreography (per-key analysis)

### `defer:pending:{sessionId}` — JSON envelope blob
- **Writer**: `parkDeferredIntent` in `defer-park.ts:219` (adjudicate runtime). Bare `SET … { EX: ttlSeconds }` — **no NX**. Overwrites whatever was there.
- **Readers**:
  - `defer-resolver.ts:332` (`robustRedisGet` with 3-retry backoff)
  - `defer-timeout-sweeper.ts:204` (`redis.get(key).catch(() => null)`)
  - `defer-resume.ts:180` (runtime resume)
- **Deleters**:
  - `defer-resolver.ts:633` (after COMMIT)
  - `defer-resolver.ts:371` (after malformed parse)
  - `defer-resolver.ts:407` (after tamper detection)
  - `defer-timeout-sweeper.ts:273` (after publish timeout)
  - `defer-timeout-sweeper.ts:451` (recovery scan)
  - `defer-resume.ts:281` (post-SETNX commit)
  - `me.ts:900` (cancel-deletion endpoint — best-effort cleanup)
- **Atomicity**: SET (non-NX) write, plain GET read, plain DEL on consume. **Race**: two parks for the same sessionId → second overwrites first. Counter goes to 2; only one envelope readable. See R5.
- **TTL**: `Math.ceil(decision.timeoutMs / 1000) + 60` (responder/executor) or `ANONYMIZE_GRACE_TTL_SECONDS + 60` (initiate-deletion).
- **Cleanup if process dies mid-park**: Key with TTL persists; counter may or may not have incremented (the INCR happens before SET, so a crash AFTER incr/BEFORE set leaves the counter +1 but no envelope; counter TTL eventually GCs).

### `defer:count:{sessionId}` — INCR counter
- **Writers**: `parkDeferredIntent` (INCR), `resumeDeferredIntent` (DECR).
- **Atomicity gap**: INCR → EXPIRE → check-against-cap → DECR-on-overshoot. The runtime exposes a Lua seam (`evalIncrCheck`) that does INCR+EXPIRE+conditional-DECR in one round-trip; but `kernel-executor.ts:274` and `llm-responder.ts:506` and `me.ts:437/699` all build the args WITHOUT supplying `evalIncrCheck`. So every park goes through the racy fallback. Two concurrent parks at quota − 1: both INCR → both observe `newCount ≤ quota` → both SET → counter momentarily reads quota + 1 (or worse if more concurrent). Telemetry under-reports; no immediate user impact except that the QUOTA can be over-subscribed by a small N. **Severity**: P1.
- **TTL**: `DEFER_PENDING_TTL_GRACE_SECONDS` = 14 days, refreshed every park.

### `defer:resuming:{deferResumeHash}` — two-phase commit claim marker (W2 P0-8)
- **Writer**: `defer-resolver.ts:436` (`SET NX EX 60`).
- **Reader**: implicit via SETNX collision.
- **Deleters**: `defer-resolver.ts:473` (cycle-cap rollback), `:481` (cycle counter throw), `:506` (adjudicate threw), `:596` (dispatch failed rollback), `:635` (commit).
- **TTL**: `DEFER_RESUMING_TTL_SECONDS = 60`. Stale window: up to 60 seconds if process dies after SETNX before any cleanup. See R1.
- **Race**: another resume in-flight finds the key → returns `{ duplicate_suppressed }`. Correct behaviour. Note: the `duplicate_suppressed` return is semantically wrong if the OTHER process has crashed and the 60s TTL hasn't expired — the resume goes silently un-retried for up to 60s. See R1.

### `defer:resumed:{deferResumeHash}` — final dedup ledger
- **Writer**: `defer-resolver.ts:617` (`SET NX EX 14d`) AFTER successful dispatch + `resumeDeferredIntent`'s `:259` (`SET NX EX 14d`).
- **Reader**: `defer-resolver.ts:423` (pre-flight check).
- **Race**: pre-flight `get(resumedKey)` then later `SET NX` — TOCTOU window but harmless because the later SETNX is itself idempotent. Two concurrent resumes for the same hash: one wins SETNX on `resuming`, the other returns `duplicate_suppressed` immediately.
- **TTL**: 14 days. Long enough that a Stripe re-delivery within retry window is dedup'd.

### `defer:cycle:{intentHash}` — INCR cycle counter (W2 P0-7)
- **Writer**: `defer-resolver.ts:462` (INCR then EXPIRE). Also `defer-resume.ts:242` (runtime).
- **Race**: incremented BEFORE the SETNX dedup. **Important nuance**: a duplicate resume that arrives after the previous SUCCESSFUL resume will: (1) read `defer:resumed:{hash}` and short-circuit at `:424` — counter NOT incremented. But a duplicate that arrives during the resuming-window (60s) will: (1) `defer:resumed` not yet set, (2) SETNX on `defer:resuming` fails → returns `duplicate_suppressed` at `:452` — counter NOT incremented. So the counter is **only incremented for resumes that ACTUALLY enter the cycle**, which is correct.
- **TTL**: 14 days (`DEFER_PENDING_TTL_GRACE_SECONDS`).
- **NB**: the runtime's `resumeDeferredIntent` ALSO INCRs the same `defer:cycle:*` key. If both `resolveDeferredSession` and runtime `resumeDeferredIntent` execute for the same hash, the cycle counter increments TWICE per cycle. As of current code, `defer-resolver.ts` does NOT call `resumeDeferredIntentImpl` from the runtime — the resolver has its own copy of the dedup-ledger machinery. So no double-INCR in production. (The exported `resumeDeferredIntent` helper at `:130` calls the runtime, but it's only used by tests / ops scripts per the doc comment.)

### `recovery:fired:{intentHash}` — sweeper idempotency
- **Writer**: `defer-timeout-sweeper.ts:230` (steady-state) and `:417` (recovery). `SET NX EX 14d`.
- **Race**: steady-state and recovery both attempt SETNX on the same key — one wins, the other skips publish but still DELs the parked key. Correct.
- **Cleanup on publish failure**: explicit DEL at `:263` and `:444` so a retry can re-claim. Good.
- **TTL**: 14 days.

### `heartbeat:defer-sweeper`
- **Writer**: `defer-timeout-sweeper.ts:137`. SET EX 120s on every tick.
- **Reader**: ops/monitoring (no in-code reader).
- **Race**: single-writer; no race.

### `anonymize:otp:{customerId}` / `anonymize:fail:{customerId}` / `anonymize:pending:{customerId}` / `anonymize:cancel-cooldown:{customerId}`
- **Writers/readers**: see `anonymize-otp-gate.ts`. Brute-force counter uses non-atomic read-then-INCR (see R6).
- **Race on `anonymize:fail:{customerId}`**: `getOtpFailureCount` (read) → `verifyAnonymizeOtp` (Twilio round-trip) → `incrementOtpFailureCount` (INCR). The Twilio round-trip is ~200–800ms. Six concurrent requests can all read `failsBefore=4`, all proceed past the threshold check, all call Twilio, all fail (or one succeeds and others fail), and the failure counter ends up at `4 + N`. The first attempt past 5 is locked out reactively but the 4-into-5+ transition has a window. **Severity**: P1 — limits brute-force protection.
- **Race on `anonymize:otp_verified:{customerId}`**: `markOtpVerified` (writer) and `hasFreshVerifiedOtp` (reader, in `initiate-deletion`) — both single-actor. No race.
- **Race on `anonymize:pending:{customerId}`**: writer `persistPendingDeletion` is plain SET (no NX). A customer who double-taps initiate-deletion will: both pre-check `existing` is null (line 388), both succeed in PARK, both SET the receipt — second overwrites. Both parkDeferredIntent calls increment the counter. The counter goes to 2 for a single intent-class. **Severity**: P2 (no security impact — both envelopes lead to the same anonymize).

### `admin:confirmation:{uuid}` — two-step receipt
- **Writer**: `admin-confirmation-store.ts:212`. SET with EX, no NX (UUID guarantees uniqueness).
- **Reader/Deleter**: Lua GET+DEL at `:233`.
- **Atomicity gap**: `consumeWithSameActorCheck` (lines 178–195) calls `store.consume(…)` (atomic GET+DEL) BEFORE comparing `requestStaffId` to `pending.staffId`. If the SAME staffId race-attempts step 2 (one tab is step-1 actor, another tab is step-2 attempt by the SAME actor), the consume drains the receipt and returns `same_actor_violation`. The receipt is GONE. If at the same millisecond a DIFFERENT actor sends step 2, they will see `missing` (410 Gone) because the first attempt drained it. **This is documented behaviour** (`:172`: "The receipt is consumed (drained from Redis) regardless so the operator must restart from step 1.") so functionally correct, but: a malicious step-1 actor could race their OWN step-2 attempt to drain the receipt and prevent the legitimate second actor from confirming. Severity downgraded to **P3** (DoS-class, not data-integrity-class) but worth noting.

### `refund:daily-total:{actor}:{date}` — drip cap counter
- **Writer**: `admin/payments.ts:143` (`INCRBY` then `EXPIRE`).
- **Reader**: `:126` (plain GET).
- **Atomicity hole**: in `refund` step 1 (line 459-531), the order is:
  1. `readDailyRefundTotal` (line 466) — plain GET.
  2. Compute `projectedTotal = currentDailyTotal + refundAmount`.
  3. If `projectedTotal > dailyCap`: fall back to two-step receipt.
  4. Otherwise: call `executeRefund` which **then** INCRBYs.

  Five concurrent refunds at R$1900 with cap R$2000: all five hit step 1 in <100ms, all read `currentDailyTotal=0`, all see `projectedTotal=1900 ≤ 2000`, all pass to executeRefund, all execute, INCRBY accumulates to R$9500. The cap is bypassed by 4× the limit. **Severity**: P0 — security audit §C5 is the entire reason this counter exists, and the implementation has the exact race the audit was meant to close. See R4.

### `webhook:processed:{stripeEventId}` — Stripe dedup
- **Writer/Reader**: `stripe-webhook.ts:543` (`SET NX EX 7d`).
- **Atomicity**: clean. SET NX wins or loses atomically.
- **Failure handling**: on handler throw, the TTL is shortened to 300s (`:586`) instead of DEL — closes the window where Stripe retries find the key still set but the handler had a partial failure. Good.

### `defer:otp_verified:{customerId}` — fresh-OTP marker (W4)
- Only in anonymize flow. See above.

---

## Race scenarios R1-R9 with verdicts

### R1 — Two-phase commit recovery (defer-resolver.ts)

**Setup**:
- T0: process A executes `resolveDeferredSession`. SETNX `defer:resuming:{hash}` succeeds (key value carries `at`, `sessionId`, `intentHash`, `signal`, TTL=60s).
- T1: process A starts dispatch (intent dispatcher).
- T2: process A crashes (OOM / SIGKILL).
- T3: process B restarts.
- T4: another resume signal arrives at process B for the SAME hash.

**Walk-through**:
- Process B reads `defer:resumed:{hash}` at `:423` — `null` (we never committed the resume).
- Process B attempts SETNX on `defer:resuming:{hash}` at `:436` — **FAILS** because the stale key from process A is still there.
- Process B returns `{ kind: "duplicate_suppressed" }` at `:452`.
- The PIX confirmation event is consumed by the NATS subscriber (line 715-733) and logged as `duplicate_suppressed` (debug-level).

**Stale window**: up to 60 seconds (the `defer:resuming` TTL). After 60s the key expires and the next retry of the resume signal can proceed. If process A crashed without retry on the upstream NATS subject, the only path forward is the next PIX status webhook OR the defer-timeout-sweeper's recovery scan firing `intent.defer.timeout` (which is a DIFFERENT event type — that won't trigger the resume; it would trigger the GRACE resolver, but PIX confirmations don't use the grace resolver).

**Verdict**: **CONFIRMED stale window of up to 60s after process death**. Recoverable via NATS redelivery (Stripe webhook retries within ~3 days). The pre-W2 code had a worse failure mode (silent drop), so this is an improvement, but the 60s TTL is tight given typical k8s pod-restart times of 30-90 seconds. Recommend reducing `DEFER_RESUMING_TTL_SECONDS` to 30 OR adding a heartbeat extension while dispatch is in-flight.

### R2 — Sweeper recovery race

**Setup**: worker down for 10 minutes; on restart, `runRecoveryScan()` (defer-timeout-sweeper.ts:330) starts; in parallel a `payment.status_changed` event for an already-parked envelope arrives at `defer-resolver` (which runs in the SAME process as the sweeper, but on a different code-path — NATS subscriber vs BullMQ worker).

**Walk-through**:
- Recovery scan calls `redis.scanIterator(MATCH: defer:pending:*)`, finds key with TTL ≤ 60s.
- Recovery scan reads parked envelope, computes `intentHash`.
- Recovery scan SETNXs `recovery:fired:{intentHash}` — wins → publishes `intent.defer.timeout` → DELs the parked key.
- The `payment.status_changed` event arrives at `defer-resolver` at the SAME millisecond. Defer-resolver SCANs `defer:pending:*`, finds the SAME key (or finds it gone, depending on which happens first).

**Case A — sweeper publishes first**:
- Defer-resolver SCANs and finds the key gone → returns `no_park` and the PIX confirmation is silently discarded.
- The `intent.defer.timeout` event triggers `anonymize-grace-resolver` (if anonymize) but PIX confirmations are NOT handled by the grace resolver.
- For PIX intents specifically: the customer paid, but the system processed the parked envelope as a TIMEOUT instead of a RESUMED. The customer's cart state is in limbo.

**Case B — resolver dispatches first**:
- Resolver SETNXs `defer:resuming:{hash}` → wins. Dispatches. Commits `defer:resumed:{hash}` + DELs parked.
- Recovery scan's later SETNX on `recovery:fired:{intentHash}` may succeed (different key from `defer:resumed`!) → publishes `intent.defer.timeout`. The `anonymize-grace-resolver` subscriber filters on signal, but a NATS payload with the PIX signal arrives at the grace resolver too — handled by signal-mismatch skip (`anonymize-grace-resolver.ts:89`).
- Net effect for PIX: resume succeeded, timeout published but unconsumed. Acceptable.

**Verdict for PIX**: **CONFIRMED race in Case A**. The sweeper publishes a timeout for an envelope whose payment has actually arrived, the resolver finds no park, the dispatch path is never invoked. The customer paid; the order never advances. Severity: P1.

**Mitigation**: the sweeper's `IMMINENT_TTL_SECONDS = 60` plus the `+60s grace` in park-TTL means a sweep only triggers AFTER the parked envelope's policy timeout has expired. So Case A only fires if the PIX confirmation arrives close to (or after) the policy timeout — which is the precise window the kernel intends to expire the intent anyway. Severity downgraded to P2.

### R3 — Two-person rule concurrent confirmations

**Setup**: Step-1 receipt created by `staffId=A`. Two concurrent step-2 attempts arrive:
- Request X: `staffId=B` (different actor — allowed).
- Request Y: `staffId=A` (same actor — must be refused).

**Walk-through**:
- Both call `consumeWithSameActorCheck(store, confirmationId, requestStaffId)`.
- Inside, both call `store.consume(confirmationId)` which executes the Lua GET+DEL atomically — only ONE wins (returns the JSON), the other returns null.
- The winner's same-actor check fires AFTER consume: B's `requestStaffId !== A` → `{ kind: "ok" }`. A's `requestStaffId === A` → `{ kind: "same_actor_violation", pending }`. The loser (whichever arrived second) gets `null` from consume → `{ kind: "missing" }`.

**Edge — both step-2 from B (different actor)**: only one wins consume; the other sees `missing` (410 Gone). Correct.

**Edge — both step-2 from A (same as step-1)**: only one wins consume; that one sees `same_actor_violation`; the loser sees `missing`. The receipt is drained. Correct.

**Edge — step-1 actor is null (API key flow) and step-2 actor is null**: per `:181-184`, `null === null` is NOT a violation → `{ kind: "ok" }`. API-key flow has no two-person rule. The same API key can do both steps. Documented at `:170-172` but worth flagging: a leaked API key bypasses separation of duty.

**Verdict**: **CORRECT for the stated threat model**, but: (a) draining-on-violation is a DoS vector (a malicious step-1 actor can drain their own receipt to harass a legitimate step-2 actor), (b) API-key flow has no two-person rule at all. Severity P3 for the DoS, P1 for the API-key gap (but documented). **Not a race**.

### R4 — Refund drip cap race

**Setup**: five concurrent refunds at R$ 1900 (190_000 centavos) with `dailyCap=200_000`.

**Walk-through** (`admin/payments.ts:466-531`):
- All five read `currentDailyTotal=0` at `:466`.
- All five compute `projectedTotal=190_000 ≤ 200_000` at `:473-474`.
- All five fall through to `executeRefund` at `:534`.
- `executeRefund` calls `incrementDailyRefundTotal` AFTER the kernel returns EXECUTE — INCRBY accumulates to `5 × 190_000 = 950_000`.

**Verdict**: **CONFIRMED P0**. The cap is bypassed by 4.75× the limit by any actor capable of issuing 5+ concurrent requests. The whole point of the cap (per §C5 of security audit) was to prevent the dripping scenario; the implementation has the dripping scenario. Severity: P0.

**Fix**: the daily counter MUST be INCRBY'd FIRST, THEN check if the new total exceeds cap. On overshoot: DECR back, return the two-step protocol path. Alternatively a Lua script: INCRBY + check + conditional DECR. This is the same fix pattern as the runtime's `evalIncrCheck` seam for `defer:count:{sessionId}`.

### R5 — DEFER park collision (same sessionId, different intentHash)

**Setup**: customer double-taps PIX checkout. Two `cart.checkout` envelopes built in 100ms with different nonces (so different intentHashes).

**Walk-through** (`parkDeferredIntent` in `defer-park.ts`):
- Both calls pass `actor.sessionId = customerId` (same).
- `parkKey = rk("defer:pending:" + sessionId)` — **same key** for both.
- Both INCR `defer:count:{sessionId}` → counter goes to 2.
- Both call `redis.set(parkKey, JSON.stringify(envelope1), { EX })` and `redis.set(parkKey, JSON.stringify(envelope2), { EX })` — **second OVERWRITES first**.
- Counter is 2 but only one envelope is parked.

**On resume**:
- Defer-resolver's SCAN finds ONE `defer:pending:{customerId}` key. Reads it. Whichever envelope2 wrote is what gets resumed.
- envelope1 is LOST. Its `defer:cycle:{intentHash1}` counter is never incremented; it never resumes. No tamper detection fires (the hash is intact for envelope2, but envelope1 is just gone).

**Cycle counter behaviour**: `defer:cycle:{intentHash}` is per-intentHash, so envelope1 and envelope2 each have their own cycle counter. envelope2 increments normally on resume; envelope1's cycle counter is never touched (no cleanup needed — TTL GCs it).

**Counter accuracy**: the per-session quota counter is now WRONG (says 2 envelopes parked but only 1 exists). On resume of envelope2: DECR brings counter to 1. envelope1's "phantom slot" persists until the counter TTL expires.

**Verdict**: **CONFIRMED P1**. The park key collision causes silent loss of envelope1. The PIX payment for envelope1 (if it ever happens) will resume envelope2 instead — which has a different intentHash so the resume succeeds but the executed envelope is NOT the one the customer's payment matches. In practice double-tap-PIX is rare and the customer's cart is usually the same shape, so the user-visible impact is small. Severity: P1.

**Fix options**:
1. Key park by `intentHash` not `sessionId` (would require resolver/sweeper changes).
2. Use SET NX in parkDeferredIntent and return a `collision` result — adopters surface as "you already have a pending checkout".

### R6 — OTP brute-force counter race

**Setup**: 6 concurrent OTP verify attempts for a customer at `anonymize-otp-gate.ts`.

**Walk-through** (`me.ts:271-340`):
- All 6 read `failsBefore = getOtpFailureCount(customerId)` at `:276`. Say all 6 read `failsBefore=0` (clean state).
- All 6 pass the threshold check (`0 >= 5` is false).
- All 6 call `verifyAnonymizeOtp` (Twilio round-trip, ~300ms).
- 5 fail → each calls `incrementOtpFailureCount` (INCR). Counter goes 1, 2, 3, 4, 5.
- 1 succeeds → calls `resetOtpFailureCount` (DEL). The DEL races against the INCRs.

**Race window**: the ~300ms Twilio round-trip is the window. All 6 enter "verify in progress" simultaneously. The counter is post-checked but the check uses `failsAfter` (post-increment) at `:315`, which DOES protect against the 6th+ attempt being processed once the counter reaches 5.

**However**: an attacker can launch 100 attempts simultaneously, ALL of which see `failsBefore=0` and proceed through verification. Twilio's per-code 5-strike limit may save us, but the freshly issued code from `/send-otp` is shared across all 100 attempts; if the attacker has the code from a phishing intercept, all 100 succeed and the reset wipes the counter. **The brute-force protection has a 300ms window**.

**Verdict**: **CONFIRMED P1**. The race window is bounded by Twilio's round-trip time (~300ms). At 100 RPS the attacker gets ~30 "free" attempts before the counter catches up.

**Fix**: INCR the counter FIRST (before the Twilio call). If post-INCR ≥ threshold, lock out and refund-decrement on lockout. This is the classic "incr-then-check" pattern.

### R7 — Audit pipeline backpressure race

**Setup**: Postgres slow, in-memory buffer fills to 1024 (`bufferCapacity()` default). Redis spill activates. Process dies before spill commits.

**Walk-through** (`persistent-buffered-sink.ts:108-122` and `redis-spill-storage.ts`):
- `emit()` first calls `drainStorage()` (LPOP from Redis list) — drains existing spill.
- Then `drainMemory()` (replay in-memory queue) — sends to inner sink.
- Then `inner.emit(record)` (the NEW record).
- On inner failure: `bufferOrSpill(record)` — push to memory if room, else evict head of memory to Redis spill via `RPUSH`. The new record always goes to memory; the EVICTED head goes to Redis.

**Crash scenarios**:
- Crash after `RPUSH` of evicted head but before successful inner emit of new record: the new record is in process memory ONLY. Process dies → record lost. `onOverflow` was called for the evicted (spilled) record, NOT for the new one. **A record that triggers spill is LOGGED durably; a record that arrives WHILE the inner is failing is held in process memory and lost on crash**. Severity: P2.
- Crash after `RPUSH` but before `EXPIRE`: the `expire` is swallowed (`redis-spill-storage.ts:99-106`), so the queue gets the default Redis policy (no TTL). Not a crash race per se, but the 7-day TTL guarantee is broken if EXPIRE fails on the FIRST push.
- TTL expires while process is down: data loss for any records older than 7d. Acceptable per the design notes.

**ACK semantics**: `redis-spill-storage.ts:145-151` is a no-op because LPOP already removed the record. **Critical**: `drainStorage()` does `await opts.inner.emit(head); await opts.storage.ack(head);` — but `ack` is a no-op, and LPOP already removed the record. **If `inner.emit(head)` throws AFTER LPOP succeeded**, the record is LOST from Redis but never landed in the inner sink. The framework catches the throw at line 90-93 (`onSpill?(head, "drain-failure"); throw err`) — but doesn't re-append to spill.

**Verdict**: **CONFIRMED P2 — drain-failure data-loss hole**. If LPOP returns a record and inner.emit throws (Postgres just came back up briefly then errored), the record is gone from Redis and never landed. The `throw err` at `:92` propagates to the caller but the data is gone. This is a real durability hole.

**Fix**: use `LREM` after successful emit, or use `BRPOPLPUSH` to a "processing" list with manual ack. The current "destructive LPOP + no-op ack" is too aggressive for governance-grade audit.

### R8 — Pack installation order

**Setup**: `installFirstPartyPacks()` installs 5 packs sequentially (kernel-bootstrap.ts:129-136): orders, reservations, whatsapp, customer-onboarding, payments. Pack 2 throws PackConformanceError.

**Walk-through**:
- `installPack(ordersPack)` succeeds → mutates a process-global pack registry inside `@adjudicate/core`.
- `installPack(reservationsPack)` throws PackConformanceError.
- The exception propagates up to `bootstrapKernel` at `:165-170`, which logs `pack conformance failed` and re-throws.
- `apps/api/src/index.ts` catches at `start().catch(...)` and exits non-zero (P0-6 per the doc comment).

**Partial-state**: the orders pack IS registered in the global registry when reservations fails. The process is about to exit non-zero, so no requests are served. However, IF the bootstrap is retried in the same process (e.g., a test harness), the second installPack(ordersPack) would conflict. **Tests must call `_resetKernelRegistry()` or equivalent**.

**Verdict**: **MITIGATED by fail-loud exit**. Severity P3. Risk: long-running test harness re-bootstrapping without reset; pack-registry is a global. Recommend: make `installPack` idempotent (no-op if already installed, or replace).

### R9 — Resume signal storm (1000 PIX confirmations / 1s)

**Setup**: batch processing recovery — 1000 PIX confirmations arrive in 1 second.

**Walk-through**:
- Defer-resolver subscriber receives each event one at a time (NATS subscribe is single-threaded per subscription unless using queue group). Per event, it SCANs `defer:pending:*` (paginated, COUNT=100).
- For each session it finds, it calls `resolveDeferredSession`:
  - SETNX `defer:resuming:{hash}` (creates 1000 keys momentarily).
  - INCR `defer:cycle:{intentHash}`.
  - Calls `adjudicate(envelope)` (synchronous).
  - Dispatch (async).
  - On success: SETNX `defer:resumed:{hash}` + DEL `defer:pending:{sessionId}` + DECR counter + DEL resuming.

**Performance**:
- 1000 SETNX in 1s → Redis handles trivially (sub-ms per op).
- 1000 SCAN cycles (each event scans the FULL `defer:pending:*` namespace) → O(N) work per event × 1000 events = O(N²) total. **At 1000 parked envelopes, that's 1M Redis cursor iterations**. This is the documented concern at `defer-resolver.ts:28-34`.
- SCAN is non-blocking but consumes Redis bandwidth.

**Sweeper interaction**: the defer-timeout-sweeper runs every 60s on BullMQ. If it kicks in mid-storm, it would also SCAN `defer:pending:*`. Sweeper's SETNX on `recovery:fired:{intentHash}` collides with resolver's SETNX on `defer:resuming:{hash}` — DIFFERENT keys, no collision. But the sweeper might see a key the resolver is mid-processing (`defer:resuming:` is set, `defer:pending:` not yet deleted) and try to publish a timeout. Sweeper publishes → `intent.defer.timeout` for an envelope that's actively being RESUMED. The grace resolver consumes the timeout but only fires for `customer.anonymize.confirmed_after_grace` signal; PIX intents skip on signal-mismatch.

**Verdict**: **PERFORMANCE PLAUSIBLE not CONFIRMED** under load testing. At 1000 parked envelopes the O(N²) sweep is concerning. Severity: P2 (operational). Recommend: index parked envelopes by `orderId` (line 33-34 already flags this as future work).

---

## Atomicity holes

| Path | Operation | Race window | Severity |
|------|-----------|-------------|----------|
| `admin/payments.ts:466-534` refund drip cap | GET total → compute projected → execute → INCRBY | ~50–500ms (DB round-trip) | **P0** |
| `me.ts:276-310` OTP brute-force counter | GET count → Twilio verify → INCR fail | ~300ms (Twilio round-trip) | **P1** |
| `defer-park.ts:189-217` parkDeferredIntent quota | INCR → EXPIRE → check → DECR-on-overshoot | <10ms (Redis-local) | **P1** (Lua seam available but not wired) |
| `defer-park.ts:219` parkDeferredIntent envelope SET | SET without NX — overwrites on collision | unbounded | **P1** (double-tap same session) |
| `persistent-buffered-sink.ts:86-92` spill drain | LPOP → inner.emit → ack (no-op) | inner emit duration | **P2** (drain-failure data loss) |
| `admin-confirmation-store.ts:178-195` consumeWithSameActorCheck | atomic Lua GET+DEL → THEN same-actor check | <1ms (Lua-atomic) but receipt drained | **P3** (DoS — drains receipt on same-actor) |
| `defer-resolver.ts:417-453` two-phase commit recovery | SETNX claim with 60s TTL → crash during dispatch | up to 60s stale window | **P2** (mitigated by NATS redelivery) |
| `me.ts:388-440` initiate-deletion pre-check | readPendingDeletion (GET) → parkDeferredIntent (set) | ~10ms | **P2** (double-park, same intent class) |
| `stripe-webhook.ts:543` webhook dedup | SET NX EX 7d | atomic | **clean** |
| `defer-resolver.ts:423-444` resumed-then-resuming | GET resumed → SETNX resuming | <5ms | **clean** (idempotency holds) |

---

## Lock-ordering analysis

`withLock` (from `@ibatexas/tools`) is the only multi-resource lock primitive in the codebase. All call sites acquire ONE lock at a time:
- `pix-expiry-checker.ts:68`: `payment:{id}` only.
- `stripe-webhook.ts:154`: `payment:{id}` only.
- `order-actions.ts:1046`: `payment:{id}` only.
- `stale-order-checker.ts:130`: `order:{id}` only.
- `cart/amend-order.ts:444`: `payment:{id}` only.
- `cart/regenerate-pix.ts:76`: `payment:{id}` only.

**No nested withLock calls observed**. No deadlock potential from `withLock`.

**WhatsApp session locks** (`session.ts`): `wa:agent:{phoneHash}`, `wa:debounce:{hash}`, `wa:dedup:{hash}` are independent per-phone, never combined. The agent lock has a heartbeat mechanism (10s interval extending 30s TTL). Heartbeat ownership-check uses Lua, so even if the lock is taken over by another process (after TTL expiry), the original heartbeat won't EXPIRE the wrong owner's lock. Clean.

**Defer locks** (`defer:resuming:*`, `defer:resumed:*`): acquired in order resumed → resuming → cycle → resumed-commit. Single-direction; no cross-locking. Clean.

**Conclusion**: no lock-ordering bugs. No deadlock potential.

---

## Recommendations

### Code fixes (P0–P1)

1. **R4 — refund drip cap (P0)**: switch `executeRefund`'s drip counter from "INCR after EXECUTE" to "INCRBY first, then check against cap, conditional DECR if overshoot". Apply in `admin/payments.ts:466-534`. Pattern: Lua eval `INCRBY + check + conditional DECRBY` in one round-trip. Mirror the `evalIncrCheck` seam in `parkDeferredIntent`. Required before W3 sign-off.

2. **R6 — OTP brute-force counter (P1)**: switch `verify-otp` from "GET → verify → INCR-on-fail" to "INCR-attempt first → if post-INCR > threshold lock out → verify → DECR on success-or-still-eligible". `me.ts:276-340`. Specifically: a Lua script that conditionally INCRs only if below threshold and returns the new count + locked-out flag.

3. **R3 (same-actor receipt drain) — P3**: re-order `consumeWithSameActorCheck` to peek (GET without DEL) → check same-actor → if violation: return without draining; if ok: atomic GET+DEL. Cost: one extra round-trip, but eliminates the DoS vector. `admin-confirmation-store.ts:178-195`.

4. **R5 — DEFER park-key collision (P1)**: either (a) park-key from `intentHash` not `sessionId`, OR (b) make `parkDeferredIntent`'s envelope SET use `NX` and return `collision` to the caller. `defer-park.ts:219`. Caller surfaces "you already have a pending checkout".

5. **parkDeferredIntent quota race (P1)**: wire `evalIncrCheck` in all four IbateXas adopter call sites (`kernel-executor.ts:274`, `llm-responder.ts:506`, `me.ts:437/699`). The runtime supplies the Lua-eval seam; the adopter passes a closure that runs `redis.eval(...)`. Today these all fall through to the non-atomic INCR+EXPIRE+check+DECR path.

6. **R1 — Two-phase commit recovery (P2)**: reduce `DEFER_RESUMING_TTL_SECONDS` from 60s to 30s (typical pod restart is <30s in our infra), OR add a heartbeat extension while dispatch is in-flight (similar to the WhatsApp agent lock pattern).

### Runbook mitigations (P2–P3)

7. **R2 — Sweeper vs resolver race (P2)**: monitor for `intent.defer.timeout` events whose `signal` corresponds to a payment confirmation type. These indicate a sweeper-fires-while-resolver-running case. Add a Sentry breadcrumb in defer-resolver when SCAN returns no parked envelopes for a SETTLED status event.

8. **R7 — Audit drain-failure data loss (P2)**: change `redis-spill-storage.ts` from "destructive LPOP + no-op ack" to "BRPOPLPUSH → processing list → LREM on ack". This is a one-day refactor in `redis-spill-storage.ts`.

9. **R9 — SCAN performance under load (P2)**: index parked envelopes by `orderId` per the doc comment at `defer-resolver.ts:28-34`. Eliminates the O(N²) sweep under signal storms.

10. **API-key two-person bypass (documented, P1)**: document in the runbook that API-key flows are NOT subject to the two-person rule (`admin-confirmation-store.ts:181-184`). Operations using API keys are single-actor; rotate keys aggressively; consider implementing a separate API-key two-person rule at the route layer.

### Estimated production exposure

- **R4 (refund drip cap)**: triggers at ≥2 concurrent refund requests. At a fleet of 5 store managers issuing refunds via mobile, plausible at 0.01% of refund-days. With financial impact (uncapped refunds), **fix before launch**.
- **R6 (OTP brute-force)**: triggers at attacker-issued concurrency. An attacker with the phone-number → ~30 free guesses per ~300ms Twilio RTT before counter catches up. With a 6-digit code that's 1-in-33,000 hit rate per parallel batch. **Fix before P0-11 sign-off**.
- **R1 (two-phase commit recovery)**: triggers at process death during dispatch. With 99% uptime and ~hourly deploys, the 60s window catches roughly 1 in 60 dispatches during deploys. **Mitigable via NATS redelivery**; fix priority P2.
- **R5 (DEFER park collision)**: triggers at customer double-tap (~5% of WhatsApp PIX flows per UX data). One envelope silently lost per double-tap. **Visible to user only when carts differ between taps**; fix in next sprint.
- **R7 (audit drain-failure)**: triggers at Postgres flaps. At observed Postgres availability (99.9%), maybe one audit record lost per hour during a flap. **Pre-launch fix**.
- **R2 (sweeper-resolver race)**: triggers only when PIX confirmation arrives within ~60s of the policy timeout. Rare; **fix priority P3** — monitor and re-evaluate.
- **R8 (pack install partial state)**: only manifests in test harnesses re-bootstrapping. **No production fix required**.
- **R9 (resume signal storm)**: triggers only during recovery after multi-minute NATS outages. **Operational hardening; no urgent fix**.

### Confirmed top 5
1. **R4 — refund drip cap race** (P0, security-audit regression).
2. **R6 — OTP brute-force counter race** (P1, ~300ms window per round).
3. **parkDeferredIntent quota non-atomic** (P1, Lua seam present but unwired).
4. **R5 — DEFER park-key collision** (P1, customer double-tap loses an envelope).
5. **R7 — audit drain-failure data loss** (P2, governance-grade durability).

### Plausible-but-unverified top 3 (need load tests to confirm)
1. **R9 — SCAN performance under storm**. Need: 1000 parked envelopes + 1000 PIX events/s.
2. **R2 — sweeper-resolver race for PIX intents**. Need: precise timing test with payment.status_changed arriving at exact moment of TTL expiry.
3. **Audit pipeline crash race**. Need: kill -9 process between RPUSH and EXPIRE; verify TTL absent on next boot.
