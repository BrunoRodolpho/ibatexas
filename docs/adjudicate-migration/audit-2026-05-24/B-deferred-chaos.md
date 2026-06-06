# Deferred workflow chaos audit — 2026-05-24

## TL;DR

**5 bugs found.** Two P0 (production-impacting today), two P1 (latent / known-but-undocumented as bugs in code), one P2 (forward hazard).

| # | Severity | Title | File |
|---|---|---|---|
| 1 | **P0** | NX-park wrapper is **dead code** — three production hot paths call `parkDeferredIntent` directly and silently overwrite collisions | `packages/llm-provider/src/{kernel-executor,llm-responder}.ts`, `apps/api/src/routes/me.ts` |
| 2 | **P0** | Timeout sweeper races with in-flight resume — both fire; no mutex on `defer:resuming` | `apps/api/src/jobs/defer-timeout-sweeper.ts` (no check), `apps/api/src/subscribers/defer-resolver.ts` |
| 3 | **P1** | Resume of kernel-covered tools (`create_checkout`, `add_to_cart`, …) is silently dropped — commits durable ledger without executing the mutation | `apps/api/src/adapters/resume-dispatcher.ts:134-152` |
| 4 | **P1** | `intent.defer.timeout` has no PIX-side consumer — PIX park expiry silently swallows the customer notification | `apps/api/src/subscribers/anonymize-grace-resolver.ts` is the **only** subscriber; PIX/non-anonymize timeouts have no fan-out |
| 5 | **P1** | NX-wrapper park-throw still leaks the per-session quota counter — W6 finding unfixed | `apps/api/src/adapters/park-deferred-intent-nx.ts:162-168` |

The W7-P0-7-TRUE NX wrapper, the D2 G3-hoist fail-loud, and the P0-8 two-phase commit are all **structurally correct in isolation** — they protect the wrapper's call sites. But the production hot paths never call the wrapper. Net effect: the protection is on paper only.

---

## Bug 1 — NX-park wrapper is dead code on production hot paths

**Severity:** P0
**File:** `packages/llm-provider/src/kernel-executor.ts:20,221`; `packages/llm-provider/src/llm-responder.ts:22,460`; `apps/api/src/routes/me.ts:50,459,727`
**Class:** Race / Park collision

**Scenario:** A customer in a single WhatsApp session emits two PIX-deferred actions back-to-back (e.g., orders an item, then while PIX is pending tries to add another item that also requires PIX confirmation). Both call `adjudicate()` → DEFER. Both DEFER paths call `parkDeferredIntent` (the framework primitive) — NOT `parkDeferredIntentWithNxGuard`. The framework's `redis.set(parkKey, ..., { EX: ttlSeconds })` at `adjudicate/packages/runtime/src/defer-park.ts:219` has **no NX flag**, so the second park silently overwrites the first parked envelope. The first envelope's resume target is destroyed; the customer's first action never resumes when PIX confirms.

**Code path traced:**
- `apps/api/src/adapters/park-deferred-intent-nx.ts` exports `parkDeferredIntentWithNxGuard` (the SETNX-guarded wrapper that the W7-P0-7-TRUE commit added to fix exactly this).
- Grep `parkDeferredIntentWithNxGuard` outside the adapter itself and tests: **zero hits** (verified at the top of this audit).
- Grep `parkDeferredIntent` in production source (excl. tests/dist): hits in
  - `packages/llm-provider/src/kernel-executor.ts:221`
  - `packages/llm-provider/src/llm-responder.ts:460`
  - `apps/api/src/routes/me.ts:459` (anonymize OTP gate)
  - `apps/api/src/routes/me.ts:727` (anonymize via gateway)
- Each of these constructs the args manually and bypasses the wrapper.
- Framework primitive at `adjudicate/packages/runtime/src/defer-park.ts:219`: `await args.redis.set(parkKey, ..., { EX: args.ttlSeconds })` — **no NX**. Verified in source.

**Why it's broken:** The W7 documentation calls the NX wrapper "the fix"; the W6 red-team coverage tests against it. But the actual production DEFER emission sites import the unwrapped framework primitive. Adopter-side protection is on paper only.

Secondary issue: the D2 G3 fail-loud refuse (`ParkVerificationFieldsMissingError`) lives inside the wrapper too — meaning any drift in hoist completeness on the hot-path callers would silently produce blobs that `verifyParkedEnvelopeHash` reports as `verified: null`, landing in the framework's back-compat "warn" branch and disabling tamper-at-rest detection. The hot path callers DO hoist correctly today (kernel-executor.ts:222-232, llm-responder.ts:461-470, me.ts:460-469, me.ts:728-736) so this is currently latent, but every new caller is a regression surface.

**Suggested fix:** Swap `import { parkDeferredIntent } from "@adjudicate/runtime"` for `import { parkDeferredIntentWithNxGuard } from "<adapter-path>"` in the four call sites; surface the `collision` reason to the caller's refusal builder so the customer sees `PARK_COLLISION_REFUSAL_PT_BR` instead of a silent overwrite. The wrapper handles quota_exceeded fall-through correctly already.

---

## Bug 2 — Timeout sweeper races with in-flight resume; both fire; no mutex

**Severity:** P0
**File:** `apps/api/src/jobs/defer-timeout-sweeper.ts:199-303`; `apps/api/src/subscribers/defer-resolver.ts:318-744`
**Class:** Race / Concurrent dispatch

**Scenario:** At T = TTL - 0.5s (just inside the sweeper's 60s `IMMINENT_TTL_SECONDS` window), the PIX confirmation NATS event arrives:

1. Sweeper runs SCAN of `defer:pending:*`, finds the key with TTL <= 60s.
2. Concurrently, defer-resolver receives the `payment.status_changed` NATS event, SCANs the same namespace, finds the same key.
3. Sweeper reads the blob (`raw = await redis.get(key)`), SETNX-claims `recovery:fired:{intentHash}`, publishes `intent.defer.timeout`, DELs the parked key.
4. Resolver in parallel calls `robustRedisGet(rawKey)` — succeeds (key was still alive when GET hit the wire), parses the parked envelope, SETNX-claims `defer:resuming:{deferResumeHash(intentHash, signal)}` (different key — no collision), increments cycle counter, calls `adjudicate(...)` → EXECUTE, calls `_dispatcher(...)` to actually run the order action, sets `defer:resumed:{...}`, DELs the (already-gone) parked key.

**Net result:** the resolver dispatches the intent (order is confirmed; downstream side effects fire) AND the sweeper publishes `intent.defer.timeout` (anonymize-grace-resolver ignores it because of signal mismatch, but a future PIX-timeout consumer would dispatch a "your PIX expired" notification to the same customer whose order just succeeded). For the LGPD anonymize signal where they overlap (sweeper publishes anonymize-signal timeout while resolver is mid-resume), this triggers **double-execution of the destructive operation** (anonymize-grace-resolver.ts:114 calls `anonymizeCustomer(customerId)`).

**Code path traced:**
- `defer-timeout-sweeper.ts:230-258`: SETNX `recovery:fired:{intentHash}` is the **only** mutex the sweeper checks. It is keyed by intentHash, NOT by `deferResumeHash(intentHash, signal)`.
- `defer-resolver.ts:464-465`: resolver writes `defer:resuming:{deferResumeHash(intentHash, signal)}` and `defer:resumed:{deferResumeHash(intentHash, signal)}` — different namespaces, no overlap with `recovery:fired:*`.
- Sweeper grep for `defer:resuming` or `defer:resumed`: **zero hits in `defer-timeout-sweeper.ts`** (verified). The sweeper does not check whether the resolver is mid-flight, and the resolver does not check whether the sweeper has already published a timeout.
- Tests at `apps/api/src/jobs/__tests__/defer-timeout-sweeper.test.ts`: grep for `resuming`/`resumed`/`race`/`concurrent`/`in-flight` → **zero hits**. No test coverage for this race.

**Why it's broken:** Two-phase commit at the resolver and idempotency at the sweeper were designed independently. Neither knows about the other's lock namespace. The TTL-floor crossing (60s of `IMMINENT_TTL_SECONDS`) is the entire race window; for parked envelopes with timeoutMs near the customer's actual PIX expiry (commonly 5-30min), the chance of an aligned arrival is non-trivial.

**Suggested fix:** Either (a) sweeper checks `defer:resuming:{deferResumeHash(intentHash, signal)}` before DEL + publish (skip if in-flight); or (b) wrap the sweeper's `recovery:fired:*` SETNX to also check whether `defer:resumed:{hash}` exists for any signal of this intent (more expensive — need a SCAN by intentHash). Option (a) is the minimal-blast-radius fix. Tests should add a deliberate-collision case: park with TTL 30s, fire both resume signal and sweeper concurrently, assert dispatcher is called exactly once AND `intent.defer.timeout` is NOT published.

---

## Bug 3 — Resume of kernel-covered tools is silently dropped

**Severity:** P1
**File:** `apps/api/src/adapters/resume-dispatcher.ts:134-152`; `packages/llm-provider/src/intent-dispatcher.ts:108-126`
**Class:** Replay / Orphan execute

**Scenario:** A customer initiates `create_checkout` for a PIX-paid order. Kernel returns DEFER (PIX pending). Envelope is parked with `payload.toolName = "create_checkout"`. Hours later, PIX confirms; resolver fires; resume-dispatcher translates the parked envelope into a `ToolIntent`; underlying dispatcher checks `DETERMINISTIC_KERNEL_COVERAGE` (which includes `create_checkout`); returns `{kind: "skipped", reason: "deterministic_kernel_covers"}`. resume-dispatcher.ts:142-152 logs and returns void — **no throw**.

Back in defer-resolver.ts:618: `dispatched = true`, no error. The COMMIT path at lines 717-736 then sets `defer:resumed:{hash}` durable ledger, deletes the parked key, DECRs the counter. The next resume signal delivery sees the durable ledger and short-circuits — **the checkout never executes**. The customer's payment confirms but the order stays in pre-checkout state forever.

**Code path traced:**
- `intent-dispatcher.ts:108-126`: `DETERMINISTIC_KERNEL_COVERAGE` includes `add_to_cart`, `update_cart`, `remove_from_cart`, `get_or_create_cart`, `create_checkout`, `cancel_order`, `regenerate_pix`. Any of these in a parked envelope's `payload.toolName` produces `skipped`.
- `intent-dispatcher.ts:208-220` (verified by reading the dispatcher coverage check): if `coverage.has(intent.toolName)` returns `{ kind: "skipped", reason: "deterministic_kernel_covers" }`.
- `resume-dispatcher.ts:134-152`: explicit comment: "the mutation is silently dropped — the audit record + the subscriber log together are the trail. This is the expected outcome for `order.checkout.create` resumes until task 22 plumbs a resume-side kernel executor."
- The deferred-resolver has no handling for "skipped" — it never sees a `skipped` result because the resume-dispatcher returns void. There is no signal to differentiate "executed" from "skipped" from "failed" at the resolver level.

**Why it's broken:** The resume path lacks a kernel-executor parallel. The hot-path LLM responder hands EXECUTE off to the deterministic kernel-executor (via XState machine actions); the resume path doesn't reconstruct that state, so the dispatcher's skipped branch is the only outcome for the most common parked intent kinds (checkout, cart-add). The audit log shows EXECUTE but no mutation actually fires.

**Suggested fix:** Documented as "task 22". Until then, treat `skipped` on the resume path as a DLQ outcome (fail closed) so ops sees it. Alternatively, route the resume-dispatched intent through the kernel-executor path with a synthesized OrderContext (which is the task 22 design). The current comment-only acknowledgement is operationally inert — there is no alert that fires when this skip happens in production.

---

## Bug 4 — `intent.defer.timeout` has no PIX/non-anonymize consumer

**Severity:** P1
**File:** `apps/api/src/jobs/defer-timeout-sweeper.ts:262-272` (emitter); `apps/api/src/subscribers/anonymize-grace-resolver.ts:147-151` (only subscriber)
**Class:** Orphan / Notification gap

**Scenario:** A customer makes a PIX-paid order. The kernel DEFERs. The customer never pays. The park TTL expires. Sweeper publishes `intent.defer.timeout` with `signal = "payment.confirmed"`. anonymize-grace-resolver sees the event, filters on `event.signal !== CUSTOMER_ANONYMIZE_GRACE_SIGNAL`, returns `{kind: "skipped", reason: "signal_mismatch"}`. **No other subscriber exists.** The customer's WhatsApp conversation stays in "Estou aguardando confirmação..." indefinitely — exactly the failure mode the sweeper's own header (`defer-timeout-sweeper.ts:6-7`) warns about.

**Code path traced:**
- Sweeper at lines 262-290: publishes `intent.defer.timeout` for ALL parked envelopes whose TTL <= 60s, not just anonymize.
- `grep -rn "subscribeNatsEvent.*intent.defer.timeout"`: only `anonymize-grace-resolver.ts:147`. Verified.
- `anonymize-grace-resolver.ts:89-91`: filters `event.signal !== CUSTOMER_ANONYMIZE_GRACE_SIGNAL` → returns skipped.
- No PIX-timeout subscriber. No generic timeout-notification subscriber. No analytics fanout.

**Why it's broken:** The sweeper was built generically (publishes for any signal), but the consumer fan-out was only wired for one signal. The pre-fix comment block claims "send the customer-facing notification. That's a separate subscriber" — but that subscriber was never implemented for PIX. The deep-audit task ledger calls this out under D1 ("notification.send blocked on lastCustomerMessageAt state-builder") but the audit-2026-05-23 SYNTHESIS lists it as Bucket G (architectural follow-up) — not a P0/P1 bug.

**Suggested fix:** A simple `pix-timeout-resolver` subscriber that filters on `event.signal === PIX_CONFIRMATION_SIGNAL` and either: (a) publishes a WhatsApp follow-up via the existing notification path; or (b) just emits a structured analytics event. Either is far less work than building the full `lastCustomerMessageAt` state-builder D1 is gated on; the analytic-only path is ~10 lines and would at least surface the orphan state to dashboards.

---

## Bug 5 — NX-wrapper park-throw still leaks the quota counter (W6 finding still open)

**Severity:** P1 (was flagged as P2 by W6; promoted because the wrapper IS being used in tests and may be turned on in production via fix for Bug 1)
**File:** `apps/api/src/adapters/park-deferred-intent-nx.ts:162-168`
**Class:** Orphan / Quota leak

**Scenario:** Wrapper SETNX-claims `defer:pending:{sessionId}` (placeholder). Delegates to `parkDeferredIntent`. The framework primitive INCRs `defer:count:{sessionId}` (line 190 of `defer-park.ts`), runs EXPIRE, then calls `redis.set(parkKey, ..., {EX})` at line 219. If the SET throws (Redis network blip after the INCR), the framework's INCR is NOT rolled back (rollback only happens on the "quota_exceeded" branch at lines 197-216, not on a thrown exception). The wrapper's catch block at lines 162-168 only deletes the parkKey placeholder; it does NOT DECR `defer:count:{sessionId}`. **A quota slot is leaked.** Each thrown-mid-park monotonically decreases the effective per-session quota.

**Code path traced:**
- `park-deferred-intent-nx.ts:162-168`:
  ```ts
  } catch (err) {
    await (argsHoisted.redis as { del?: ... }).del?.(parkKey)?.catch(() => {})
    throw err
  }
  ```
  No DECR on counter key. Verified.
- `adjudicate/packages/runtime/src/defer-park.ts:190-219`: INCR at line 190, EXPIRE at 195, quota-check at 197, SET at 219. Throw between 195 and 219 leaves the counter incremented with no rollback.
- `apps/api/src/__tests__/wave6-red-team/04-park-nx-placeholder-window.test.ts:91-125`: documents this exact behaviour ("HAZARD: when framework park throws AFTER counter INCR, wrapper cleans up the placeholder but NOT the counter") — but only as a documentation pin; no fix landed. The W6 red-team's recommendation at lines 128-138 was never actioned.

**Why it's broken:** A retried network failure on the SET is the most common transient cause of a thrown park. Over time, a customer with intermittent Redis connectivity (or in a region with high tail latency to the Redis cluster) accumulates phantom quota usage. The counter has a TTL fallback (14d) so eventually it clears, but within the TTL window the customer hits "Você tem muitas operações em espera" refusals when the actual park slot is empty.

**Suggested fix:** Either (a) in the wrapper's catch block, additionally `await redis.decr?.(rk(deferCounterKey(sessionId)))?.catch(()=>{})` (deferCounterKey is exported from `@adjudicate/runtime`); or (b) push the rollback into the framework primitive itself (out of repo scope per the W7 brief). (a) is the minimal change. Note Bug 1 must be fixed first or this fix is dead-code too.

---

## Methodology / clean surfaces

### Verified safe
- **G3 hoist (D2)** — the hoist for `version/nonce/taint` at `park-deferred-intent-nx.ts:208-239` is correct: all four fields are asserted, missing fields throw `ParkVerificationFieldsMissingError` before any Redis write. Resume-side fail-loud refuse at `defer-resolver.ts:433-461` matches. **But only inside the wrapper** — see Bug 1.
- **Two-phase commit (P0-8)** — defer-resolver.ts:464-744 correctly orders: SETNX resuming → increment cycle → adjudicate → audit → dispatch → SETNX resumed → DEL pending → DECR count → DEL resuming. The pre-dispatch SETNX dedup at line 478-506 (resumedGetResult) correctly handles transient Redis errors with retries. Dispatch failure leaves the parked key intact (`defer-resolver.ts:690-699`).
- **Robust Redis GET (P1-D)** — `defer-resolver.ts:256-292`: 3-retry with exponential backoff (50/100/200ms), distinguishes missing from error. The transient_error result properly DLQs. Tests at lines 690-721 of `defer-resolver.test.ts` verify.
- **Cycle cap (T5)** — both the framework's `defer-resume.ts:239-257` and the adopter's `defer-resolver.ts:536-560` independently enforce `DEFAULT_MAX_RESUME_CYCLES = 3`. Belt-and-braces. The adopter's check fires BEFORE adjudicate to prevent a runaway re-DEFER chain.
- **Boot-window race (NEW-P0-X1)** — `defer-resolver.ts:641-672`: a null dispatcher on the EXECUTE branch now DLQs and leaves park intact, instead of pre-fix silently committing.
- **Tamper-at-rest verification** — `verifyParkedEnvelopeHash` derives via `sha256Canonical` of the canonical envelope shape; the resolver fail-closes on `verified === false` AND `verified === null` (post-G3 hoist).
- **Recovery scan (P1-E)** — `defer-timeout-sweeper.ts:351-517`: on worker startup, scans for past-deadline parks and publishes timeouts idempotently via `recovery:fired:*` SETNX. Belt-and-braces against worker outage missing TTL boundaries.
- **Park collision in the wrapper** — placeholder + SETNX correctly preserves the FIRST parked envelope; second caller sees `{parked: false, reason: "collision"}` and the wrapper surfaces `PARK_COLLISION_REFUSAL_PT_BR`. Tests at `park-deferred-intent-nx-hash.test.ts` and `park-deferred-intent-nx.test.ts` verify. **The protection is correct — it just isn't called from production hot paths (Bug 1).**

### Looked at and did not find a bug
- **Restart mid-park scenario (Q12 of the brief):** if the API crashes between adjudicate→DEFER and the park completing, the envelope is lost but the LLM-responder's "intent_registered" optimism is also lost (no audit, no NATS, no Postgres). Customer's next message would re-trigger the LLM and likely re-DEFER. No silent commit because the audit/park is post-adjudicate. The audit-wiring `persistentBufferedSink` does NOT cover park.
- **Sweeper restart mid-sweep (Q13):** the sweeper DELs the parked key AFTER successful NATS publish (`defer-timeout-sweeper.ts:294-297`). A crash between publish and DEL leaves the key in place, and the next sweep sees `recovery:fired:*` SETNX collision → skips. The SETNX dedup is namespaced by intentHash — correctly dedups.
- **TTL expiry vs. legitimate slow resume (Q4):** the framework's `resumeDeferredIntent` returns `{resumed: false, reason: "no_parked_envelope"}` when the GET returns null. The adopter's resolver returns `{kind: "no_park"}`. The wire event is silently dropped; no DLQ. This is "fail-open by design" per the comment — arguably correct, debatable as a policy choice.

---

## Open questions / would need runtime testing

1. **Race window measurement (Bug 2):** statically the race window is up to 60s (`IMMINENT_TTL_SECONDS`), but the actual probability depends on (a) the NATS subscriber's processing latency, (b) the BullMQ worker's tick alignment vs. the framework's park TTL, (c) Redis round-trip latency. A loom/chaos test (random delays between sweeper.GET and sweeper.DEL, fire concurrent resume signal at random offsets) would quantify the rate.
2. **Quota leak rate (Bug 5):** under sustained mid-park throws, how quickly does the per-session counter saturate to quota=16? Depends on the actual Redis client retry behaviour of the node-redis driver pinned in `@ibatexas/tools`. Suspect it's at most 1 leak per failed connect, but tail-latency-induced timeouts on `redis.set` may produce more.
3. **Anonymize double-execution (Bug 2 worst case):** the destructive `anonymizeCustomer(customerId)` is documented as Prisma-idempotent at the model level (anonymize-grace-resolver.ts:34) — but the audit-record emission and any downstream PostHog/analytics events are NOT idempotent. A double-fire would double-count "anonymize" events and emit two LGPD-completion audits. Runtime test: simulate the race with two concurrent `intent.defer.timeout` deliveries; assert exactly one analytics event lands.
4. **NX-wrapper turn-on impact (Bug 1 fix):** if we switch all four hot-path callers to `parkDeferredIntentWithNxGuard`, what is the customer-facing impact when a legitimate second DEFER lands? The wrapper surfaces a refusal — does the responder's current "your DEFER was accepted" optimism need to be reverted to "another operation is already in flight"? Spot-check: the responder's parkQuotaExceeded path (line 492-512) already has the refusal text; the collision refusal needs a parallel branch.
5. **Cross-flow collision (anonymize vs PIX same customer):** verified the patterns differ (anonymize uses `sessionId = customerId`, WhatsApp uses sessionId = WhatsApp session). The collision would require sessionId == customerId — possible in theory if a deploy aligns these, not provable from static analysis. Belt-and-braces argues for using a kind-prefixed park key (`defer:pending:{kind}:{sessionId}`) but that is a larger refactor.
